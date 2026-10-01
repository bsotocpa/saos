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
import {
  FILING_METHODS, MAILING_METHODS, PREPARER_ROLE_KEYS, TAX_STAGES, acceptanceStatus, applyNewReturnDefaults, assignPreparer,
  correctFiling, legalNextStages, markDocumentsRequested, recordEfileResult, recordJurisdictionMailing, reopenCompletedReturn, soleActiveTaxPreparerId,
  transitionStage, type TaxStage,
} from './pipeline.ts';
import { preparerQueue } from './queue.ts';
import { F8879_SENT_METHODS, f8879SentView, record8879Sent } from './f8879-sent.ts';
import { todayChicago } from './deadlines.ts';
import { itemPricesReturnType } from './return-type.ts';
import { currentPriceBookVersion } from '../pricing/service.ts';
import { formatUsd } from '../billing/service.ts';
import { chicagoDayOf } from '../../chicago-day.ts';
import { WITHDRAWN_ON_SQL, WITHDRAWN_REASON_SQL } from './withdrawn.ts';

const CreateBody = z.object({
  contactId: z.uuid(),
  businessId: z.uuid().optional(),
  taxYear: z.number().int().min(2000).max(2100),
  // v4.3 authoritative table coverage (M24): estate/trust, both 1120-F
  // variants, expat 1040, and FBAR join the original set.
  // R66 (2026-09-26): the Form 990 family is 990, 990-EZ, 990-PF and 990-T; all four extend on 8868.
  returnType: z.enum([
    '1040', '1065', '1120s', '1120', '990', '990ez', '990pf', '990t', '1120c', '1120f', '1120h', '1120pol', 'w7_itin',
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
  /**
   * PAPER FILING IS PER JURISDICTION (Brian, 2026-09-20, ruling 15). Read only at 'filed': how each
   * declared jurisdiction went out, from the select beside its row in the Mark filed modal. A
   * jurisdiction left out takes the lane its YEAR implies (filingLane), which is the answer for
   * every return that is not a mixed filing. What the map may contain is checked in one place —
   * assertFilingMethods in pipeline.ts — so a direct caller hears the same words.
   */
  filingMethods: z.record(z.string().min(1).max(20), z.enum(FILING_METHODS)).optional(),
  /**
   * FILED ON (Brian, 2026-09-26). Read only at 'filed': the calendar day the return went in. Today in
   * Chicago when unsaid. The two rules — not after today, not before the signed 8879 — are held in
   * one place, assertFiledOn in pipeline.ts, so the correction door refuses in the same words.
   */
  filedOn: z.iso.date().optional(),
});

/**
 * THE FILING, CORRECTED (Brian, 2026-09-26). Each field optional; a field left out is not touched,
 * and a field sent equal to what the filing records is not a correction. The reason is the record —
 * standalone, for whoever reads it next, validated like every other staff reason.
 */
const FilingCorrectionBody = z.object({
  filedOn: z.iso.date().optional(),
  preparerPtinHolderId: z.uuid().optional(),
  jurisdictions: z.array(z.string().min(1).max(20)).max(60).optional(),
  /** With a corrected PTIN holder: also make them the assigned preparer, through the assign door. */
  alsoAssignPreparer: z.boolean().optional(),
  /**
   * THE AUTHORIZATION (R69 / R66): the day on the signed 8879, a replacement scan (a document already
   * uploaded through POST /documents under Signed Authorizations for this client), and which 8879 the
   * paper is. The rules — after today, after the filed day, a scan from another client, a form name the
   * ruling does not list — are held in correctFiling and read back in its words.
   */
  f8879SignedOn: z.iso.date().optional(),
  f8879DocumentId: z.uuid().optional(),
  f8879Variant: z.string().trim().min(1).max(12).optional(),
  reason: reasonText(10, 1000),
});

/** REOPEN (R67): one standalone reason; the CEO alone holds the door (engagements.tax.reopen, explicit-only). */
const ReopenBody = z.object({ reason: reasonText(10, 1000) });

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

/**
 * THE RETIRED WET-SIGNATURE ROUTE. Both types are uploads now: the 8879 since 2026-09-12, the
 * engagement letter since 2026-09-20. The type stays in the schema so a caller that still posts
 * here is told where the door moved to, in words, instead of getting a shape error.
 */
const WetSignatureBody = z.object({
  type: z.enum(['engagement_letter', 'f8879']),
  note: z.string().optional(),
  /** The scanned signed document (uploaded to Signed Authorizations first). */
  documentId: z.uuid().optional(),
});

/** Who a return may be assigned to: a tax preparer, or the CEO working a return himself. */
const AssignPreparerBody = z.object({ staffId: z.uuid() });

/**
 * THE 8879 SENT FOR SIGNATURE (Brian, 2026-09-26, R53): how it reached the client and the day.
 * Recorded, never sent, by SAOS; the rules (delivered or later, no 8879 on file yet, not after today)
 * live in f8879-sent.ts so a direct caller hears the same words the modal shows.
 */
const F8879SentBody = z.object({
  method: z.enum(F8879_SENT_METHODS),
  sentOn: z.iso.date(),
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

/**
 * THE AUDIT ACTIONS THAT ARE A STEP (R50). What GET /tax-engagements/:id returns as `activity`, so
 * the stepper can print who did each thing: the letter and the 8879 (signature.recorded_wet, with
 * details.type saying which), the estimate lock, the preparer, the fee, the 8879 sent, the filing
 * and every other stage change, the corrections, the paper mailings.
 */
const STEP_ACTIONS = [
  'signature.recorded_wet', 'tax_engagement.estimate_locked', 'tax_engagement.preparer_assigned',
  'tax_engagement.final_fee_set', 'tax_engagement.f8879_sent_recorded', 'tax_engagement.f8879_sent_declared_by_import',
  'tax_engagement.stage_changed', 'tax_engagement.filing_corrected', 'tax_engagement.paper_mailed',
  'tax_engagement.imported_at_stage', 'tax_engagement.extension_filed', 'tax_engagement.reopened',
];

function meta(request: FastifyRequest) {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}
function actorOf(request: FastifyRequest) {
  return { staffId: request.staff!.id, label: request.staff!.fullName };
}

async function loadTaxEngagement(app: FastifyInstance, id: string) {
  const { rows } = await app.db.query<{
    id: string; engagement_id: string; tax_year: number; contact_id: string; return_type: string; stage: string;
    estimated_fee_min_cents: number | null; estimated_fee_max_cents: number | null; estimate_price_book_version_id: string | null;
  }>(
    `SELECT te.id, te.engagement_id, te.tax_year, e.contact_id, te.return_type, te.stage, te.estimated_fee_min_cents, te.estimated_fee_max_cents,
            te.estimate_price_book_version_id
     FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id WHERE te.id = $1`,
    [id]
  );
  if (!rows[0]) throw new AppError(404, 'not_found', 'Tax engagement not found.');
  return rows[0];
}

export interface QuotedRange { min_cents: number; max_cents: number; price_book_version: number }

/**
 * THE QUOTED RANGE A FINAL FEE IS MEASURED AGAINST (Brian, 2026-09-19 item 2; 2026-09-20 ruling 13).
 *
 * Once the estimate is locked, the locked range IS the range: that is the number the client was
 * given and it no longer moves.
 *
 * Before that: THE WHOLE ACCEPTED QUOTE FOR THIS RETURN, SCHEDULES INCLUDED. It used to be the base
 * return line alone, which made every quote with a Schedule C, an extra state or the prior-year
 * surcharge on it read LOW — so the honest final fee, the exact figure the client accepted, landed
 * "outside the quoted range" and asked the preparer to justify quoted scope as if it were scope
 * creep. Min of mins, max of maxes; a flat line contributes its one amount to both ends.
 *
 * WHICH ROWS, AND WHY THOSE. The engagement's own scope snapshot (#47) — not `quote_line_items`.
 * The snapshot IS the accepted quote's lines, copied by value at acceptance, and #47 is explicit
 * that a quote edited next week must not reach an agreement already made: reading the live quote
 * lines for a total is the exact join that migration forbids. The snapshot carries the item code,
 * the quantity and the version that was pinned when the client accepted.
 *
 * AT WHICH PRICES. The version PINNED ON THE SNAPSHOT, which is the quote's price lock — never the
 * book in force. A price rise between acceptance and filing must not widen the range the client was
 * quoted (and a price cut must not narrow it): the version's rows never move, because a price
 * change creates a NEW version and edits only that one (admin/routes.ts). A ranged item contributes
 * its min and max, a flat item its amount, each times the quantity on the line; a pass-through
 * (client software billed at cost) contributes nothing, because it is shown to the client and is
 * never our fee.
 *
 * THE FALLBACK, only when no accepted quote exists: the base return item under the book in force —
 * what a scope snapshot written by hand, or a return with no quote behind it, has always read. A
 * return with neither has no range, and a fee on it needs no reason for being outside one.
 */
export async function quotedRangeFor(
  app: FastifyInstance,
  te: { engagement_id: string; tax_year: number; return_type: string; estimated_fee_min_cents: number | null; estimated_fee_max_cents: number | null; estimate_price_book_version_id?: string | null }
): Promise<QuotedRange | null> {
  const version = await currentPriceBookVersion(app.db);
  if (te.estimated_fee_min_cents !== null && te.estimated_fee_max_cents !== null) {
    // R109: a locked range names the version it was locked under (0138), never the book in force today.
    const locked = te.estimate_price_book_version_id
      ? (await app.db.query<{ n: number }>(`SELECT version_number AS n FROM price_book_versions WHERE id = $1`, [te.estimate_price_book_version_id])).rows[0]?.n
      : undefined;
    return { min_cents: te.estimated_fee_min_cents, max_cents: te.estimated_fee_max_cents, price_book_version: locked ?? version.versionNumber };
  }
  const quoted = await acceptedQuoteRange(app, te.engagement_id, te.tax_year);
  if (quoted) return quoted;
  // R89: this return's own lines; a scope row with no year belongs to the engagement's one return.
  const scope = await app.db.query<{ item_code: string }>(
    `SELECT item_code FROM engagement_scope_items WHERE engagement_id = $1 AND (tax_year IS NULL OR tax_year = $2) ORDER BY sort_order`,
    [te.engagement_id, te.tax_year]
  );
  // The base item that prices THIS return type — its own, or one it covers (R66: BIZ_990 prices the 990-EZ too).
  const base = scope.rows.map((r) => r.item_code).find((code) => itemPricesReturnType(code, te.return_type));
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

/**
 * The sum of the accepted quote's lines for this engagement, at the prices that quote locked.
 *
 * `source_quote_id` is read as PROVENANCE — does an accepted quote stand behind this scope? — and
 * never for amounts; every figure comes from the snapshot rows and the version pinned on them.
 * Null when no accepted quote stands behind the scope, or when nothing on it carries a price at
 * all, and the caller falls back to the base item under the book in force.
 */
async function acceptedQuoteRange(app: FastifyInstance, engagementId: string, taxYear: number): Promise<QuotedRange | null> {
  const { rows } = await app.db.query<{
    quantity: string; unit_cents: number | null; line_cents: number | null; is_pass_through: boolean;
    version_number: number; amount_cents: number | null; price_min_cents: number | null; price_max_cents: number | null;
  }>(
    `SELECT s.quantity::text AS quantity, s.unit_cents, s.line_cents, s.is_pass_through,
            v.version_number, i.amount_cents, i.price_min_cents, i.price_max_cents
       FROM engagement_scope_items s
       JOIN quotes q ON q.id = s.source_quote_id AND q.status = 'accepted'
       JOIN price_book_versions v ON v.id = s.price_book_version_id
       LEFT JOIN price_book_items i ON i.version_id = s.price_book_version_id AND i.item_code = s.item_code
      WHERE s.engagement_id = $1 AND (s.tax_year IS NULL OR s.tax_year = $2)
      ORDER BY s.sort_order`,
    // R89: an engagement holding several years quoted each year's lines; this return's range is its own year's.
    [engagementId, taxYear]
  );
  let min = 0;
  let max = 0;
  let counted = 0;
  for (const r of rows) {
    if (r.is_pass_through) continue;
    const qty = Number(r.quantity);
    if (r.price_min_cents !== null && r.price_max_cents !== null) {
      min += Math.round(r.price_min_cents * qty);
      max += Math.round(r.price_max_cents * qty);
      counted++;
      continue;
    }
    // A flat line: what the client agreed to on that line, else the book's amount for it.
    const flat =
      r.line_cents !== null
        ? r.line_cents
        : r.unit_cents !== null
          ? Math.round(r.unit_cents * qty)
          : r.amount_cents !== null
            ? Math.round(r.amount_cents * qty)
            : null;
    if (flat === null) continue;
    min += flat;
    max += flat;
    counted++;
  }
  if (counted === 0) return null;
  return { min_cents: min, max_cents: max, price_book_version: rows[0]!.version_number };
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
    /*
     * R89 (2026-09-29): a year is held either as an engagement's period or as a return inside an
     * engagement that holds several years. Every active tax engagement of this client and entity that
     * covers the year is read; a return for the year in any of them (withdrawn included, which the
     * (engagement, year) key still holds) is named, and an engagement for the year with no return
     * for it is attached to.
     */
    const { activeTaxEngagementsForYears } = await import('../engagements/period.ts');
    const held = await activeTaxEngagementsForYears(app, b.contactId, b.businessId ?? null, [b.taxYear]);
    const heldReturn = held.length === 0 ? null : (await app.db.query<{ id: string }>(
      `SELECT id FROM tax_engagements WHERE engagement_id = ANY($1::uuid[]) AND tax_year = $2
        ORDER BY (stage = 'withdrawn'), created_at LIMIT 1`,
      [held.map((h) => h.id), b.taxYear]
    )).rows[0];
    if (heldReturn) {
      throw new AppError(409, 'return_exists', `This client already has a ${b.taxYear} return record (tax engagement ${heldReturn.id}); open that one.`);
    }
    const existing = held.find((h) => h.periodKey === String(b.taxYear));
    let parentId: string;
    if (existing) {
      parentId = existing.id;
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
    /*
     * WHAT THE NEW RETURN ALREADY HOLDS (Brian, 2026-09-20): the engagement letter the client has
     * already signed, and the firm's only tax preparer when there is only one. Both creation paths
     * — here and quote acceptance — go through the same helper so they cannot drift.
     */
    const defaults = await applyNewReturnDefaults(app, id, b.contactId);
    return reply.code(201).send({ id, engagementId: parent.id, ...defaults });
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
    // R93: "today" is Chicago's calendar day; the first parameter, so the overdue column can read it.
    const params: unknown[] = [todayChicago()];
    const todayParam = 1;
    if (q.stage) { params.push(q.stage); clauses.push(`te.stage = $${params.length}::tax_stage`); }
    if (q.preparerId) { params.push(q.preparerId); clauses.push(`te.preparer_id = $${params.length}`); }
    if (q.taxYear) { params.push(q.taxYear); clauses.push(`te.tax_year = $${params.length}`); }
    if (q.contactId) { params.push(q.contactId); clauses.push(`e.contact_id = $${params.length}`); }
    const { rows } = await app.db.query(
      `SELECT te.id, te.tax_year, te.return_type, te.stage, te.preparer_id, te.reviewer_id,
              te.preparer_ptin_holder_id, ptin.display_name AS preparer_of_record,
              te.f8879_document_id, te.f8879_signed_at::date::text AS f8879_signed_on, f8.f8879_variant,
              te.federal_accepted_on::text AS federal_accepted_on, te.state_accepted_on::text AS state_accepted_on, te.state_accepted_code,
              te.estimated_fee_min_cents, te.estimated_fee_max_cents, te.final_fee_cents,
              te.scope_creep_flag, te.complexity_score, te.extension_filed, te.filed_date, te.reopened_at, te.reopen_reason,
              e.contact_id, c.first_name, c.last_name,
              -- R108: a withdrawn return reads one line: the day and, on tap, the reason.
              ${WITHDRAWN_ON_SQL} AS withdrawn_on, ${WITHDRAWN_REASON_SQL} AS withdrawn_reason,
              -- R83: the return's checklist, as the Ops row reads it (null: no checklist).
              ck.docs_received, ck.docs_missing, ck.docs_total,
              -- R91: an open return from an accepted quote with no checklist yet (the backfill door applies).
              (ck.docs_total IS NULL AND te.stage::text NOT IN ('completed', 'withdrawn')
                AND EXISTS (SELECT 1 FROM engagement_scope_items s WHERE s.engagement_id = te.engagement_id AND s.source_quote_id IS NOT NULL AND (s.tax_year IS NULL OR s.tax_year = te.tax_year))) AS checklist_backfillable,
              -- R93: the day a return went overdue (derived deadline passed, not filed); null otherwise.
              CASE WHEN te.filed_date IS NULL AND te.stage::text NOT IN ('filed', 'completed', 'withdrawn')
                     AND COALESCE(te.extended_deadline, te.original_deadline) < $${todayParam}::date
                   THEN COALESCE(te.extended_deadline, te.original_deadline)::text END AS overdue_since
       FROM tax_engagements te
       JOIN engagements e ON e.id = te.engagement_id
       JOIN contacts c ON c.id = e.contact_id
       LEFT JOIN staff ptin ON ptin.id = te.preparer_ptin_holder_id
       LEFT JOIN documents f8 ON f8.id = te.f8879_document_id
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE i.status = 'received')::int AS docs_received,
                count(*) FILTER (WHERE i.status = 'pending')::int AS docs_missing,
                count(*)::int AS docs_total
           FROM document_requests dr JOIN document_request_items i ON i.request_id = dr.id
          WHERE dr.tax_engagement_id = te.id AND dr.source = 'checklist' AND dr.status <> 'cancelled'
         HAVING count(*) > 0
       ) ck ON true
       WHERE ${clauses.join(' AND ')}
       ORDER BY te.created_at DESC LIMIT 200`,
      params
    );
    return { taxEngagements: rows };
  });

  app.get<{ Params: { id: string } }>('/tax-engagements/:id', read, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const { rows } = await app.db.query(
      `SELECT te.*, te.f8879_signed_at::date::text AS f8879_signed_on, te.f8879_sent_on::text AS f8879_sent_on,
              ${chicagoDayOf('te.engagement_letter_signed_at')}::text AS engagement_letter_signed_on,
              f8.f8879_variant, f8.filename AS f8879_filename,
              e.contact_id, e.business_id, e.price_book_version_id, ptin.display_name AS preparer_of_record,
              sentby.display_name AS f8879_sent_recorded_by_name
       FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id
       LEFT JOIN staff ptin ON ptin.id = te.preparer_ptin_holder_id
       LEFT JOIN documents f8 ON f8.id = te.f8879_document_id
       LEFT JOIN staff sentby ON sentby.id = te.f8879_sent_recorded_by WHERE te.id = $1`,
      [id]
    );
    if (!rows[0]) throw new AppError(404, 'not_found', 'Tax engagement not found.');
    // THE WALL (phase 2, 2026-09-12): the complexity inputs are the return interview. interviews.read only.
    if (!holds(request.staff!, 'interviews.read')) delete (rows[0] as Record<string, unknown>).complexity_inputs;
    const history = await app.db.query(
      `SELECT h.stage, h.entered_at, h.changed_by_staff_id, h.waiting_on, h.note, s.display_name AS changed_by_name
       FROM engagement_stage_history h LEFT JOIN staff s ON s.id = h.changed_by_staff_id
       WHERE h.tax_engagement_id = $1 ORDER BY h.seq`, // the order written (0128), never the clock's
      [id]
    );
    /*
     * WHO DID EACH STEP, AND WHEN (R50, 2026-09-26). The stepper prints a check, the day and the person
     * on every done step; the return's columns hold the facts but not the hands. The audit rows on
     * this return do, so the ones that ARE a step come back as `activity`, oldest first, in the shape
     * the stepper reads (the action, the actor's name, the instant, the details). Names only, never
     * an address — actor_label is what the audit writer recorded.
     */
    const activity = await app.db.query<{ action: string; actor_label: string | null; at: Date; details: Record<string, unknown> }>(
      `SELECT action, actor_label, occurred_at AS at, details FROM audit_log
        WHERE object_type = 'tax_engagement' AND object_id = $1 AND action = ANY($2::text[])
        ORDER BY occurred_at, id`,
      [id, STEP_ACTIONS]
    );
    // The invoice the filing issued (or will have): the "paid" step reads its status and paid day.
    const invoice = await app.db.query<{ id: string; status: string; total_cents: number; paid_at: Date | null; sent_at: Date | null }>(
      `SELECT id, status::text AS status, total_cents, paid_at, sent_at FROM invoices
        WHERE tax_engagement_id = $1 AND status <> 'void' ORDER BY created_at DESC LIMIT 1`,
      [id]
    );
    /*
     * WHAT THE RETURN'S PAGE NEEDS TO OFFER THE RIGHT CONTROLS (Brian, 2026-09-19, item 2): the
     * legal next stage(s), the quoted range and the book version the final fee is read against,
     * whether a signed authorization is on file (told before the tap, refused at it), the
     * assigned preparer (the PTIN-holder default) and who may be the PTIN holder at all.
     */
    const te = rows[0] as {
      stage: TaxStage; engagement_id: string; tax_year: number; return_type: string; preparer_id: string | null;
      f8879_document_id: string | null; f8879_signed_at: Date | null;
      estimated_fee_min_cents: number | null; estimated_fee_max_cents: number | null;
    };
    const [quotedRange, jurisdictions, assigned, staffOptions, solePreparer, corrections] = await Promise.all([
      quotedRangeFor(app, te),
      // The Mark filed modal's jurisdiction list: what the address suggests, and what the return
      // already declares (Brian, 2026-09-19 evening, ruling 2).
      acceptanceStatus(app, id),
      te.preparer_id
        ? app.db.query<{ id: string; name: string }>(`SELECT id, display_name AS name FROM staff WHERE id = $1`, [te.preparer_id])
        : Promise.resolve({ rows: [] as Array<{ id: string; name: string }> }),
      // One list, two selects: who may hold the PTIN at filing, and who the return may be assigned
      // to (Brian, 2026-09-20). The same rule in both places, read from the roles table.
      app.db.query<{ id: string; name: string }>(
        `SELECT s.id, s.display_name AS name FROM staff s JOIN roles r ON r.id = s.role_id
          WHERE s.is_active AND r.key = ANY($1) ORDER BY s.display_name`,
        [PREPARER_ROLE_KEYS]
      ),
      // The firm's only tax preparer, when there is one: what the Assign preparer select opens on
      // for a return that has nobody yet.
      soleActiveTaxPreparerId(app),
      /*
       * THE FILING'S CORRECTIONS (Brian, 2026-09-26), oldest first: what moved, before and after, the
       * reason, who and when. The row prints each as "Corrected <field> on <day> by <who>: <reason>".
       * The actor is a name (actor_label), never an address.
       */
      app.db.query<{ id: string; fields: string[]; before: Record<string, unknown>; after: Record<string, unknown>; reason: string; actor_label: string; created_at: Date }>(
        `SELECT id, fields, before, after, reason, actor_label, created_at
           FROM tax_engagement_filing_corrections WHERE tax_engagement_id = $1 ORDER BY created_at, id`,
        [id]
      ),
    ]);
    const teRow = rows[0] as Record<string, unknown>;
    return {
      taxEngagement: rows[0],
      stageHistory: history.rows,
      filing_corrections: corrections.rows,
      /* R53: the 8879 sent for signature, or null; R50: who did each step, and the filing's invoice. */
      f8879_sent: f8879SentView(
        teRow as Parameters<typeof f8879SentView>[0],
        (teRow.f8879_sent_recorded_by_name as string | null) ?? null
      ),
      activity: activity.rows,
      final_fee_invoice: invoice.rows[0] ?? null,
      quoted_range: quotedRange,
      default_jurisdictions: jurisdictions.defaultJurisdictions,
      declared_jurisdictions: jurisdictions.declaredJurisdictions,
      jurisdictions_awaiting: jurisdictions.awaiting,
      /*
       * PAPER FILING (ruling 15): each declared jurisdiction with how it was filed and what has
       * answered for it — an acceptance date on an e-file row, a mailing on a paper one — so the row
       * can read "Mailed <date>" for paper and "Accepted <date>" for e-file and never the wrong one.
       * `default_filing_method` is the lane the YEAR implies: what the modal's per-jurisdiction
       * select opens on, derived here rather than re-derived in Ops.
       */
      jurisdictions: jurisdictions.rows,
      default_filing_method: jurisdictions.defaultFilingMethod,
      paper_awaiting_mailing: jurisdictions.paperAwaitingMailing,
      legal_next_stages: legalNextStages(te.stage),
      signed_authorization_on_file: Boolean(te.f8879_document_id && te.f8879_signed_at),
      assigned_preparer: assigned.rows[0] ?? null,
      sole_tax_preparer_id: solePreparer,
      staff_options: staffOptions.rows,
    };
  });

  app.post<{ Params: { id: string } }>('/tax-engagements/:id/transition', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = TransitionBody.parse(request.body);
    const result = await transitionStage(app, actorOf(request), id, b.toStage, {
      note: b.note, preparerPtinHolderId: b.preparerPtinHolderId, jurisdictions: b.jurisdictions,
      filingMethods: b.filingMethods, filedOn: b.filedOn, ...meta(request),
    });
    /*
     * "REQUEST DOCUMENTS" (R83): the press records that documents were asked for and sends the
     * missing items on the return's checklist, through its automation (seeded off). The answer says
     * which happened, so the Ops line never claims an email that was held.
     */
    if (b.toStage === 'documents_requested') {
      await app.db.query(`UPDATE tax_engagements SET docs_requested_at = COALESCE(docs_requested_at, now()) WHERE id = $1`, [id]);
      const { sendChecklistRequest } = await import('../documents/checklist.ts');
      const documentRequest = await sendChecklistRequest(app, { staffId: request.staff!.id }, id);
      return { status: 'ok', ...result, documentRequest };
    }
    return { status: 'ok', ...result };
  });

  /**
   * THE CHECKLIST BACKFILL (Brian, 2026-09-29, R91): an open return from a quote accepted before the
   * checklist existed gets one from its quoted lines, audited "Checklist added after the fact from the
   * accepted quote." The rules and refusals live in backfillChecklist (documents/checklist.ts).
   */
  app.post<{ Params: { id: string } }>('/tax-engagements/:id/checklist-backfill', manage, async (request, reply) => {
    const id = z.uuid().parse(request.params.id);
    const { backfillChecklist } = await import('../documents/checklist.ts');
    const out = await backfillChecklist(app, { id: request.staff!.id, fullName: request.staff!.fullName }, id);
    return reply.code(201).send({ status: 'ok', ...out });
  });

  /*
   * THE FILING, CORRECTED (Brian, 2026-09-26): the filed day, the PTIN holder and the declared
   * jurisdictions of a return at filed, appended as a correction with a standalone reason and then
   * reflected on the return. The rules and the refusals live in correctFiling (pipeline.ts); the
   * preparer offer goes through the assign door from there.
   */
  app.post<{ Params: { id: string } }>('/tax-engagements/:id/filing-corrections', manage, async (request, reply) => {
    const id = z.uuid().parse(request.params.id);
    const b = FilingCorrectionBody.parse(request.body);
    const out = await correctFiling(app, { ...actorOf(request), ...meta(request) }, id, {
      filedOn: b.filedOn, preparerPtinHolderId: b.preparerPtinHolderId, jurisdictions: b.jurisdictions,
      alsoAssignPreparer: b.alsoAssignPreparer, reason: b.reason,
      f8879SignedOn: b.f8879SignedOn, f8879DocumentId: b.f8879DocumentId, f8879Variant: b.f8879Variant,
    });
    return reply.code(201).send({ status: 'ok', ...out });
  });

  /**
   * REOPEN A COMPLETED RETURN (Brian, 2026-09-26, R67). The CEO alone (engagements.tax.reopen is
   * explicit-only: the wildcard does not reach it, and a preparer is refused 403 in the server's words).
   * The rules and the writes live in reopenCompletedReturn (pipeline.ts): back to filed, the engagement
   * active again, every jurisdiction needing a new acceptance or mailing before completion.
   */
  app.post<{ Params: { id: string } }>(
    '/tax-engagements/:id/reopen',
    { preHandler: [app.authenticate, requirePermission('engagements.tax.reopen')] },
    async (request) => {
      const id = z.uuid().parse(request.params.id);
      const b = ReopenBody.parse(request.body);
      const out = await reopenCompletedReturn(app, { ...actorOf(request), ...meta(request) }, id, b.reason);
      return { status: 'ok', ...out };
    }
  );

  /**
   * THE PAPER LANE'S ACCEPTANCE (Brian, 2026-09-20, ruling 15): the mailing of one declared paper
   * jurisdiction. A paper filing gets no acknowledgment — there is nothing to wait for — so the
   * recorded mailing is what satisfies the jurisdiction, and completion follows when it was the last
   * one the return waited on. The receipt scan is uploaded through /documents first (category
   * mailing_receipts) and arrives here as a document id; no bytes come through this route.
   */
  app.post<{ Params: { id: string; jurisdiction: string } }>(
    '/tax-engagements/:id/jurisdictions/:jurisdiction/mailing',
    manage,
    async (request) => {
      const id = z.uuid().parse(request.params.id);
      const jurisdiction = z.string().min(1).max(20).parse(request.params.jurisdiction);
      const b = z.object({
        mailedOn: z.iso.date(),
        method: z.enum(MAILING_METHODS),
        trackingNumber: z.string().max(60).optional(),
        receiptDocumentId: z.uuid().optional(),
        asOf: z.iso.date().optional(), // clock injection for tests
      }).parse(request.body);
      const out = await recordJurisdictionMailing(
        app,
        { staffId: request.staff!.id, label: request.staff!.fullName, ...meta(request) },
        id,
        jurisdiction,
        {
          mailedOn: b.mailedOn, method: b.method, trackingNumber: b.trackingNumber ?? null,
          receiptDocumentId: b.receiptDocumentId ?? null, today: b.asOf,
        }
      );
      return { status: 'ok', ...out };
    }
  );

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
    // R109: the lock names the price book it was locked under — the engagement's price lock (its accepted
    // quote's version) where there is one, otherwise the book in force today — and the label reads it after.
    const pinned = await app.db.query<{ id: string }>(`SELECT price_book_version_id AS id FROM engagements WHERE id = $1`, [te.engagement_id]);
    const versionId = pinned.rows[0]?.id ?? (await currentPriceBookVersion(app.db)).id;
    await app.db.query(
      `UPDATE tax_engagements
       SET estimated_fee_min_cents = $2, estimated_fee_max_cents = $3, estimate_locked_at = now(), estimate_price_book_version_id = $4
       WHERE id = $1`,
      [id, b.minCents, b.maxCents, versionId]
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
    // The fee is a step on the return (R50): who set it, to what, every time — the two rows below
    // still register the exceptional cases on the money line.
    await writeAudit(app.db, {
      actorType: 'staff', actorId: request.staff!.id, actorLabel: request.staff!.fullName,
      action: 'tax_engagement.final_fee_set', objectType: 'tax_engagement', objectId: id,
      contactId: te.contact_id, ...meta(request),
      details: { final_fee_cents: b.finalFeeCents, scope_creep: creep, outside_quoted_range: outside },
    });
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
    await loadTaxEngagement(app, id);

    if (b.type === 'f8879') {
      // 2026-09-12: the signed 8879 is the uploaded document. This route no longer stamps it.
      throw new AppError(410, 'f8879_is_an_upload', 'Upload the wet-signed, scanned 8879 to the return under Signed Authorizations, with the signed date and the preparer of record. That upload authorizes the return.');
    }
    /*
     * 2026-09-20: so is the engagement letter. A bare POST that stamped a compliance gate with
     * now() and no document behind it is the same claim the 8879 rule forbids — nothing on file,
     * nothing to read, no date the client actually signed. The client who signs in the portal is
     * stamped by that signature; the client who signs on paper is stamped by the scan.
     */
    throw new AppError(
      410,
      'engagement_letter_is_an_upload',
      'Upload the signed, scanned engagement letter to the return under Signed Authorizations, with the date the client signed it. That upload stamps the letter on the return; a client who signed the packet in the portal is stamped by that signature.'
    );
  });

  /*
   * WHO PREPARES THIS RETURN (Brian, 2026-09-20). A return assigned to nobody sits in no queue: it
   * is on no My Tasks, no owner rollup asks after it, and the first person to notice is the client.
   * The row names a preparer, and preparation cannot start until it does (pipeline gate 2b).
   *
   * Assignable: an ACTIVE staff member holding tax_preparer, or the CEO working a return himself —
   * the same set the PTIN-holder select offers, refused by name and role rather than by silence.
   */
  app.post<{ Params: { id: string } }>('/tax-engagements/:id/preparer', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = AssignPreparerBody.parse(request.body);
    // The door itself is assignPreparer (pipeline.ts): the filing correction's preparer offer takes the same one.
    const preparer = await assignPreparer(app, { ...actorOf(request), ...meta(request) }, id, b.staffId);
    return { status: 'ok', preparer };
  });

  /*
   * RECORD 8879 SENT (Brian, 2026-09-26, R53). Under engagements.tax.manage, the same permission as
   * every other control on the row. The method and the day; the door in f8879-sent.ts holds the
   * rules and refuses in words the modal renders beside the field. Nothing is sent from here.
   */
  app.post<{ Params: { id: string } }>('/tax-engagements/:id/8879-sent', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = F8879SentBody.parse(request.body);
    const recorded = await record8879Sent(app, { ...actorOf(request), ...meta(request) }, id, { method: b.method, sentOn: b.sentOn });
    return { status: 'ok', f8879_sent: recorded };
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
