// Public form API (autosave per screen — mobile users get interrupted; resume
// via token link), submit processing, Form 4 portal checklist, Form 5 service
// onboarding, and form analytics (OF Build Notes).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { generateToken, hashToken } from '../../crypto.ts';
import { AppError } from '../../types.ts';
import {
  assembleModules,
  loadDefinition,
  processHiloIntake,
  processServiceOnboarding,
  processSotoIntake,
  sanitizeAnswers,
  validateSubmission,
} from './service.ts';
import { runSosRecheckJob } from '../entity/sos.ts';
import { todayChicago } from '../tax/deadlines.ts';

const StartBody = z.object({
  language: z.enum(['en', 'es']).default('en'),
  source: z.enum(['public', 'hilo_link', 'portal']).default('public'),
});

const SaveBody = z.object({
  resumeToken: z.string().min(1),
  answers: z.record(z.string(), z.unknown()),
  screenReached: z.number().int().min(0).max(20).optional(),
});

const SubmitBody = z.object({
  resumeToken: z.string().min(1),
  answers: z.record(z.string(), z.unknown()),
});

const PUBLIC_FORMS = new Set(['soto_intake', 'hilo_intake']);
const ONBOARDING_STEPS = ['confirm_info', 'sign_docs', 'upload_prior_return', 'book_consult'] as const;

async function loadSubmission(app: FastifyInstance, id: string, resumeToken: string) {
  const { rows } = await app.db.query<{ id: string; form_key: string; status: string; answers: Record<string, unknown> }>(
    `SELECT id, form_key, status, answers FROM form_submissions WHERE id = $1 AND resume_token_hash = $2`,
    [id, hashToken(resumeToken)]
  );
  if (!rows[0]) throw new AppError(404, 'not_found', 'Submission not found.');
  if (rows[0].status === 'submitted') throw new AppError(409, 'already_submitted', 'This form was already submitted.');
  return rows[0];
}

export function registerFormRoutes(app: FastifyInstance): void {
  // ── Public: definition + start + autosave + submit ────────────────────────
  app.get<{ Params: { key: string } }>('/public/forms/:key', async (request) => {
    const key = z.string().parse(request.params.key);
    if (!PUBLIC_FORMS.has(key)) throw new AppError(404, 'form_not_found', 'Form not found.');
    const def = await loadDefinition(app, key);
    // REHEARSAL BANNER (Brian's dress rehearsal, 2026-08-09). The intake collects
    // §7216 consent, and that consent text is still placeholder. The send path
    // already refuses to SEND a placeholder template in every environment, but a
    // form that COLLECTS consent needs to say out loud that the consent it is
    // collecting is not legally effective yet.
    //
    // It keys off the template flag rather than a setting, so the banner
    // disappears by itself the moment Brian clears the placeholder flags — there
    // is nothing to remember to switch off, which is exactly what you want from a
    // warning that must not outlive its reason.
    const consent = await app.db.query<{ pending: number }>(
      `SELECT count(*)::int AS pending FROM templates
       WHERE key IN ('consent_7216_use', 'consent_7216_disclose') AND is_placeholder`
    );
    const consentTextPending = (consent.rows[0]?.pending ?? 0) > 0;
    return {
      key,
      version: def.version,
      definition: def.definition,
      consentTextPending,
      rehearsalBannerEn: consentTextPending
        ? 'REHEARSAL — the consent language on this form is placeholder text and is NOT legally effective. Do not use this form with a real client.'
        : null,
      rehearsalBannerEs: consentTextPending
        ? 'ENSAYO — el texto de consentimiento de este formulario es provisional y NO tiene efecto legal. No use este formulario con un cliente real.'
        : null,
    };
  });

  app.post<{ Params: { key: string } }>('/public/forms/:key/start', async (request, reply) => {
    const key = z.string().parse(request.params.key);
    if (!PUBLIC_FORMS.has(key)) throw new AppError(404, 'form_not_found', 'Form not found.');
    const b = StartBody.parse(request.body ?? {});
    const def = await loadDefinition(app, key);
    const { token, hash } = generateToken();
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO form_submissions (form_key, form_version, language, source, resume_token_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [key, def.version, b.language, b.source, hash]
    );
    await app.db.query(`INSERT INTO form_events (form_key, submission_id, event) VALUES ($1, $2, 'started')`, [
      key,
      rows[0]!.id,
    ]);
    return reply.code(201).send({ submissionId: rows[0]!.id, resumeToken: token });
  });

  app.patch<{ Params: { id: string } }>('/public/forms/submissions/:id', async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = SaveBody.parse(request.body);
    const sub = await loadSubmission(app, id, b.resumeToken);
    const merged = { ...sub.answers, ...sanitizeAnswers(b.answers) };
    await app.db.query(
      `UPDATE form_submissions SET answers = $2::jsonb, screen_reached = GREATEST(screen_reached, $3) WHERE id = $1`,
      [id, JSON.stringify(merged), b.screenReached ?? 0]
    );
    if (b.screenReached) {
      await app.db.query(
        `INSERT INTO form_events (form_key, submission_id, event, screen) VALUES ($1, $2, 'screen_completed', $3)`,
        [sub.form_key, id, b.screenReached]
      );
    }
    return { status: 'ok' };
  });

  app.post<{ Params: { id: string } }>('/public/forms/submissions/:id/submit', async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = SubmitBody.parse(request.body);
    const sub = await loadSubmission(app, id, b.resumeToken);
    const def = await loadDefinition(app, sub.form_key);
    const answers = { ...sub.answers, ...sanitizeAnswers(b.answers) };

    const issues = validateSubmission(def.definition, answers);
    if (issues.length > 0) {
      throw Object.assign(new AppError(400, 'form_validation_failed', 'Some required answers are missing or invalid.'), {
        issues,
      });
    }

    const result =
      sub.form_key === 'soto_intake'
        ? await processSotoIntake(app, id, answers)
        : await processHiloIntake(app, id, answers);

    await app.db.query(
      `UPDATE form_submissions SET answers = $2::jsonb, status = 'submitted', submitted_at = now(), contact_id = $3 WHERE id = $1`,
      [id, JSON.stringify(answers), result.contactId]
    );
    await app.db.query(`INSERT INTO form_events (form_key, submission_id, event) VALUES ($1, $2, 'submitted')`, [
      sub.form_key,
      id,
    ]);
    return { status: 'submitted' };
  });

  // ── Form 4: portal first-login checklist ─────────────────────────────────
  app.get('/portal/onboarding', { preHandler: [app.authenticateClient] }, async (request) => {
    const client = request.client!;
    const { rows } = await app.db.query(
      `SELECT variant, step_confirm_info_at, step_sign_docs_at, step_upload_prior_return_at,
              step_book_consult_at, completed_at
       FROM portal_onboarding WHERE contact_id = $1`,
      [client.contactId]
    );
    const pendingEnvelopes = await app.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM signature_envelopes
       WHERE contact_id = $1 AND status NOT IN ('completed', 'voided', 'declined')`,
      [client.contactId]
    );
    return { onboarding: rows[0] ?? null, pendingSignatures: pendingEnvelopes.rows[0]!.n };
  });

  app.post<{ Params: { step: string } }>(
    '/portal/onboarding/steps/:step/complete',
    { preHandler: [app.authenticateClient] },
    async (request) => {
      const step = z.enum(ONBOARDING_STEPS).parse(request.params.step);
      const client = request.client!;
      await app.db.query(
        `INSERT INTO portal_onboarding (contact_id) VALUES ($1) ON CONFLICT (contact_id) DO NOTHING`,
        [client.contactId]
      );
      await app.db.query(
        `UPDATE portal_onboarding SET step_${step}_at = COALESCE(step_${step}_at, now()) WHERE contact_id = $1`,
        [client.contactId]
      );
      await app.db.query(
        `UPDATE portal_onboarding SET completed_at = now()
         WHERE contact_id = $1 AND completed_at IS NULL
           AND step_confirm_info_at IS NOT NULL AND step_sign_docs_at IS NOT NULL
           AND step_upload_prior_return_at IS NOT NULL AND step_book_consult_at IS NOT NULL`,
        [client.contactId]
      );
      return { status: 'ok' };
    }
  );

  // ── Form 5: assembled service onboarding (client-facing) ─────────────────
  app.get('/portal/service-onboarding', { preHandler: [app.authenticateClient] }, async (request) => {
    const client = request.client!;
    const modules = await assembleModules(app, client.contactId);
    return {
      modules: modules.map((m) => ({ key: m.key, nameEn: m.name_en, nameEs: m.name_es, questions: m.questions })),
    };
  });

  app.post('/portal/service-onboarding/submit', { preHandler: [app.authenticateClient] }, async (request) => {
    const client = request.client!;
    const b = z.object({ answers: z.record(z.string(), z.unknown()) }).parse(request.body);
    const answers = sanitizeAnswers(b.answers);
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO form_submissions (form_key, form_version, contact_id, status, language, answers, submitted_at)
       VALUES ('service_onboarding', 1, $1, 'submitted', $2, $3::jsonb, now()) RETURNING id`,
      [client.contactId, client.language, JSON.stringify(answers)]
    );
    const result = await processServiceOnboarding(app, client.contactId, answers);
    return { status: 'submitted', submissionId: rows[0]!.id, flags: result.flags };
  });

  // ── Analytics (OF Build Notes: started / completed / drop-off per form) ──
  app.get('/forms/analytics', { preHandler: [app.authenticate, requirePermission('contacts.read')] }, async () => {
    const { rows } = await app.db.query(
      `SELECT form_key,
              count(*) FILTER (WHERE event = 'started')::int AS started,
              count(*) FILTER (WHERE event = 'submitted')::int AS submitted
       FROM form_events GROUP BY form_key ORDER BY form_key`
    );
    const dropOff = await app.db.query(
      `SELECT form_key, screen_reached, count(*)::int AS abandoned
       FROM form_submissions
       WHERE status = 'in_progress'
       GROUP BY form_key, screen_reached ORDER BY form_key, screen_reached`
    );
    return { forms: rows, dropOff: dropOff.rows };
  });

  app.post('/jobs/sos-recheck', { preHandler: [app.authenticate, requirePermission('jobs.run')] }, async (request) => {
    const q = z.object({ asOf: z.iso.date().optional() }).parse(request.query);
    return runSosRecheckJob(app, q.asOf ?? todayChicago());
  });
}
