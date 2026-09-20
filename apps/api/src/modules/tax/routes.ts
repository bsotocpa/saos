// Tax engagement module (MP Tax Operations): creation, pipeline transitions,
// estimate lock, final fee + scope-creep enforcement, complexity scoring, and
// the wet-signature path (in-office ~10%; the Docuseal remote path lands in
// M11 and sets the same timestamps).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { reasonText } from '../../reasons.ts';
import { writeAudit } from '../../audit.ts';
import { holds, requirePermission } from '../../plugins/auth.ts';
import { AppError } from '../../types.ts';
import { createEngagement } from '../engagements/service.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { computeComplexityScore } from './complexity.ts';
import { TAX_STAGES, acceptanceStatus, legalNextStages, markDocumentsRequested, recordEfileResult, transitionStage, type TaxStage } from './pipeline.ts';
import { preparerQueue } from './queue.ts';
import { todayChicago } from './deadlines.ts';
import { returnTypeForItems } from './return-type.ts';
import { currentPriceBookVersion } from '../pricing/service.ts';
import { formatUsd } from '../billing/service.ts';

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
  /**
   * GATED (2026-09-12, ruling 2b): the accepted quote makes the engagement and the return with
   * it. Opening a return by hand where no engagement exists is the exception, and the exception
   * says why; when an active engagement for the year exists, the return attaches and no reason
   * is needed.
   */
  reason: reasonText(10, 1000).optional(),
});

const TransitionBody = z.object({
  toStage: z.enum(TAX_STAGES),
  note: z.string().optional(),
  /** Required when toStage is 'filed': the staff member whose PTIN is on the filing. */
  preparerPtinHolderId: z.uuid().optional(),
  /**
   * JURISDICTIONS ARE DECLARED ON THE RETURN (Brian, 2026-09-19 evening, ruling 2). Read only at
   * 'filed': federal plus zero or more two-letter state codes. The shape is checked here; what a
   * list must contain (federal, upper-case codes, nothing twice) is checked in one place —
   * assertJurisdictions in pipeline.ts — so a direct caller hears the same words.
   */
  jurisdictions: z.array(z.string().min(1).max(20)).max(60).optional(),
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
  /**
   * THE STANDALONE REASON (Brian, 2026-09-19, item 2): a final fee outside the quoted range says
   * why, in words the next reader can use, and registers on the money line. Optional in the
   * schema; the route requires it the moment the amount leaves the range.
   */
  reason: reasonText(10, 1000).optional(),
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
  return { staffId: request.staff!.id, label: request.staff!.fullName };
}

async function loadTaxEngagement(app: FastifyInstance, id: string) {
  const { rows } = await app.db.query<{
    id: string; engagement_id: string; contact_id: string; return_type: string; stage: string;
    estimated_fee_min_cents: number | null; estimated_fee_max_cents: number | null;
  }>(
    `SELECT te.id, te.engagement_id, e.contact_id, te.return_type, te.stage, te.estimated_fee_min_cents, te.estimated_fee_max_cents
     FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id WHERE te.id = $1`,
    [id]
  );
  if (!rows[0]) throw new AppError(404, 'not_found', 'Tax engagement not found.');
  return rows[0];
}

export interface QuotedRange { min_cents: number; max_cents: number; price_book_version: number }

/**
 * THE QUOTED RANGE A FINAL FEE IS MEASURED AGAINST (Brian, 2026-09-19, item 2).
 *
 * Once the estimate is locked, the locked range IS the range: that is the number the client was
 * given and it no longer moves. Before that, the accepted quote's line for this return: the
 * engagement's scope snapshot (#47) names the base return item, and the price book in force
 * prices it — a flat item is a range of one number. The version reported is the one in force
 * today, which is what the fee is read against. A return with neither (opened by hand, no scope
 * rows) has no range, and a fee on it needs no reason for being outside one.
 */
export async function quotedRangeFor(
  app: FastifyInstance,
  te: { engagement_id: string; return_type: string; estimated_fee_min_cents: number | null; estimated_fee_max_cents: number | null }
): Promise<QuotedRange | null> {
  const version = await currentPriceBookVersion(app.db);
  if (te.estimated_fee_min_cents !== null && te.estimated_fee_max_cents !== null) {
    return { min_cents: te.estimated_fee_min_cents, max_cents: te.estimated_fee_max_cents, price_book_version: version.versionNumber };
  }
  const scope = await app.db.query<{ item_code: string }>(
    `SELECT item_code FROM engagement_scope_items WHERE engagement_id = $1 ORDER BY sort_order`,
    [te.engagement_id]
  );
  const base = scope.rows.map((r) => r.item_code).find((code) => returnTypeForItems([code])?.returnType === te.return_type);
  if (!base) return null;
  const item = await app.db.query<{ amount_cents: number | null; price_min_cents: number | null; price_max_cents: number | null }>(
    `SELECT amount_cents, price_min_cents, price_max_cents FROM price_book_items WHERE version_id = $1 AND item_code = $2 AND is_active`,
    [version.id, base]
  );
  const it = item.rows[0];
  if (!it) return null;
  const ranged = it.price_min_cents !== null && it.price_max_cents !== null;
  const min = ranged ? it.price_min_cents : it.amount_cents;
  const max = ranged ? it.price_max_cents : it.amount_cents;
  if (min === null || max === null) return null;
  return { min_cents: min, max_cents: max, price_book_version: version.versionNumber };
}

export function registerTaxRoutes(app: FastifyInstance): void {
  const manage = { preHandler: [app.authenticate, requirePermission('engagements.tax.manage')] };
  const read = { preHandler: [app.authenticate, requirePermission('engagements.read')] };

  app.post('/tax-engagements', manage, async (request, reply) => {
    const b = CreateBody.parse(request.body);
    const actor = request.staff!;
    /*
     * THE ACCEPTED QUOTE ALREADY MADE THE ENGAGEMENT (2026-09-12, the first 1120S). A tax line on
     * an accepted quote creates the engagement for that year, and since today the return record
     * with it. A preparer opening a return by hand must not collide with it (the one-active-per-
     * line-period index would refuse, and the preparer would be stuck), nor make a second one:
     * an active tax engagement for this client and year with no return record is attached to;
     * one that already has its return is named.
     */
    const existing = await app.db.query<{ id: string; te_id: string | null }>(
      `SELECT e.id, te.id AS te_id FROM engagements e LEFT JOIN tax_engagements te ON te.engagement_id = e.id
        WHERE e.contact_id = $1 AND e.service_line = 'tax' AND e.status IN ('active', 'on_hold') AND e.period_key = $2
          AND COALESCE(e.business_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        ORDER BY e.created_at LIMIT 1`,
      [b.contactId, String(b.taxYear), b.businessId ?? null]
    );
    if (existing.rows[0]?.te_id) {
      throw new AppError(409, 'return_exists', `This client already has a ${b.taxYear} return record (tax engagement ${existing.rows[0].te_id}); open that one.`);
    }
    let parentId: string;
    if (existing.rows[0]) {
      parentId = existing.rows[0].id;
      if (b.businessId) await app.db.query(`UPDATE engagements SET business_id = COALESCE(business_id, $2) WHERE id = $1`, [parentId, b.businessId]);
    } else {
      if (!b.reason) {
        throw new AppError(
          409,
          'no_engagement_for_year',
          `This client has no active tax engagement for ${b.taxYear}. An accepted quote creates one, with the return record; to open one by hand, say why (reason).`
        );
      }
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
          periodKey: String(b.taxYear),
          origin: { via: 'staff', reason: b.reason },
        },
        meta(request)
      );
      parentId = parent.id;
    }
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, client_type, preparer_id, reviewer_id)
       VALUES ($1, $2, $3::return_type, $4::tax_client_type, $5, $6) RETURNING id`,
      [parentId, b.taxYear, b.returnType, b.clientType ?? null, b.preparerId ?? null, b.reviewerId ?? null]
    );
    const parent = { id: parentId };
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
    const q = z.object({ preparerId: z.uuid().optional(), all: z.enum(['1']).optional() }).parse(request.query);
    const staff = request.staff!;
    const isLeadership =
      staff.permissions.includes('*') || staff.permissions.includes('dashboards.executive');
    /*
     * THE SOLO DRY RUN (Brian, 2026-09-19): he acts as every role before the team sees it, and a
     * queue that shows only the returns assigned to him would hide the preparer's work. Leadership
     * asks for everyone's (?all=1) or one person's (?preparerId=); a preparer always gets their own.
     */
    const target = isLeadership && q.all ? null : isLeadership && q.preparerId ? q.preparerId : staff.id;
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
              te.preparer_ptin_holder_id, ptin.display_name AS preparer_of_record,
              te.f8879_document_id, te.f8879_signed_at::date::text AS f8879_signed_on,
              te.federal_accepted_on::text AS federal_accepted_on, te.state_accepted_on::text AS state_accepted_on, te.state_accepted_code,
              te.estimated_fee_min_cents, te.estimated_fee_max_cents, te.final_fee_cents,
              te.scope_creep_flag, te.complexity_score, te.extension_filed, te.filed_date,
              e.contact_id, c.first_name, c.last_name
       FROM tax_engagements te
       JOIN engagements e ON e.id = te.engagement_id
       JOIN contacts c ON c.id = e.contact_id
       LEFT JOIN staff ptin ON ptin.id = te.preparer_ptin_holder_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY te.created_at DESC LIMIT 200`,
      params
    );
    return { taxEngagements: rows };
  });

  app.get<{ Params: { id: string } }>('/tax-engagements/:id', read, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const { rows } = await app.db.query(
      `SELECT te.*, e.contact_id, e.business_id, e.price_book_version_id, ptin.display_name AS preparer_of_record
       FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id
       LEFT JOIN staff ptin ON ptin.id = te.preparer_ptin_holder_id WHERE te.id = $1`,
      [id]
    );
    if (!rows[0]) throw new AppError(404, 'not_found', 'Tax engagement not found.');
    // THE WALL (phase 2, 2026-09-12): the complexity inputs are the return interview. interviews.read only.
    if (!holds(request.staff!, 'interviews.read')) delete (rows[0] as Record<string, unknown>).complexity_inputs;
    const history = await app.db.query(
      `SELECT stage, entered_at, changed_by_staff_id, waiting_on, note
       FROM engagement_stage_history WHERE tax_engagement_id = $1 ORDER BY entered_at`,
      [id]
    );
    /*
     * WHAT THE RETURN'S PAGE NEEDS TO OFFER THE RIGHT CONTROLS (Brian, 2026-09-19, item 2): the
     * legal next stage(s), the quoted range and the book version the final fee is read against,
     * whether a signed authorization is on file (told before the tap, refused at it), the
     * assigned preparer (the PTIN-holder default) and who may be the PTIN holder at all.
     */
    const te = rows[0] as {
      stage: TaxStage; engagement_id: string; return_type: string; preparer_id: string | null;
      f8879_document_id: string | null; f8879_signed_at: Date | null;
      estimated_fee_min_cents: number | null; estimated_fee_max_cents: number | null;
    };
    const [quotedRange, jurisdictions, assigned, staffOptions] = await Promise.all([
      quotedRangeFor(app, te),
      // The Mark filed modal's jurisdiction list: what the address suggests, and what the return
      // already declares (Brian, 2026-09-19 evening, ruling 2).
      acceptanceStatus(app, id),
      te.preparer_id
        ? app.db.query<{ id: string; name: string }>(`SELECT id, display_name AS name FROM staff WHERE id = $1`, [te.preparer_id])
        : Promise.resolve({ rows: [] as Array<{ id: string; name: string }> }),
      app.db.query<{ id: string; name: string }>(
        `SELECT s.id, s.display_name AS name FROM staff s JOIN roles r ON r.id = s.role_id
          WHERE s.is_active AND r.key IN ('tax_preparer', 'ceo') ORDER BY s.display_name`
      ),
    ]);
    return {
      taxEngagement: rows[0],
      stageHistory: history.rows,
      quoted_range: quotedRange,
      default_jurisdictions: jurisdictions.defaultJurisdictions,
      declared_jurisdictions: jurisdictions.declaredJurisdictions,
      jurisdictions_awaiting: jurisdictions.awaiting,
      legal_next_stages: legalNextStages(te.stage),
      signed_authorization_on_file: Boolean(te.f8879_document_id && te.f8879_signed_at),
      assigned_preparer: assigned.rows[0] ?? null,
      staff_options: staffOptions.rows,
    };
  });

  app.post<{ Params: { id: string } }>('/tax-engagements/:id/transition', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = TransitionBody.parse(request.body);
    const result = await transitionStage(app, actorOf(request), id, b.toStage, {
      note: b.note, preparerPtinHolderId: b.preparerPtinHolderId, jurisdictions: b.jurisdictions, ...meta(request),
    });
    return { status: 'ok', ...result };
  });

  // v4.3 flow 1: record an e-file acknowledgement. Accepted → completed once every
  // jurisdiction has accepted (2026-09-19); rejected → re-queued with the perfection clock + owned fix task.
  app.post<{ Params: { id: string } }>('/tax-engagements/:id/efile-result', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = z.object({
      result: z.enum(['accepted', 'rejected']),
      rejectCode: z.string().max(40).optional(),
      rejectReason: z.string().max(1000).optional(),
      asOf: z.iso.date().optional(), // clock injection for tests
      // 2026-09-19: which jurisdiction answered. Federal when unsaid; a return completes only
      // when every jurisdiction it files in has accepted (the response carries `awaiting`).
      jurisdiction: z.enum(['federal', 'state']).optional(),
      stateCode: z.string().regex(/^[A-Za-z]{2}$/).optional(),
    }).parse(request.body);
    const out = await recordEfileResult(app, actorOf(request), id, {
      result: b.result, rejectCode: b.rejectCode, rejectReason: b.rejectReason, today: b.asOf,
      jurisdiction: b.jurisdiction, stateCode: b.stateCode,
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
      actorType: 'staff', actorId: request.staff!.id, actorLabel: request.staff!.fullName,
      action: 'tax_engagement.estimate_locked', objectType: 'tax_engagement', objectId: id,
      contactId: te.contact_id, ...meta(request),
    });
    return { status: 'ok' };
  });

  // Final fee — scope creep auto-flags when final > estimate top, and the
  // reason is REQUIRED at that moment (MP: scope creep reason required).
  // Sets the fee fields only: the invoice is issued at 'filed', through createInvoice (the money door).
  app.post<{ Params: { id: string } }>('/tax-engagements/:id/final-fee', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = FinalFeeBody.parse(request.body);
    const te = await loadTaxEngagement(app, id);

    const creep = te.estimated_fee_max_cents !== null && b.finalFeeCents > te.estimated_fee_max_cents;
    /*
     * OUTSIDE THE QUOTED RANGE (Brian, 2026-09-19, item 2): the fee is read against the range the
     * client was quoted, under the price book in force. Leaving it in either direction needs a
     * standalone reason, and the move registers on the money line through its own audit action.
     * Read here, above the scope-creep check, because a fee over a locked top is USUALLY outside the
     * range as well — the locked range IS the quoted range — and a refusal that mentions only one of
     * the two tells the person half of what happened.
     */
    const range = await quotedRangeFor(app, te);
    const outside = range !== null && (b.finalFeeCents < range.min_cents || b.finalFeeCents > range.max_cents);

    /*
     * ABOVE A LOCKED ESTIMATE: ONE MODAL, ONE REASON, AND THE CATEGORY (Brian, 2026-09-19 evening,
     * ruling 1). The previous build asked for one free-text reason and filed it under the category
     * 'other'. That made every overrun in the firm's history read the same — "other" — so the one
     * question the category answers, "what keeps putting us over the estimate", could never be
     * asked of the data. The category is now chosen, in the same modal, beside the same reason, and
     * it is NEVER defaulted: 'other' means a person looked at the list and none of it fit.
     *
     * Both are required the moment the amount is above the locked top, and the refusal names which
     * one is missing so the modal can say it beside the field.
     */
    const scopeCreepReason = b.scopeCreepReason;
    // The required reason IS the description — including for the category 'other', which is why
    // there is no separate "'other' needs a description" refusal any more: it cannot be reached.
    const scopeCreepDescription = b.scopeCreepDescription || b.reason;
    if (creep) {
      const missing: string[] = [];
      if (!scopeCreepReason) missing.push('a scope-creep category');
      if (!scopeCreepDescription) missing.push('a reason');
      if (missing.length > 0) {
        const where =
          outside && range
            ? `${formatUsd(b.finalFeeCents)} is outside the quoted range ${formatUsd(range.min_cents)}–${formatUsd(range.max_cents)} (price book v${range.price_book_version}) and above the locked estimate's top of ${formatUsd(te.estimated_fee_max_cents!)}`
            : `${formatUsd(b.finalFeeCents)} is above the locked estimate's top of ${formatUsd(te.estimated_fee_max_cents!)}`;
        throw new AppError(
          409,
          'scope_creep_reason_required',
          `${where} — ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing. ` +
            'Choose the category (additional_states / additional_sch_c / additional_sch_e / foreign / late_docs / prior_year_cleanup / irs_notice / other) and say why in the reason; both register on the money line.'
        );
      }
    }

    if (outside && !b.reason) {
      throw new AppError(
        409,
        'final_fee_reason_required',
        `${formatUsd(b.finalFeeCents)} is outside the quoted range ${formatUsd(range.min_cents)}–${formatUsd(range.max_cents)} (price book v${range.price_book_version}). Say why in a reason; it registers on the money line.`
      );
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
        creep ? scopeCreepReason : null, creep ? (scopeCreepDescription ?? null) : null,
      ]
    );
    if (creep) {
      await writeAudit(app.db, {
        actorType: 'staff', actorId: request.staff!.id, actorLabel: request.staff!.fullName,
        action: 'tax_engagement.scope_creep_flagged', objectType: 'tax_engagement', objectId: id,
        contactId: te.contact_id, ...meta(request),
        details: { reason: scopeCreepReason, over_estimate_cents: b.finalFeeCents - (te.estimated_fee_max_cents ?? 0) },
      });
    }
    if (outside) {
      await writeAudit(app.db, {
        actorType: 'staff', actorId: request.staff!.id, actorLabel: request.staff!.fullName,
        action: 'tax_engagement.final_fee_outside_quote', objectType: 'tax_engagement', objectId: id,
        contactId: te.contact_id, ...meta(request),
        details: {
          final_fee_cents: b.finalFeeCents, amount_cents: b.finalFeeCents,
          quoted_min_cents: range.min_cents, quoted_max_cents: range.max_cents,
          price_book_version: range.price_book_version, reason: b.reason,
        },
      });
    }
    return { status: 'ok', scopeCreepFlag: creep, outsideQuotedRange: outside };
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

    if (b.type === 'f8879') {
      // 2026-09-12: the signed 8879 is the uploaded document. This route no longer stamps it.
      throw new AppError(410, 'f8879_is_an_upload', 'Upload the wet-signed, scanned 8879 to the return under Signed Authorizations, with the signed date and the preparer of record. That upload authorizes the return.');
    }
    if (b.type === 'engagement_letter') {
      await app.db.query(
        `UPDATE tax_engagements SET engagement_letter_signed_at = COALESCE(engagement_letter_signed_at, now()) WHERE id = $1`,
        [id]
      );
      await app.db.query(`UPDATE contacts SET engagement_letter_status = 'signed' WHERE id = $1`, [te.contact_id]);
    }
    // Completed envelope record — one queryable source of signature status,
    // wet or remote (the signed scan links in when provided).
    await app.db.query(
      `INSERT INTO signature_envelopes
         (contact_id, tax_engagement_id, type, status, signature_method, signed_document_id, completed_at, created_by_staff_id)
       VALUES ($1, $2, $3::envelope_type, 'completed', 'in_person_wet', $4, now(), $5)`,
      [te.contact_id, id, 'engagement_letter', b.documentId ?? null, request.staff!.id]
    );
    await writeAudit(app.db, {
      actorType: 'staff', actorId: request.staff!.id, actorLabel: request.staff!.fullName,
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
