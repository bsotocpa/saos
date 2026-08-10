// Master + Schedules routes (legal package v3 FINAL), plus the two things v3
// bolted onto them: the §7216 presentation split and the Spanish approval queue.
//
// Staff side: preview what a client's packet would contain, create it, mark it sent.
// Portal side: what schedules still need accepting, accept one, answer a consent.
//
// The Spanish queue lives here rather than in admin/routes because it is part of
// the same rule: v3 says the English text controls and Spanish follows, so a
// translation is not live copy until Brian says it is.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import {
  acceptScheduleInPortal, createPacket, envelopeForPacket, markPacketSent,
  pendingSchedules, previewPacket, type ServiceLine,
} from './packet.ts';
import { consentsToPresent, recordConsentAnswer } from '../compliance/consent-presentation.ts';
import { createAttestAddendum } from './attest-addendum.ts';
import { buildPacketDocument } from './packet-document.ts';
import { makeDocusealAdapter } from '../signatures/docuseal.ts';
import { sendEnvelope } from '../signatures/service.ts';

const SERVICE_LINES = [
  'tax', 'bookkeeping', 'payroll', 'sales_tax', 'advisory',
  'coo', 'entity', 'attest', 'specialized_cpa', 'nonprofit_cfo',
] as const;

const PreviewQuery = z.object({
  /** Services being considered but not yet engaged — the configurator's "what would this paper look like" view. */
  extraServiceLines: z.array(z.enum(SERVICE_LINES)).optional(),
});

export function registerPacketRoutes(app: FastifyInstance): void {
  const docuseal = makeDocusealAdapter(app.config);
  // Papering a client is a commitment act, so it rides the same permission that
  // creates an engagement rather than a new one only Brian would ever hold.
  const write = { preHandler: [app.authenticate, requirePermission('engagements.create')] };
  const read = { preHandler: [app.authenticate, requirePermission('engagements.read')] };
  const admin = { preHandler: [app.authenticate, requirePermission('admin.settings')] };
  const scoped = { preHandler: [app.authenticateClient] };

  // ── Staff: assemble the packet ────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/contacts/:id/packet/preview', read, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = PreviewQuery.parse(request.body ?? {});
    return previewPacket(app, id, b.extraServiceLines ? { extraServiceLines: b.extraServiceLines as ServiceLine[] } : {});
  });

  app.post<{ Params: { id: string } }>('/contacts/:id/packet', write, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = PreviewQuery.parse(request.body ?? {});
    return createPacket(
      app, id, request.staff!,
      b.extraServiceLines ? { extraServiceLines: b.extraServiceLines as ServiceLine[] } : {}
    );
  });

  /**
   * The per-engagement attest Addendum (AU-C 210 / AR-C 90). Without it, packet
   * assembly refuses — Schedule F alone does not agree the terms of an engagement.
   */
  app.post<{ Params: { id: string } }>('/engagements/:id/attest-addendum', write, async (request, reply) => {
    const engagementId = z.uuid().parse(request.params.id);
    const b = z
      .object({
        entityName: z.string().min(2).max(300),
        entityBusinessId: z.uuid().nullish(),
        engagementType: z.enum(['review', 'audit', 'insurance_wc']),
        statementsAndPeriods: z.string().min(4).max(1000),
        reportingFramework: z.string().min(2).max(300),
        feeBasis: z.enum(['fixed', 'hourly']),
        estimatedHours: z.number().positive().max(9999).optional(),
        hourlyItemCode: z.string().min(1).optional(),
        depositItemCode: z.string().min(1),
        expectedReportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(request.body);
    const result = await createAttestAddendum(app, request.staff!, { engagementId, ...b });
    return reply.code(201).send(result);
  });

  /**
   * Send the packet for signature. The envelope is created once and reused, so a
   * failed send can be retried without stranding a second envelope; 'sent' is
   * stamped only after Docuseal accepted it.
   */
  app.post<{ Params: { id: string } }>('/packets/:id/send', write, async (request) => {
    const packetId = z.uuid().parse(request.params.id);
    const b = z.object({ docusealTemplateId: z.string().min(1).optional() }).parse(request.body ?? {});
    const env = await envelopeForPacket(app, packetId, request.staff!, { docusealTemplateId: b.docusealTemplateId });
    const sent = await sendEnvelope(
      app, docuseal, { type: 'staff', id: request.staff!.id, label: request.staff!.email }, env.envelopeId
    );
    await markPacketSent(app, packetId);
    return { packetId, envelopeId: env.envelopeId, envelopeReused: env.reused, ...sent };
  });

  /**
   * The SAOS-generated packet document: Master + only this packet's schedules,
   * variables filled, §7216 consents excluded. Read-only — this is what will be
   * sent for signature once the signing path is chosen, and it is reviewable now.
   */
  app.get<{ Params: { id: string } }>('/packets/:id/document', read, async (request) => {
    const packetId = z.uuid().parse(request.params.id);
    const language = z.object({ language: z.enum(['en', 'es']).optional() })
      .parse(request.query ?? {}).language ?? 'en';
    const doc = await buildPacketDocument(app, packetId, language);
    return {
      packetId: doc.packetId,
      language: doc.language,
      sections: doc.sections.map((s) => ({
        kind: s.kind, code: s.code, title: s.title,
        templateKey: s.templateKey, templateVersion: s.templateVersion,
        characters: s.body.length,
      })),
      deliberatelyExcluded: doc.deliberatelyExcluded,
      html: doc.html,
    };
  });

  app.get<{ Params: { id: string } }>('/contacts/:id/packets', read, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const packets = await app.db.query(
      `SELECT id, master_template_key, master_version, schedule_codes, status,
              sent_at, signed_at, created_at
       FROM engagement_packets WHERE contact_id = $1 ORDER BY created_at DESC`,
      [id]
    );
    const acceptances = await app.db.query(
      `SELECT sa.schedule_code, s.title, sa.via::text AS via, sa.template_version, sa.accepted_at
       FROM schedule_acceptances sa JOIN service_schedules s USING (schedule_code)
       WHERE sa.contact_id = $1 ORDER BY sa.schedule_code`,
      [id]
    );
    return { packets: packets.rows, acceptances: acceptances.rows };
  });

  /** What §7216 consents this client should see, and why each one is or is not offered. */
  app.get<{ Params: { id: string } }>('/contacts/:id/consents/presentation', read, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const atReferralMoment = z
      .object({ atReferralMoment: z.coerce.boolean().optional() })
      .parse(request.query ?? {}).atReferralMoment;
    return consentsToPresent(app, id, atReferralMoment === undefined ? {} : { atReferralMoment });
  });

  // ── Portal: the client's side of Master §1 ────────────────────────────────
  app.get('/portal/schedules', scoped, async (request) => {
    const client = request.client!;
    return pendingSchedules(app, client.contactId);
  });

  app.post<{ Params: { code: string } }>('/portal/schedules/:code/accept', scoped, async (request) => {
    const code = z.string().regex(/^[A-E]$/).parse(request.params.code);
    const client = request.client!;
    const result = await acceptScheduleInPortal(app, client.contactId, code, {
      ip: request.ip, userAgent: request.headers['user-agent'] ?? null,
    });
    return { scheduleCode: code, ...result };
  });

  /** The consents to show this client right now, benefit-framed. */
  app.get('/portal/consents', scoped, async (request) => {
    const client = request.client!;
    const { masterSigned, offers } = await consentsToPresent(app, client.contactId);
    // The portal gets the offers only. The withheld list and its reasons are an
    // internal record — a client has no reason to read why they were not asked.
    return { masterSigned, offers };
  });

  app.post('/portal/consents', scoped, async (request) => {
    const b = z
      .object({ kind: z.enum(['7216_use', '7216_disclose']), granted: z.boolean() })
      .parse(request.body);
    const client = request.client!;

    // A client can only answer a consent they were actually offered. Otherwise a
    // crafted request could record a consent the presentation rules withheld.
    const { offers } = await consentsToPresent(app, client.contactId);
    if (!offers.some((o) => o.kind === b.kind)) {
      throw new AppError(
        409,
        'consent_not_offered',
        'That consent is not currently being requested from you. If you believe it should be, contact us and we will look.'
      );
    }
    return recordConsentAnswer(app, client.contactId, b.kind, b.granted, {
      ip: request.ip, userAgent: request.headers['user-agent'] ?? null,
    });
  });

  // ── Spanish approval queue (v3: "English text controls") ──────────────────
  app.get('/admin/templates/es-queue', admin, async () => {
    const { rows } = await app.db.query(
      `SELECT key, name, kind::text AS kind, schedule_code, channel,
              subject_en, body_en, subject_es, body_es,
              (body_es IS NULL) AS translation_missing, version, updated_at
       FROM templates
       WHERE needs_es_review AND is_active
       ORDER BY CASE kind WHEN 'master' THEN 0 WHEN 'schedule' THEN 1 WHEN 'consent' THEN 2 ELSE 3 END,
                schedule_code NULLS FIRST, key`
    );
    return {
      awaitingApproval: rows,
      note: 'Until each of these is approved, a Spanish-language client receives the English text — which is the text that controls. Nothing is blocked; the Spanish copy simply is not used yet.',
    };
  });

  /** Approve a Spanish translation. The body must exist — there is nothing to approve otherwise. */
  app.post<{ Params: { key: string } }>('/admin/templates/:key/es-approve', admin, async (request) => {
    const key = z.string().min(1).parse(request.params.key);
    const actor = request.staff!;
    const { rows } = await app.db.query<{ body_es: string | null; needs_es_review: boolean }>(
      `SELECT body_es, needs_es_review FROM templates WHERE key = $1`,
      [key]
    );
    const t = rows[0];
    if (!t) throw new AppError(404, 'not_found', 'Template not found.');
    if (t.body_es === null) {
      throw new AppError(
        400,
        'no_translation',
        'There is no Spanish body on this template yet. Enter the translation first, then approve it.'
      );
    }
    if (!t.needs_es_review) return { status: 'already_approved' };

    await app.db.query(
      `UPDATE templates
       SET needs_es_review = false, es_approved_by_staff_id = $2, es_approved_at = now()
       WHERE key = $1`,
      [key, actor.id]
    );
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
      action: 'template.es_approved', objectType: 'template', objectId: key,
    });
    return { status: 'approved' };
  });
}
