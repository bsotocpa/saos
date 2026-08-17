// Public form API (autosave per screen — mobile users get interrupted; resume
// via token link), submit processing, Form 4 portal checklist, Form 5 service
// onboarding, and form analytics (OF Build Notes).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { generateToken, hashToken } from '../../crypto.ts';
import { AppError } from '../../types.ts';
import { writeAudit } from '../../audit.ts';
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
import { currentTaxYear } from '../tax/resolution.ts';
import { prefillBookingUrl } from './booking-link.ts';
import { consentsToPresent } from '../compliance/consent-presentation.ts';

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

const ResumeBody = z.object({ resumeToken: z.string().min(1) });

const PUBLIC_FORMS = new Set(['soto_intake', 'hilo_intake']);
/*
 * The steps a client can tick BY HAND. Everything else on the canonical journey
 * completes itself from something the system already knows — the deposit from the
 * invoice, consent from the answer, the questionnaire from the submission, booking from
 * the scheduler — because asking a client to confirm what we can already see is how a
 * checklist starts lying.
 *
 * `track_services` left this list on 2026-08-16 (Brian, #35): its whole content was
 * "look at the services below", and #35 makes that the home page. A step whose
 * instruction is "read the rest of this screen" is not a step. Its column stays, holding
 * the dates of clients who really did tick it.
 */
const ONBOARDING_STEPS = ['sign_docs', 'upload_documents'] as const;

/*
 * Resolve {{tax_year}} in question text when the form is SERVED (#29).
 *
 * Brian's ruling was to name the year rather than say "last year", because relative
 * labels rot in January — but a year typed into the stored definition rots the same way,
 * just more quietly: it is simply wrong the following season and nothing complains. So
 * the definition carries a token and the answer is derived per request from
 * currentTaxYear(), which is the same function the filing lane and resolution engine use.
 *
 * Kept to the label fields, and applied to a copy: the stored definition is never
 * rewritten, so the token survives for next year and Brian can still edit the sentence
 * around it without a deploy.
 */
function withTaxYear<T>(definition: T): T {
  const year = String(currentTaxYear());
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return node.replaceAll('{{tax_year}}', year);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    }
    return node;
  };
  return walk(definition) as T;
}

/*
 * DROP ANSWERS TO QUESTIONS THAT ARE NOT BEING ASKED (#37, shared by submit and revise).
 *
 * A client picks "Other", types what it is, then changes their mind — the companion
 * disappears from the screen but its answer is still in the payload. Keeping it would
 * leave "a bespoke ledger my cousin wrote" sitting beside "QuickBooks Online", which is
 * worse than no answer because it reads like one.
 *
 * Shared rather than duplicated, because a revision that kept stale answers while a
 * submission stripped them would be the two paths disagreeing about the same record.
 */
function dropUnaskedAnswers(
  answers: Record<string, unknown>,
  modules: Array<{ questions: unknown }>
): Record<string, unknown> {
  const conditional = modules
    .flatMap((m) => m.questions as Array<{ id: string; showWhen?: { question: string; equals?: unknown; includesAny?: string[] } }>)
    .filter((q) => q.showWhen);
  let out = { ...answers };
  for (const q of conditional) {
    const c = q.showWhen!;
    const parent = out[c.question];
    const shown = c.includesAny
      ? Array.isArray(parent) && c.includesAny.some((x) => (parent as string[]).includes(x))
      : c.equals !== undefined
        ? parent === c.equals
        : true;
    if (!shown && q.id in out) {
      const { [q.id]: _dropped, ...rest } = out;
      out = rest;
    }
  }
  return out;
}

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
      definition: withTaxYear(def.definition),
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

  /*
   * RESUME an in-progress submission (2026-08-15).
   *
   * Autosave has worked since M28 — every screen PATCHes its answers — but nothing could
   * ever read them back, so the save was write-only and the renderer started a brand new
   * submission on every page load. A client who backgrounded the form on a phone lost the
   * lot, which is the opposite of what the autosave was built for.
   *
   * POST, not GET, so the resume token stays out of access logs and browser history.
   * `loadSubmission` is the only gate needed: wrong token → 404, already submitted → 409,
   * both of which the client treats as "start fresh".
   */
  app.post<{ Params: { id: string } }>('/public/forms/submissions/:id/resume', async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = ResumeBody.parse(request.body);
    const sub = await loadSubmission(app, id, b.resumeToken);
    const { rows } = await app.db.query<{ screen_reached: number }>(
      `SELECT screen_reached FROM form_submissions WHERE id = $1`,
      [id]
    );
    return {
      formKey: sub.form_key,
      answers: sub.answers,
      screenReached: rows[0]?.screen_reached ?? 0,
    };
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
      `SELECT variant, step_sign_docs_at, step_pay_deposit_at, step_consent_at, step_confirm_info_at,
              step_questionnaire_at, step_upload_documents_at, step_track_services_at,
              step_book_consult_at, completed_at
       FROM portal_onboarding WHERE contact_id = $1`,
      [client.contactId]
    );
    const pendingEnvelopes = await app.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM signature_envelopes
       WHERE contact_id = $1 AND status NOT IN ('completed', 'voided', 'declined')`,
      [client.contactId]
    );
    // FINDING #9: checklist step 4 ("Book your consultation") pointed at /estimate,
    // sending clients to the wrong page, because no portal booking flow exists yet.
    // The link is a SETTING: null means scheduling is not open and the portal says so
    // rather than misrouting; setting it makes step 4 a real link with no deploy.
    const bookingUrl = await app.db.query<{ value: string | null }>(
      `SELECT value #>> '{}' AS value FROM app_settings WHERE key = 'booking.client_booking_url'`
    );
    // An authenticated client should not retype their own name and email into the
    // booking page — we know who they are. Prefill happens HERE rather than in the
    // portal so the identity comes from the session, not from the browser.
    const identity = await app.db.query<{ name: string | null; email: string | null }>(
      `SELECT nullif(trim(concat_ws(' ', first_name, last_name)), '') AS name, email
       FROM contacts WHERE id = $1`,
      [client.contactId]
    );
    const rawBookingUrl = bookingUrl.rows[0]?.value ?? null;

    /*
     * PAY DEPOSIT completes itself.
     *
     * The client cannot tick this step and should not have to: the system already knows
     * whether the deposit invoice is paid. Asking someone to confirm something we can
     * see is how a checklist starts lying — and during the rehearsal the deposit was
     * genuinely paid while the checklist would have shown it outstanding.
     *
     * Written back to the column rather than computed on the fly so the completion has
     * a DATE, the same as every other step.
     */
    const deposit = await app.db.query<{ paid: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM invoices i
          JOIN quotes q ON q.deposit_invoice_id = i.id
         WHERE q.contact_id = $1 AND i.status = 'paid'
       ) AS paid`,
      [client.contactId]
    );
    if (deposit.rows[0]!.paid) {
      await app.db.query(
        `UPDATE portal_onboarding
            SET step_pay_deposit_at = COALESCE(step_pay_deposit_at, now())
          WHERE contact_id = $1 AND step_pay_deposit_at IS NULL`,
        [client.contactId]
      );
      if (rows[0]) (rows[0] as Record<string, unknown>).step_pay_deposit_at = new Date().toISOString();
    }

    // Whether a deposit is even owed — a client with none should not stare at a step
    // they can never complete.
    const depositOwed = await app.db.query<{ owed: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM quotes q WHERE q.contact_id = $1 AND q.deposit_invoice_id IS NOT NULL
       ) AS owed`,
      [client.contactId]
    );

    /*
     * The questionnaire now applies to EVERY client (#27, 2026-08-16).
     *
     * It used to depend on a module firing, because the modules were all it contained.
     * Its first screen is now the client's own details, prefilled from what we hold and
     * theirs to correct — and every client has details. That is what let "Confirm your
     * information" go: a step whose whole job was already being done one screen later.
     *
     * Kept as a named constant rather than dropping the field, because the portal reads
     * it and a silently-missing flag reads as false — which would hide the step from
     * everyone.
     */
    const questionnaireApplies = true;

    /*
     * §7216 CONSENT — step 3, self-completing (finding #34).
     *
     * `consentsToPresent` is the authority on both halves: it withholds everything
     * until the Master is signed, so the step cannot appear too early, and it treats
     * signed AND declined as answered, so it stops offering once the client responds.
     *
     * The step stamps on ANSWER, not on consent. A step that only completed when the
     * client said yes would make finishing their setup depend on consenting, which is
     * the conditioning §7216 forbids.
     */
    const consentState = await consentsToPresent(app, client.contactId);
    const consentAnswered = await app.db.query<{ answered_at: Date | null }>(
      `SELECT min(COALESCE(signed_at, revoked_at, created_at)) AS answered_at
         FROM consents
        WHERE contact_id = $1 AND type IN ('7216_use', '7216_disclose')
          AND status IN ('signed', 'declined')`,
      [client.contactId]
    );
    const answeredAt = consentAnswered.rows[0]?.answered_at ?? null;
    if (answeredAt) {
      await app.db.query(
        `UPDATE portal_onboarding SET step_consent_at = COALESCE(step_consent_at, $2)
          WHERE contact_id = $1 AND step_consent_at IS NULL`,
        [client.contactId, answeredAt]
      );
      if (rows[0]) (rows[0] as Record<string, unknown>).step_consent_at = answeredAt;
    }
    // It applies once the Master is signed and there is either something to answer or
    // something already answered. Before that it is withheld, and showing it would put
    // a consent question beside the document they must sign to be served.
    const consentApplies = consentState.masterSigned && (consentState.offers.length > 0 || answeredAt !== null);

    const settings = await app.db.query<{ key: string; value: string | null }>(
      `SELECT key, value #>> '{}' AS value FROM app_settings
        WHERE key IN ('booking.support_booking_url', 'payments.irs_url', 'payments.state_url')`
    );
    const byKey = Object.fromEntries(settings.rows.map((r) => [r.key, r.value]));

    /*
     * Re-evaluate completion on every load, not only when a step is ticked.
     *
     * Self-completing steps do not tick anything, so completion used to depend on the
     * client having some OTHER step left to press — and when the last outstanding step
     * was one of the automatic ones, nothing re-checked. Worse, a RULE change can make
     * someone newly eligible: dropping track_services on 2026-08-16 left clients who had
     * finished everything else with completed_at still null, and no action of theirs
     * would ever have re-examined it. They would have stared at a checklist with every
     * box ticked instead of seeing their home page.
     *
     * It is a cheap idempotent UPDATE guarded on completed_at IS NULL, so a client whose
     * checklist is already finished pays one no-op write.
     */
    await refreshChecklistCompletion(client.contactId);
    const completed = await app.db.query<{ completed_at: Date | null }>(
      `SELECT completed_at FROM portal_onboarding WHERE contact_id = $1`,
      [client.contactId]
    );
    if (rows[0] && completed.rows[0]?.completed_at) {
      (rows[0] as Record<string, unknown>).completed_at = completed.rows[0].completed_at;
    }
    const identityRow = identity.rows[0] ?? { name: null, email: null };

    return {
      onboarding: rows[0] ?? null,
      pendingSignatures: pendingEnvelopes.rows[0]!.n,
      /*
       * Named for the conversation it opens (#39). This is the ONBOARDING CONSULTATION —
       * checklist step 6 and nothing else. The post-onboarding "book a meeting" is
       * supportBookingUrl below, because a client who has finished onboarding does not
       * need a second kickoff.
       */
      kickoffBookingUrl: rawBookingUrl ? prefillBookingUrl(rawBookingUrl, identityRow) : null,
      depositApplies: depositOwed.rows[0]!.owed,
      questionnaireApplies,
      consentApplies,
      // Step 6 is optional and only shown where booking is actually open — the URL is
      // a setting, and null means scheduling is not available rather than broken.
      bookingApplies: rawBookingUrl !== null,
      // "Schedule a Call/Meeting" (Quick actions) and the estimated-payment links.
      supportBookingUrl: byKey['booking.support_booking_url']
        ? prefillBookingUrl(byKey['booking.support_booking_url']!, identityRow)
        : null,
      irsPaymentUrl: byKey['payments.irs_url'] ?? null,
      statePaymentUrl: byKey['payments.state_url'] ?? null,
    };
  });

  /*
   * The checklist is finished when every step the CLIENT can see is done.
   *
   * Conditional steps are the whole difficulty. A client never asked for a deposit must
   * not be held at 4/5 forever by a step that cannot apply to them, and the same is now
   * true of the questionnaire: it assembles from their engagements and industry, so a
   * client whose service lines fire no modules has nothing to answer. `book_consult` is
   * deliberately absent — it is retired, and leaving it in this condition would have
   * meant no client could ever finish onboarding again.
   *
   * EXTRACTED (2026-08-15) because it used to live only in the manual step-tick route,
   * and self-completing steps do not tick anything. The deposit already had this
   * problem latently — a client whose last remaining step was the deposit would have
   * had it filled in by the dashboard GET while `completed_at` stayed null, because
   * nothing re-evaluated completion afterwards. The questionnaire would have made that
   * reachable in the ordinary case, so every path that can finish a step calls this.
   */
  async function refreshChecklistCompletion(contactId: string): Promise<void> {
    const questionnaireApplies = (await assembleModules(app, contactId)).length > 0;

    /*
     * THE DEPOSIT NO LONGER GATES COMPLETION (Brian, 2026-08-16). It is collected at
     * quote acceptance, before the portal journey begins, so it is not a step the client
     * sees here — and completion means "every step the client can see is done". The
     * column still fills in, because when the deposit was paid is real history.
     *
     * §7216 consent DOES gate it, but only where it applies: before the Master is
     * signed every offer is withheld, and a client with nothing to answer must not be
     * held open by it. Answered means signed OR declined.
     *
     * Booking is absent on purpose — the ruling made it optional and completable at any
     * time, so it must never hold the checklist open.
     */
    const consentState = await consentsToPresent(app, contactId);
    const answered = await app.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM consents
        WHERE contact_id = $1 AND type IN ('7216_use', '7216_disclose')
          AND status IN ('signed', 'declined')`,
      [contactId]
    );
    const consentApplies = consentState.masterSigned && (consentState.offers.length > 0 || (answered.rows[0]?.n ?? 0) > 0);

    await app.db.query(
      `UPDATE portal_onboarding o SET completed_at = now()
        WHERE o.contact_id = $1 AND o.completed_at IS NULL
          AND o.step_sign_docs_at IS NOT NULL
          AND o.step_upload_documents_at IS NOT NULL
          AND ($2 = false OR o.step_questionnaire_at IS NOT NULL)
          AND ($3 = false OR o.step_consent_at IS NOT NULL)`,
      [contactId, questionnaireApplies, consentApplies]
    );
  }

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
      await refreshChecklistCompletion(client.contactId);
      return { status: 'ok' };
    }
  );

  // ── Form 5: assembled service onboarding (client-facing) ─────────────────
  //
  // Step 4 of the canonical journey (Brian, 2026-08-15). The #30/#31 ruling split
  // intake: the pre-engagement form stays minimal and creates the contact, and THESE
  // questions — assembled per client from the A–I modules — are the onboarding-voice
  // instrument. They can only exist here, because assembleModules triggers on the
  // client's engagements and industry, neither of which exists before the engagement.

  /*
   * WHAT WE ALREADY HOLD, for the questionnaire's first screen (#27).
   *
   * Brian's ruling: prefill ONLY for an authenticated portal session — the
   * unauthenticated pre-engagement form prefills nothing, ever. That is the whole
   * privacy argument for this shape. A public form is resumable by anyone holding its
   * link, so prefilling it would turn that link into a disclosure of data the client
   * never typed there. Behind a portal session there is no new exposure: this is the
   * same data the client can already read on /profile.
   *
   * EMAIL IS DELIBERATELY ABSENT from what can be changed. It is the login identity, and
   * the profile endpoint has never accepted it — a client who needs it changed should be
   * talking to a person, not editing a field mid-questionnaire.
   */
  async function heldIdentity(contactId: string) {
    const { rows } = await app.db.query(
      `SELECT first_name, last_name, email, phone, secondary_phone,
              preferred_contact_method::text AS preferred_contact_method, language,
              address_line1, address_line2, city, state, zip
         FROM contacts WHERE id = $1`,
      [contactId]
    );
    return rows[0] ?? null;
  }

  /** The one place that decides what this client's questionnaire is. */
  async function questionnaireFor(contactId: string) {
    const modules = await assembleModules(app, contactId);
    const draft = await app.db.query<{ id: string; answers: Record<string, unknown>; screen_reached: number }>(
      `SELECT id, answers, screen_reached FROM form_submissions
        WHERE form_key = 'service_onboarding' AND contact_id = $1 AND status <> 'submitted'
        ORDER BY created_at DESC LIMIT 1`,
      [contactId]
    );
    /*
     * A SUBMITTED questionnaire returns its ANSWERS too (#45).
     *
     * It used to return only the date, so the portal could say "thank you" and nothing
     * else — no way back in, no way to see what you had said. A client who mistyped their
     * revenue or forgot a state had to contact us, which is the failure #35 exists to
     * remove: a thing the client reached out about that the portal should have handled.
     */
    const done = await app.db.query<{ id: string; submitted_at: Date | null; answers: Record<string, unknown> }>(
      `SELECT id, submitted_at, answers FROM form_submissions
        WHERE form_key = 'service_onboarding' AND contact_id = $1 AND status = 'submitted'
        ORDER BY submitted_at LIMIT 1`,
      [contactId]
    );
    return {
      modules,
      draft: draft.rows[0] ?? null,
      submittedAt: done.rows[0]?.submitted_at ?? null,
      submitted: done.rows[0] ?? null,
    };
  }

  app.get('/portal/service-onboarding', { preHandler: [app.authenticateClient] }, async (request) => {
    const client = request.client!;
    const { modules, draft, submittedAt, submitted } = await questionnaireFor(client.contactId);
    return {
      modules: modules.map((m) => ({ key: m.key, nameEn: m.name_en, nameEs: m.name_es, questions: m.questions })),
      /*
       * The details we hold, for the first screen (#27). This is why the questionnaire
       * now applies to EVERY client rather than only those whose services fire a module:
       * confirming your own details is the one thing every client has to do, and it used
       * to be its own checklist step ("Confirm your information") pointing at a separate
       * page. Brian's ruling: with prefilled identity fields the client can correct, that
       * step is duplicate work — so it lives here and the step is gone.
       */
      contact: await heldIdentity(client.contactId),
      /*
       * Answers survive a lost signal, the same as the intake — a client working through
       * nine modules on a phone must not lose the lot to a backgrounded tab. And once
       * submitted, the ANSWERS come back too, so the questionnaire can be reviewed and
       * corrected rather than being a one-way door (#45).
       */
      answers: submitted?.answers ?? draft?.answers ?? {},
      screenReached: draft?.screen_reached ?? 0,
      submittedAt,
    };
  });

  /*
   * REVISE A COMPLETED QUESTIONNAIRE (#45).
   *
   * Deliberately not a second submission. Brian's ruling: edits after completion re-run
   * whatever derives from the answers and audit as a REVISION, and the checklist step
   * stays complete — the client already did the thing the step is about, and un-ticking it
   * because they fixed a typo would be punishing them for correcting the record.
   *
   * `submitted_at` is left alone for the same reason: it records when they answered, not
   * when they last touched it. The audit row carries the revision history.
   */
  app.post('/portal/service-onboarding/revise', { preHandler: [app.authenticateClient] }, async (request) => {
    const client = request.client!;
    const b = z.object({ answers: z.record(z.string(), z.unknown()) }).parse(request.body);

    const { submitted, modules } = await questionnaireFor(client.contactId);
    if (!submitted) {
      throw new AppError(409, 'not_submitted', 'There is nothing to revise yet — this questionnaire has not been submitted.');
    }

    const merged = { ...submitted.answers, ...sanitizeAnswers(b.answers) };
    const answers = dropUnaskedAnswers(merged, modules);

    await app.db.query(`UPDATE form_submissions SET answers = $2::jsonb WHERE id = $1`, [
      submitted.id,
      JSON.stringify(answers),
    ]);

    // Re-run what derives from the answers: module flags, the PLLC rule, complexity.
    const result = await processServiceOnboarding(app, client.contactId, answers);

    await writeAudit(app.db, {
      actorType: 'client', actorId: client.portalUserId, actorLabel: client.email,
      action: 'service_onboarding.revised', objectType: 'form_submission', objectId: submitted.id,
      contactId: client.contactId, ip: request.ip,
      details: { changed: Object.keys(sanitizeAnswers(b.answers)), flags: result.flags },
    });

    return { status: 'revised', flags: result.flags };
  });

  /** Autosave. Idempotent per client: one open draft, updated in place. */
  app.patch('/portal/service-onboarding', { preHandler: [app.authenticateClient] }, async (request) => {
    const client = request.client!;
    const b = z
      .object({
        answers: z.record(z.string(), z.unknown()),
        screenReached: z.number().int().min(0).max(50).optional(),
      })
      .parse(request.body);
    const answers = sanitizeAnswers(b.answers);

    const existing = await app.db.query<{ id: string; answers: Record<string, unknown> }>(
      `SELECT id, answers FROM form_submissions
        WHERE form_key = 'service_onboarding' AND contact_id = $1 AND status <> 'submitted'
        ORDER BY created_at DESC LIMIT 1`,
      [client.contactId]
    );
    if (existing.rows[0]) {
      const merged = { ...existing.rows[0].answers, ...answers };
      await app.db.query(
        `UPDATE form_submissions
            SET answers = $2::jsonb, screen_reached = GREATEST(screen_reached, $3)
          WHERE id = $1`,
        [existing.rows[0].id, JSON.stringify(merged), b.screenReached ?? 0]
      );
    } else {
      await app.db.query(
        `INSERT INTO form_submissions (form_key, form_version, contact_id, status, language, answers, screen_reached)
         VALUES ('service_onboarding', 1, $1, 'in_progress', $2, $3::jsonb, $4)`,
        [client.contactId, client.language, JSON.stringify(answers), b.screenReached ?? 0]
      );
    }
    return { status: 'ok' };
  });

  app.post('/portal/service-onboarding/submit', { preHandler: [app.authenticateClient] }, async (request) => {
    const client = request.client!;
    const b = z.object({ answers: z.record(z.string(), z.unknown()) }).parse(request.body);

    // The draft is part of the answer. A client who filled modules A–C over two
    // sittings and only has D–F in the browser must not submit D–F alone.
    const open = await app.db.query<{ id: string; answers: Record<string, unknown> }>(
      `SELECT id, answers FROM form_submissions
        WHERE form_key = 'service_onboarding' AND contact_id = $1 AND status <> 'submitted'
        ORDER BY created_at DESC LIMIT 1`,
      [client.contactId]
    );
    let answers = { ...(open.rows[0]?.answers ?? {}), ...sanitizeAnswers(b.answers) };

    const modules = await assembleModules(app, client.contactId);
    answers = dropUnaskedAnswers(answers, modules);

    let submissionId: string;
    if (open.rows[0]) {
      await app.db.query(
        `UPDATE form_submissions SET answers = $2::jsonb, status = 'submitted', submitted_at = now() WHERE id = $1`,
        [open.rows[0].id, JSON.stringify(answers)]
      );
      submissionId = open.rows[0].id;
    } else {
      const { rows } = await app.db.query<{ id: string }>(
        `INSERT INTO form_submissions (form_key, form_version, contact_id, status, language, answers, submitted_at)
         VALUES ('service_onboarding', 1, $1, 'submitted', $2, $3::jsonb, now()) RETURNING id`,
        [client.contactId, client.language, JSON.stringify(answers)]
      );
      submissionId = rows[0]!.id;
    }

    const result = await processServiceOnboarding(app, client.contactId, answers);

    // Self-completing, like the deposit: a client cannot mark a questionnaire done
    // without answering it, so submitting IS the completion. COALESCE keeps the first
    // date if they ever submit twice.
    await app.db.query(
      `INSERT INTO portal_onboarding (contact_id) VALUES ($1) ON CONFLICT (contact_id) DO NOTHING`,
      [client.contactId]
    );
    await app.db.query(
      `UPDATE portal_onboarding SET step_questionnaire_at = COALESCE(step_questionnaire_at, now())
        WHERE contact_id = $1`,
      [client.contactId]
    );
    await refreshChecklistCompletion(client.contactId);

    return { status: 'submitted', submissionId, flags: result.flags };
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
