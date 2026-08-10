// Tax engagement module (MP Tax Operations): creation, pipeline transitions,
// estimate lock, final fee + scope-creep enforcement, complexity scoring, and
// the wet-signature path (in-office ~10%; the Docuseal remote path lands in
// M11 and sets the same timestamps).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../audit.ts';
import { requirePermission } from '../../plugins/auth.ts';
import { AppError } from '../../types.ts';
import { createEngagement } from '../engagements/service.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { computeComplexityScore } from './complexity.ts';
import { TAX_STAGES, markDocumentsRequested, recordEfileResult, transitionStage } from './pipeline.ts';
import { preparerQueue } from './queue.ts';
import { todayChicago } from './deadlines.ts';

const CreateBody = z.object({
  contactId: z.uuid(),
  businessId: z.uuid().optional(),
  taxYear: z.number().int().min(2000).max(2100),
  // v4.3 authoritative table coverage (M24): estate/trust, both 1120-F
  // variants, expat 1040, and FBAR join the original set.
  returnType: z.enum([
    '1040', '1065', '1120s', '1120', '990', '990ez', '1120c', '1120f', '1120h', '1120pol', 'w7_itin',
    '1041', '1120f_foreign', '1040_expat', 'fbar',
  ]),
  clientType: z.enum(['individual', 'business', 'nonprofit']).optional(),
  preparerId: z.uuid().optional(),
  reviewerId: z.uuid().optional(),
  title: z.string().optional(),
});

const TransitionBody = z.object({
  toStage: z.enum(TAX_STAGES),
  note: z.string().optional(),
});

const EstimateBody = z.object({
  minCents: z.number().int().nonnegative(),
  maxCents: z.number().int().nonnegative(),
}).refine((b) => b.maxCents >= b.minCents, { message: 'maxCents must be >= minCents.' });

const FinalFeeBody = z.object({
  finalFeeCents: z.number().int().nonnegative(),
  discountCents: z.number().int().nonnegative().optional(),
  scopeCreepReason: z
    .enum(['additional_states', 'additional_sch_c', 'additional_sch_e', 'foreign', 'late_docs', 'prior_year_cleanup', 'irs_notice', 'other'])
    .optional(),
  scopeCreepDescription: z.string().optional(),
});

const ComplexityBody = z.object({
  schC: z.number().int().nonnegative().optional(),
  schEProperties: z.number().int().nonnegative().optional(),
  k1s: z.number().int().nonnegative().optional(),
  states: z.number().int().positive().optional(),
  foreign: z.boolean().optional(),
  depreciation: z.boolean().optional(),
  lateDocs: z.boolean().optional(),
  priorYearCleanup: z.boolean().optional(),
  irsNotice: z.boolean().optional(),
});

const WetSignatureBody = z.object({
  type: z.enum(['engagement_letter', 'f8879']),
  note: z.string().optional(),
  /** The scanned signed document (uploaded to Signed Authorizations first). */
  documentId: z.uuid().optional(),
});

const ListQuery = z.object({
  stage: z.enum(TAX_STAGES).optional(),
  preparerId: z.uuid().optional(),
  taxYear: z.coerce.number().int().optional(),
  // M28: the client packet needs one client's returns, not all 200.
  contactId: z.uuid().optional(),
});

const DocRequestBody = z.object({
  taxEngagementId: z.uuid(),
  titleEn: z.string().min(1),
  titleEs: z.string().optional(),
  noteEn: z.string().optional(),
  noteEs: z.string().optional(),
  dueDate: z.iso.date().optional(),
  items: z
    .array(z.object({ labelEn: z.string().min(1), labelEs: z.string().optional() }))
    .default([]),
});

function meta(request: FastifyRequest) {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}
function actorOf(request: FastifyRequest) {
  return { staffId: request.staff!.id, label: request.staff!.email };
}

async function loadTaxEngagement(app: FastifyInstance, id: string) {
  const { rows } = await app.db.query<{ id: string; engagement_id: string; contact_id: string; estimated_fee_max_cents: number | null; stage: string }>(
    `SELECT te.id, te.engagement_id, e.contact_id, te.estimated_fee_max_cents, te.stage
     FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id WHERE te.id = $1`,
    [id]
  );
  if (!rows[0]) throw new AppError(404, 'not_found', 'Tax engagement not found.');
  return rows[0];
}

export function registerTaxRoutes(app: FastifyInstance): void {
  const manage = { preHandler: [app.authenticate, requirePermission('engagements.tax.manage')] };
  const read = { preHandler: [app.authenticate, requirePermission('engagements.read')] };

  app.post('/tax-engagements', manage, async (request, reply) => {
    const b = CreateBody.parse(request.body);
    const actor = request.staff!;
    const parent = await createEngagement(
      app,
      actor,
      {
        contactId: b.contactId,
        businessId: b.businessId,
        serviceLine: 'tax',
        title: b.title ?? `${b.taxYear} ${b.returnType.toUpperCase()}`,
        status: 'active',
        leadStaffId: b.preparerId,
      },
      meta(request)
    );
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, client_type, preparer_id, reviewer_id)
       VALUES ($1, $2, $3::return_type, $4::tax_client_type, $5, $6) RETURNING id`,
      [parent.id, b.taxYear, b.returnType, b.clientType ?? null, b.preparerId ?? null, b.reviewerId ?? null]
    );
    const id = rows[0]!.id;
    await app.db.query(
      `INSERT INTO engagement_stage_history (tax_engagement_id, stage, changed_by_staff_id, waiting_on, note)
       VALUES ($1, 'intake_started', $2, 'staff', 'created')`,
      [id, actor.id]
    );
    return reply.code(201).send({ id, engagementId: parent.id });
  });

  /**
   * The preparer queue (M28 wireframe conformance, preparer step 1).
   *
   * Scoped by design: a preparer sees ONLY their own returns, which is the
   * wireframe's "never sees other clients' data" rule. Leadership may pass
   * ?preparerId= to look at someone's queue; a preparer passing someone else's id
   * is ignored rather than refused, because the honest answer to "show me Ana's
   * queue" for a preparer is their own queue, not an error page.
   */
  app.get('/my-queue', read, async (request) => {
    const q = z.object({ preparerId: z.uuid().optional() }).parse(request.query);
    const staff = request.staff!;
    const isLeadership =
      staff.permissions.includes('*') || staff.permissions.includes('dashboards.executive');
    const target = isLeadership && q.preparerId ? q.preparerId : staff.id;
    return { preparerId: target, scoped: !isLeadership, ...(await preparerQueue(app, target, todayChicago())) };
  });

  app.get('/tax-engagements', read, async (request) => {
    const q = ListQuery.parse(request.query);
    const clauses: string[] = ['true'];
    const params: unknown[] = [];
    if (q.stage) { params.push(q.stage); clauses.push(`te.stage = $${params.length}::tax_stage`); }
    if (q.preparerId) { params.push(q.preparerId); clauses.push(`te.preparer_id = $${params.length}`); }
    if (q.taxYear) { params.push(q.taxYear); clauses.push(`te.tax_year = $${params.length}`); }
    if (q.contactId) { params.push(q.contactId); clauses.push(`e.contact_id = $${params.length}`); }
    const { rows } = await app.db.query(
      `SELECT te.id, te.tax_year, te.return_type, te.stage, te.preparer_id, te.reviewer_id,
              te.estimated_fee_min_cents, te.estimated_fee_max_cents, te.final_fee_cents,
              te.scope_creep_flag, te.complexity_score, te.extension_filed, te.filed_date,
              e.contact_id, c.first_name, c.last_name
       FROM tax_engagements te
       JOIN engagements e ON e.id = te.engagement_id
       JOIN contacts c ON c.id = e.contact_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY te.created_at DESC LIMIT 200`,
      params
    );
    return { taxEngagements: rows };
  });

  app.get<{ Params: { id: string } }>('/tax-engagements/:id', read, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const { rows } = await app.db.query(
      `SELECT te.*, e.contact_id, e.business_id, e.price_book_version_id
       FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id WHERE te.id = $1`,
      [id]
    );
    if (!rows[0]) throw new AppError(404, 'not_found', 'Tax engagement not found.');
    const history = await app.db.query(
      `SELECT stage, entered_at, changed_by_staff_id, waiting_on, note
       FROM engagement_stage_history WHERE tax_engagement_id = $1 ORDER BY entered_at`,
      [id]
    );
    return { taxEngagement: rows[0], stageHistory: history.rows };
  });

  app.post<{ Params: { id: string } }>('/tax-engagements/:id/transition', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = TransitionBody.parse(request.body);
    const result = await transitionStage(app, actorOf(request), id, b.toStage, { note: b.note, ...meta(request) });
    return { status: 'ok', ...result };
  });

  // v4.3 flow 1: record the IRS acknowledgement. Accepted → completed;
  // rejected → re-queued with the perfection clock + owned fix task.
  app.post<{ Params: { id: string } }>('/tax-engagements/:id/efile-result', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = z.object({
      result: z.enum(['accepted', 'rejected']),
      rejectCode: z.string().max(40).optional(),
      rejectReason: z.string().max(1000).optional(),
      asOf: z.iso.date().optional(), // clock injection for tests
    }).parse(request.body);
    const out = await recordEfileResult(app, actorOf(request), id, {
      result: b.result, rejectCode: b.rejectCode, rejectReason: b.rejectReason, today: b.asOf,
    });
    return { status: 'ok', ...out };
  });

  // Estimate range + lock (automation 8: locked estimate unlocks preparation).
  // The calculator (M12) will produce these values from the price book.
  app.post<{ Params: { id: string } }>('/tax-engagements/:id/estimate', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = EstimateBody.parse(request.body);
    const te = await loadTaxEngagement(app, id);
    await app.db.query(
      `UPDATE tax_engagements
       SET estimated_fee_min_cents = $2, estimated_fee_max_cents = $3, estimate_locked_at = now()
       WHERE id = $1`,
      [id, b.minCents, b.maxCents]
    );
    await writeAudit(app.db, {
      actorType: 'staff', actorId: request.staff!.id, actorLabel: request.staff!.email,
      action: 'tax_engagement.estimate_locked', objectType: 'tax_engagement', objectId: id,
      contactId: te.contact_id, ...meta(request),
    });
    return { status: 'ok' };
  });

  // Final fee — scope creep auto-flags when final > estimate top, and the
  // reason is REQUIRED at that moment (MP: scope creep reason required).
  app.post<{ Params: { id: string } }>('/tax-engagements/:id/final-fee', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = FinalFeeBody.parse(request.body);
    const te = await loadTaxEngagement(app, id);

    const creep = te.estimated_fee_max_cents !== null && b.finalFeeCents > te.estimated_fee_max_cents;
    if (creep && !b.scopeCreepReason) {
      throw new AppError(
        409,
        'scope_creep_reason_required',
        'Final fee exceeds the top of the estimate — a scope-creep reason is required (additional_states / additional_sch_c / additional_sch_e / foreign / late_docs / prior_year_cleanup / irs_notice / other).'
      );
    }
    if (creep && b.scopeCreepReason === 'other' && !b.scopeCreepDescription) {
      throw new AppError(409, 'scope_creep_description_required', "Reason 'other' requires a description.");
    }

    await app.db.query(
      `UPDATE tax_engagements
       SET final_fee_cents = $2, discount_cents = COALESCE($3, discount_cents),
           scope_creep_flag = $4,
           scope_creep_reason = $5::scope_creep_reason,
           scope_creep_description = $6
       WHERE id = $1`,
      [
        id, b.finalFeeCents, b.discountCents ?? null, creep,
        creep ? b.scopeCreepReason : null, creep ? (b.scopeCreepDescription ?? null) : null,
      ]
    );
    if (creep) {
      await writeAudit(app.db, {
        actorType: 'staff', actorId: request.staff!.id, actorLabel: request.staff!.email,
        action: 'tax_engagement.scope_creep_flagged', objectType: 'tax_engagement', objectId: id,
        contactId: te.contact_id, ...meta(request),
        details: { reason: b.scopeCreepReason, over_estimate_cents: b.finalFeeCents - (te.estimated_fee_max_cents ?? 0) },
      });
    }
    return { status: 'ok', scopeCreepFlag: creep };
  });

  app.post<{ Params: { id: string } }>('/tax-engagements/:id/complexity', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const inputs = ComplexityBody.parse(request.body);
    await loadTaxEngagement(app, id);
    const score = computeComplexityScore(inputs);
    await app.db.query(
      `UPDATE tax_engagements SET complexity_score = $2, complexity_inputs = $3::jsonb WHERE id = $1`,
      [id, score, JSON.stringify(inputs)]
    );
    return { status: 'ok', complexityScore: score };
  });

  // Wet-signature path (in-office clients, ~10%). Docuseal remote flow (M11)
  // sets the same timestamps via webhook; for 8879 the remote path requires
  // KBA first and records signature_method = 'remote_kba'.
  app.post<{ Params: { id: string } }>('/tax-engagements/:id/signatures/wet', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = WetSignatureBody.parse(request.body);
    const te = await loadTaxEngagement(app, id);

    if (b.type === 'engagement_letter') {
      await app.db.query(
        `UPDATE tax_engagements SET engagement_letter_signed_at = COALESCE(engagement_letter_signed_at, now()) WHERE id = $1`,
        [id]
      );
      await app.db.query(`UPDATE contacts SET engagement_letter_status = 'signed' WHERE id = $1`, [te.contact_id]);
    } else {
      await app.db.query(
        `UPDATE tax_engagements
         SET f8879_signed_at = COALESCE(f8879_signed_at, now()), f8879_signature_method = 'in_person_wet'
         WHERE id = $1`,
        [id]
      );
    }
    // Completed envelope record — one queryable source of signature status,
    // wet or remote (the signed scan links in when provided).
    await app.db.query(
      `INSERT INTO signature_envelopes
         (contact_id, tax_engagement_id, type, status, signature_method, signed_document_id, completed_at, created_by_staff_id)
       VALUES ($1, $2, $3::envelope_type, 'completed', 'in_person_wet', $4, now(), $5)`,
      [te.contact_id, id, b.type === 'f8879' ? 'f8879' : 'engagement_letter', b.documentId ?? null, request.staff!.id]
    );
    await writeAudit(app.db, {
      actorType: 'staff', actorId: request.staff!.id, actorLabel: request.staff!.email,
      action: 'signature.recorded_wet', objectType: 'tax_engagement', objectId: id,
      contactId: te.contact_id, ...meta(request),
      details: { type: b.type, note: b.note ?? null },
    });
    return { status: 'ok' };
  });

  // Document-request creation (automation 4): itemized request → client email
  // in their language → engagement flips to pending_client_response. The
  // recurring reminder + 7-day alert live in the document-chase job (M10).
  app.post('/document-requests', manage, async (request, reply) => {
    const b = DocRequestBody.parse(request.body);
    const te = await loadTaxEngagement(app, b.taxEngagementId);
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO document_requests (contact_id, engagement_id, tax_engagement_id, title_en, title_es, note_en, note_es, due_date, created_by_staff_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        te.contact_id, te.engagement_id, b.taxEngagementId, b.titleEn, b.titleEs ?? null,
        b.noteEn ?? null, b.noteEs ?? null, b.dueDate ?? null, request.staff!.id,
      ]
    );
    const requestId = rows[0]!.id;
    for (const item of b.items) {
      await app.db.query(
        `INSERT INTO document_request_items (request_id, label_en, label_es) VALUES ($1, $2, $3)`,
        [requestId, item.labelEn, item.labelEs ?? null]
      );
    }

    // Tell the client what we need, in their language, with an item list.
    const contact = await app.db.query<{ first_name: string; email: string | null; language: 'en' | 'es' }>(
      `SELECT first_name, email, language FROM contacts WHERE id = $1`,
      [te.contact_id]
    );
    const c = contact.rows[0];
    if (c?.email) {
      const items = b.items
        .map((i) => `• ${(c.language === 'es' ? i.labelEs : i.labelEn) ?? i.labelEn}`)
        .join('\n');
      await sendTemplatedEmail(app, {
        to: c.email,
        templateKey: 'doc_request',
        language: c.language,
        contactId: te.contact_id,
        vars: {
          first_name: c.first_name,
          request_title: (c.language === 'es' ? b.titleEs : b.titleEn) ?? b.titleEn,
          items_list: items || '—',
          portal_link: app.config.PORTAL_BASE_URL,
        },
      });
    }

    await markDocumentsRequested(app, actorOf(request), b.taxEngagementId);
    return reply.code(201).send({ id: requestId });
  });
}
