// Tax pipeline state machine (MP Tax Operations → Pipeline).
//
// GATES ENFORCED IN CODE (MP automations 7–8 — never convention):
//   1. Engagement letter signed  → required to advance PAST 'scheduled'
//   2. Estimated fee locked      → required to enter 'in_preparation'
//   3. Form 8879 signed          → required to enter 'filed'
// on_hold / withdrawn are always reachable; resuming from on_hold re-applies
// every gate. The parallel "Extended" state lives on extension_filed (M8),
// not in this stage enum.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { withTransaction } from '../../db.ts';
import { AppError } from '../../types.ts';
import { alertRecipientForRole, firstActiveByRole, notifyOnce } from '../../staffing.ts';
import { closeTasksForSource, createTask } from '../tasks/service.ts';
import { addDays, daysBetween, todayChicago, calendarDay } from './deadlines.ts';
import { certifiedMailFollowUp, filingLane } from './resolution.ts';
import { invoiceForFiledEngagement } from '../billing/service.ts';

export const TAX_STAGES = [
  'intake_started', 'scheduled', 'documents_requested', 'pending_client_response',
  'in_preparation', 'internal_review', 'client_review', 'ready_to_file',
  'filed', 'rejected', 'completed', 'on_hold', 'withdrawn',
] as const;
export type TaxStage = (typeof TAX_STAGES)[number];

const ORDER: Partial<Record<TaxStage, number>> = {
  intake_started: 0, scheduled: 1, documents_requested: 2, pending_client_response: 3,
  in_preparation: 4, internal_review: 5, client_review: 6, ready_to_file: 7,
  filed: 8, rejected: 8, completed: 9,
};

const RESUMABLE: TaxStage[] = [
  'scheduled', 'documents_requested', 'pending_client_response', 'in_preparation',
  'internal_review', 'client_review', 'ready_to_file',
];

/** Forward/backward moves allowed from each stage (before gates). */
export const TRANSITIONS: Record<TaxStage, TaxStage[]> = {
  intake_started: ['scheduled'],
  scheduled: ['documents_requested'],
  documents_requested: ['pending_client_response', 'in_preparation'],
  pending_client_response: ['documents_requested', 'in_preparation'],
  in_preparation: ['documents_requested', 'pending_client_response', 'internal_review'],
  internal_review: ['in_preparation', 'client_review'],
  client_review: ['in_preparation', 'ready_to_file'],
  ready_to_file: ['client_review', 'filed'],
  // v4.3 flow 1: Filed is NOT terminal — acceptance completes it, a reject
  // re-queues it. From rejected the fix path is re-file (ready_to_file) or
  // back into preparation for a substantive fix.
  filed: ['completed', 'rejected'],
  rejected: ['ready_to_file', 'in_preparation'],
  completed: [],
  on_hold: RESUMABLE,
  withdrawn: [],
};

/**
 * THE LEGAL NEXT STAGE(S), FORWARD ONLY (Brian, 2026-09-19, item 2): the return's page offers
 * exactly these and nothing else. Read from TRANSITIONS, minus the backward moves (send back to
 * preparation, back to the client) and minus on_hold / withdrawn, which are not "next". The one
 * exception is the re-file path: from 'rejected', ready_to_file is the fix, not a step back.
 * Gates (letter, estimate lock, 8879, PTIN holder) still apply when the move is attempted.
 */
export function legalNextStages(from: TaxStage): TaxStage[] {
  const here = ORDER[from];
  if (here === undefined) return []; // on_hold / withdrawn: resumed by the API, not from the card
  return (TRANSITIONS[from] ?? []).filter((to) => {
    const there = ORDER[to];
    if (there === undefined) return false;
    if (from === 'rejected' && to === 'ready_to_file') return true;
    return there > here;
  });
}

/** Stages where the ball is in the client's court (delay attribution). */
const CLIENT_COURT: TaxStage[] = ['pending_client_response', 'client_review'];

interface GateRow {
  id: string;
  stage: TaxStage;
  engagement_letter_signed_at: Date | null;
  f8879_signed_at: Date | null;
  f8879_document_id: string | null;
  estimate_locked_at: Date | null;
  preparer_id: string | null;
  filed_date: string | null;
  contact_id: string;
}

/*
 * WHAT A NEW RETURN ALREADY HOLDS (Brian, 2026-09-20).
 *
 * Two things a return used to start without and somebody had to remember:
 *
 *   THE ENGAGEMENT LETTER. The client signs the packet in the portal once; that signature covers
 *   the relationship, so every return under it is covered and a return opened next week is covered
 *   too. It used to cover none of them on the return record — the packet set the contact's status
 *   and pipeline gate 1 reads the RETURN's timestamp, so the first move past Scheduled was blocked
 *   on a letter the client had already signed. A return created while the letter stands inherits
 *   the stamp here.
 *
 *   THE PREPARER. A firm with one tax preparer has one answer to "who prepares this", and asking
 *   is ceremony. When exactly one active tax preparer exists, a new return gets them. Two or more
 *   and nothing is guessed: the return starts with no preparer and the preparation gate below says
 *   so at the moment it matters.
 *
 * Called by both creation paths — the staff route and quote acceptance — right after the row
 * exists, so neither can drift from the other.
 */

/** The roles a return may be assigned to: a tax preparer, or the CEO working a return himself. */
export const PREPARER_ROLE_KEYS = ['tax_preparer', 'ceo'] as const;

/**
 * THE LETTER STANDS. `contacts.engagement_letter_status` is the one flag every gate already reads,
 * and 'signed' is the only value that means signed: the enum has no superseded state and no path
 * voids a signature once it is recorded (a signed packet refuses void; a change order withdraws
 * the ENGAGEMENT, not the Master). So a status that is anything but 'signed' inherits nothing.
 */
export async function engagementLetterStands(app: FastifyInstance, contactId: string): Promise<boolean> {
  const { rows } = await app.db.query<{ status: string }>(
    `SELECT engagement_letter_status::text AS status FROM contacts WHERE id = $1`,
    [contactId]
  );
  return rows[0]?.status === 'signed';
}

/** The single active tax preparer, when there is exactly one; null when there are none or several. */
export async function soleActiveTaxPreparerId(app: FastifyInstance): Promise<string | null> {
  const { rows } = await app.db.query<{ id: string }>(
    `SELECT s.id FROM staff s JOIN roles r ON r.id = s.role_id
      WHERE s.is_active AND r.key = 'tax_preparer' ORDER BY s.id LIMIT 2`
  );
  return rows.length === 1 ? rows[0]!.id : null;
}

/**
 * Stamp a just-created return with what it already holds: the standing engagement letter, and the
 * firm's only tax preparer when there is only one. Neither overwrites a value the caller set.
 */
export async function applyNewReturnDefaults(
  app: FastifyInstance,
  taxEngagementId: string,
  contactId: string
): Promise<{ engagementLetterInherited: boolean; preparerId: string | null }> {
  const inherit = await engagementLetterStands(app, contactId);
  if (inherit) {
    await app.db.query(
      `UPDATE tax_engagements SET engagement_letter_signed_at = COALESCE(engagement_letter_signed_at, now()) WHERE id = $1`,
      [taxEngagementId]
    );
  }
  const sole = await soleActiveTaxPreparerId(app);
  if (sole) {
    await app.db.query(
      `UPDATE tax_engagements SET preparer_id = COALESCE(preparer_id, $2) WHERE id = $1`,
      [taxEngagementId, sole]
    );
  }
  const { rows } = await app.db.query<{ preparer_id: string | null }>(
    `SELECT preparer_id FROM tax_engagements WHERE id = $1`,
    [taxEngagementId]
  );
  return { engagementLetterInherited: inherit, preparerId: rows[0]?.preparer_id ?? null };
}

/**
 * THE LETTER THE CLIENT ALREADY SIGNED, ON EVERY RETURN IT COVERS (Brian, 2026-09-20). One packet
 * signature, N returns: the stamp lands on every tax return belonging to the signing CONTACT that
 * does not already carry one. Keyed on the contact and not on an engagement id because that is
 * what the packet is scoped to — `engagement_packets` carries contact_id and schedule codes, never
 * an engagement — and the Master it executes is the agreement with the client, which every
 * engagement of theirs incorporates. Returns the ids stamped so the caller can record them.
 */
export async function stampEngagementLetterOnContactReturns(
  app: FastifyInstance,
  contactId: string
): Promise<string[]> {
  const { rows } = await app.db.query<{ id: string }>(
    `UPDATE tax_engagements te
        SET engagement_letter_signed_at = now()
       FROM engagements e
      WHERE e.id = te.engagement_id
        AND e.contact_id = $1
        AND te.engagement_letter_signed_at IS NULL
      RETURNING te.id`,
    [contactId]
  );
  return rows.map((r) => r.id);
}

export async function transitionStage(
  app: FastifyInstance,
  actor: { staffId: string | null; label: string },
  taxEngagementId: string,
  toStage: TaxStage,
  opts: {
    note?: string | undefined; ip?: string | null; userAgent?: string | null; preparerPtinHolderId?: string | undefined;
    /** Only read at 'filed': the jurisdictions this return declares (federal plus states). */
    jurisdictions?: readonly string[] | undefined;
    /**
     * Only read at 'filed': how each declared jurisdiction was filed, e-file or paper (R15). What
     * the modal's per-jurisdiction select sends. A jurisdiction left out takes the lane the return's
     * YEAR implies, which is the answer for every return that is not a mixed filing.
     */
    filingMethods?: Readonly<Record<string, FilingMethod>> | undefined;
  } = {}
): Promise<{ from: TaxStage; to: TaxStage; jurisdictions?: string[] }> {
  const { rows } = await app.db.query<GateRow>(
    `SELECT te.id, te.stage, te.engagement_letter_signed_at, te.f8879_signed_at, te.f8879_document_id,
            te.estimate_locked_at, te.preparer_id, te.filed_date, e.contact_id
     FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id
     WHERE te.id = $1`,
    [taxEngagementId]
  );
  const row = rows[0];
  if (!row) throw new AppError(404, 'not_found', 'Tax engagement not found.');
  const from = row.stage;

  const allowed =
    toStage === 'on_hold' || toStage === 'withdrawn'
      ? from !== 'completed' && from !== 'withdrawn' && from !== toStage
      : TRANSITIONS[from]?.includes(toStage) ?? false;
  if (!allowed) {
    throw new AppError(409, 'invalid_transition', `Cannot move from '${from}' to '${toStage}'.`);
  }

  // Gate 1 — engagement letter blocks everything past 'scheduled'.
  const targetOrder = ORDER[toStage];
  if (targetOrder !== undefined && targetOrder > ORDER.scheduled! && !row.engagement_letter_signed_at) {
    throw new AppError(
      409,
      'engagement_letter_required',
      'Blocked: the engagement letter is not signed. Work cannot advance past Scheduled until it is (MP compliance gate).'
    );
  }
  // Gate 2 — estimate locked unlocks preparation (automation 8).
  if (toStage === 'in_preparation' && !row.estimate_locked_at) {
    throw new AppError(
      409,
      'estimate_lock_required',
      'Blocked: the estimated fee range is not locked. Lock the estimate to unlock preparation (automation 8).'
    );
  }
  /*
   * Gate 2b — A RETURN IS PREPARED BY A PERSON (Brian, 2026-09-20). Preparation starting with
   * nobody assigned is how a return sits in a queue that belongs to no one: it appears on no My
   * Tasks, no owner rollup asks after it, and the first person to notice is the client. Named
   * before the work starts, not after it is late.
   */
  if (toStage === 'in_preparation' && !row.preparer_id) {
    throw new AppError(
      409,
      'preparer_required',
      'Blocked: no preparer is assigned to this return. Assign the preparer before preparation starts, so the work sits in somebody\'s queue.'
    );
  }
  // Gate 3 — no return files without a signed 8879 ON FILE: the uploaded scan, not a timestamp (2026-09-12).
  if (toStage === 'filed' && (!row.f8879_signed_at || !row.f8879_document_id)) {
    throw new AppError(
      409,
      'f8879_required',
      'Blocked: Form 8879 e-file authorization is not signed. No return is filed without it (MP compliance gate).'
    );
  }

  /*
   * THE PREPARER OF RECORD (2026-09-12, Brian's correction). A return does not move to filed
   * without naming whose PTIN is on it. Set once, here, by the person filing; the database
   * refuses any later change. A return re-filed after a rejection keeps the holder it had.
   */
  if (toStage === 'filed') {
    const held = await app.db.query<{ preparer_ptin_holder_id: string | null }>(
      `SELECT preparer_ptin_holder_id FROM tax_engagements WHERE id = $1`, [taxEngagementId]);
    if (!held.rows[0]?.preparer_ptin_holder_id && !opts.preparerPtinHolderId) {
      throw new AppError(
        409,
        'preparer_of_record_required',
        'Blocked: say whose PTIN is on this filing (the paid preparer of record) before marking it filed.'
      );
    }
    // Validated before anything is written: a bad list must not leave the return filed with the
    // wrong jurisdictions declared, or filed with none.
    const list = opts.jurisdictions ? assertJurisdictions(opts.jurisdictions) : null;
    if (opts.filingMethods) assertFilingMethods(opts.filingMethods, list);
  }
  await app.db.query(
    `UPDATE tax_engagements
     SET stage = $2::tax_stage,
         filed_date = CASE WHEN $2 = 'filed' THEN COALESCE(filed_date, CURRENT_DATE) ELSE filed_date END,
         preparer_ptin_holder_id = CASE WHEN $2 = 'filed' THEN COALESCE(preparer_ptin_holder_id, $3::uuid) ELSE preparer_ptin_holder_id END
     WHERE id = $1`,
    [taxEngagementId, toStage, opts.preparerPtinHolderId ?? null]
  );
  /*
   * THE JURISDICTIONS ARE DECLARED WITH THE FILING (Brian, 2026-09-19 evening, ruling 2). The
   * return says where it went, in the preparer's words, at the moment it went — not derived from an
   * address afterwards. Completion then reads the list (acceptanceStatus).
   */
  const declared =
    toStage === 'filed' ? await declareJurisdictions(app, taxEngagementId, opts.jurisdictions, opts.filingMethods) : null;
  await app.db.query(
    `INSERT INTO engagement_stage_history (tax_engagement_id, stage, changed_by_staff_id, waiting_on, note)
     VALUES ($1, $2::tax_stage, $3, $4::waiting_on, $5)`,
    [
      taxEngagementId,
      toStage,
      actor.staffId,
      CLIENT_COURT.includes(toStage) ? 'client' : 'staff',
      opts.note ?? null,
    ]
  );
  await writeAudit(app.db, {
    actorType: actor.staffId ? 'staff' : 'system',
    actorId: actor.staffId,
    actorLabel: actor.label,
    action: 'tax_engagement.stage_changed',
    objectType: 'tax_engagement',
    objectId: taxEngagementId,
    contactId: row.contact_id,
    ip: opts.ip,
    userAgent: opts.userAgent,
    details: { from, to: toStage, ...(declared ? { jurisdictions: declared } : {}) },
  });

  // Automation 12: Filed → invoice generated (or an exception to Rene when
  // the final fee is missing — never a silent skip). Re-files after a reject
  // don't re-invoice (COALESCE(filed_date) keeps the original date; the
  // invoice hook is idempotent per engagement via its own dedupe).
  if (toStage === 'filed') {
    await invoiceForFiledEngagement(app, actor, taxEngagementId);
    // Re-queue resolved: reaching 'filed' with a perfection clock running
    // means the reject was fixed (path is rejected → ready_to_file → filed,
    // so check the clock, not the immediate `from`). Task closes with it.
    const cleared = await app.db.query(
      `UPDATE tax_engagements SET perfection_deadline = NULL WHERE id = $1 AND perfection_deadline IS NOT NULL`,
      [taxEngagementId]
    );
    if ((cleared.rowCount ?? 0) > 0) {
      await closeTasksForSource(app, 'efile_reject', taxEngagementId, 're-filed within the perfection window');
    }
  }

  return { from, to: toStage, ...(declared ? { jurisdictions: declared } : {}) };
}

// ── v4.3 flow 1: e-file acceptance / rejection ──────────────────────────────

/** Individual returns get 5 perfection days; business returns get 10. */
export function perfectionDays(returnType: string): number {
  return returnType === '1040' || returnType === '1040_expat' ? 5 : 10;
}

/**
 * THE NINE STATES THAT LEVY NO INCOME TAX (Brian, 2026-09-19 evening, ruling 2). A client in one
 * of them has no state return to wait on, so the DEFAULT declared list there is federal alone.
 * A default, not a rule: a preparer who really does file in one of them adds it in the modal.
 */
export const NO_INCOME_TAX_STATES: ReadonlySet<string> = new Set(['AK', 'FL', 'NV', 'NH', 'SD', 'TN', 'TX', 'WA', 'WY']);

/** Federal always, plus the state an address suggests — unless that state levies no income tax. */
export function defaultJurisdictions(state: string | null | undefined): string[] {
  const s = normaliseState(state);
  return s && !NO_INCOME_TAX_STATES.has(s) ? ['federal', s] : ['federal'];
}

/**
 * A declared list, validated and put in canonical order: federal is on it, every other entry is a
 * two-letter upper-case state code, nothing appears twice, and the result reads federal first then
 * the states alphabetically — the order acceptanceStatus reads and every note prints. One place, so
 * the route and a direct caller are refused in the same words.
 */
export function assertJurisdictions(raw: readonly string[]): string[] {
  const list = raw.map((s) => s.trim());
  for (const j of list) {
    if (j !== 'federal' && !/^[A-Z]{2}$/.test(j)) {
      throw new AppError(400, 'jurisdiction_invalid', `'${j}' is not a jurisdiction: say 'federal' or a two-letter state code in upper case (IL, WI).`);
    }
  }
  if (!list.includes('federal')) {
    throw new AppError(400, 'federal_jurisdiction_required', 'Every return files federally: federal stays on the jurisdiction list.');
  }
  const twice = [...new Set(list.filter((j, i) => list.indexOf(j) !== i))];
  if (twice.length > 0) {
    throw new AppError(400, 'jurisdiction_duplicated', `${twice.join(', ')} is on the list twice; each jurisdiction appears once.`);
  }
  return ['federal', ...list.filter((j) => j !== 'federal').sort()];
}

/*
 * ═══ PAPER FILING (Brian, 2026-09-20, ruling 15) ════════════════════════════════════════════════
 *
 * HOW a jurisdiction was filed is a property of the jurisdiction, not of the return. One return
 * goes to the IRS electronically and to a state on paper, because that state will not take it any
 * other way; the return has one filing and two methods.
 *
 * And the two methods are satisfied by DIFFERENT FACTS. An e-file jurisdiction is satisfied by an
 * acknowledgment. A paper one never gets an acknowledgment — there is nothing to wait for and no
 * date that will ever arrive — so it is satisfied by a recorded MAILING: the day it went out, how
 * it went, and the tracking or the receipt where those exist. Before this, a return declared on
 * paper waited forever on an acceptance that does not exist, which is the same defect ruling 2
 * removed for the no-income-tax states, one lane over.
 */

/** How a jurisdiction was filed. Derived from the year by default (filingLane), settable per row. */
export const FILING_METHODS = ['efile', 'paper'] as const;
export type FilingMethod = (typeof FILING_METHODS)[number];

/** What was actually done with a paper filing, in the words the preparer would use. */
export const MAILING_METHODS = ['certified', 'first_class', 'hand_delivered', 'mailed_by_client'] as const;
export type MailingMethod = (typeof MAILING_METHODS)[number];

/** Only a certified mailing is chased: it has tracking, so there is something to check. */
export const CHASED_MAILING_METHOD: MailingMethod = 'certified';

/**
 * The per-jurisdiction methods a filing declares, validated against the list it declares them for.
 * A method for a jurisdiction that is not on the list is refused rather than dropped: the preparer
 * said something about a jurisdiction this return does not file in, and silently ignoring it is how
 * a mixed filing ends up recorded as all-electronic.
 */
export function assertFilingMethods(
  methods: Readonly<Record<string, FilingMethod>>,
  jurisdictions: readonly string[] | null
): Record<string, FilingMethod> {
  const out: Record<string, FilingMethod> = {};
  for (const [raw, method] of Object.entries(methods)) {
    const jurisdiction = raw === 'federal' ? 'federal' : raw.trim().toUpperCase();
    if (!(FILING_METHODS as readonly string[]).includes(method)) {
      throw new AppError(400, 'filing_method_invalid', `'${method}' is not a filing method: say 'efile' or 'paper'.`);
    }
    if (jurisdictions && !jurisdictions.includes(jurisdiction)) {
      throw new AppError(
        400,
        'filing_method_undeclared_jurisdiction',
        `${jurisdiction} carries a filing method but is not on the jurisdiction list (${jurisdictions.join(', ')}). Declare it, or drop the method.`
      );
    }
    out[jurisdiction] = method;
  }
  return out;
}

/** One declared jurisdiction, with how it was filed and what has answered for it. */
export interface DeclaredJurisdiction {
  jurisdiction: string;
  filingMethod: FilingMethod;
  acceptedOn: string | null;
  mailedOn: string | null;
  mailingMethod: MailingMethod | null;
  trackingNumber: string | null;
  receiptDocumentId: string | null;
}

export interface AcceptanceStatus {
  /** What the address suggests, before the preparer edits it. */
  defaultJurisdictions: string[];
  /** What the return actually declares — empty until it is filed. */
  declaredJurisdictions: string[];
  /** What completion is measured against: the declared list, or the defaults while nothing is declared. */
  expected: string[];
  /** The e-file acceptances: a jurisdiction that ACKNOWLEDGED. A paper row is never in here. */
  accepted: string[];
  /** What has answered at all: an acceptance on an e-file row, a recorded mailing on a paper one. */
  satisfied: string[];
  awaiting: string[];
  /** The declared rows in canonical order, each with its method and its dates. */
  rows: DeclaredJurisdiction[];
  /** The lane the return's YEAR implies: what an undeclared method falls back to, and what the modal opens on. */
  defaultFilingMethod: FilingMethod;
  /** Declared on paper with no mailing recorded — each one needs a Record mailing before completion. */
  paperAwaitingMailing: string[];
  /** Compatibility: the summary columns every other reader still uses. */
  federalAcceptedOn: string | null;
  stateAcceptedOn: string | null;
  stateAcceptedCode: string | null;
}

/**
 * WHICH JURISDICTIONS A RETURN FILES IN, AND WHICH HAVE NOT ACCEPTED YET.
 *
 * (Brian, 2026-09-19 item 4): "the engagement completes when every jurisdiction row on the return
 * is accepted, not on federal alone." (Brian, 2026-09-19 evening, ruling 2): and the jurisdictions
 * are DECLARED on the return, not guessed from an address — one client can file in two states, and
 * a client in Texas files in none.
 *
 * Expected = the rows in tax_engagement_jurisdictions. Until the return is filed there are none,
 * and the defaults stand in: federal plus the entity's state on a business return
 * (engagements.business_id → businesses.state), the contact's otherwise, minus the no-income-tax
 * states. That fallback is what keeps a return filed before this shipped — or forced to 'filed' by
 * a fixture that never went through the transition — reading exactly as it did.
 *
 * Accepted = accepted_on per declared row; on the fallback path, the summary columns
 * (federal_accepted_on, and state_accepted_on when state_accepted_code is an expected state).
 * An acknowledgment for a jurisdiction the return does not declare is never counted — it is
 * surfaced for review instead (see ingestReport).
 *
 * SATISFIED, NOT ACCEPTED (Brian, 2026-09-20, ruling 15). A PAPER jurisdiction has no
 * acknowledgment to wait for, so what satisfies it is a recorded mailing. `accepted` stays what it
 * says — the e-file acknowledgments — and `awaiting` is measured against `satisfied`, which is the
 * acceptance on an e-file row and the mailing on a paper one. A paper row is never reported as
 * accepted anywhere, because nobody accepted anything.
 */
export async function acceptanceStatus(
  app: FastifyInstance,
  taxEngagementId: string
): Promise<AcceptanceStatus> {
  const { rows } = await app.db.query<{
    tax_year: number;
    federal_accepted_on: string | null; state_accepted_on: string | null; state_accepted_code: string | null; derived_state: string | null;
  }>(
    `SELECT te.tax_year, te.federal_accepted_on::text AS federal_accepted_on, te.state_accepted_on::text AS state_accepted_on, te.state_accepted_code,
            CASE WHEN e.business_id IS NOT NULL THEN b.state ELSE c.state END AS derived_state
       FROM tax_engagements te
       JOIN engagements e ON e.id = te.engagement_id
       JOIN contacts c ON c.id = e.contact_id
       LEFT JOIN businesses b ON b.id = e.business_id
      WHERE te.id = $1`,
    [taxEngagementId]
  );
  const r = rows[0];
  if (!r) throw new AppError(404, 'not_found', 'Tax engagement not found.');
  const defaults = defaultJurisdictions(r.derived_state);
  /*
   * THE LANE THE YEAR IMPLIES. filingLane is the authority (CLAUDE.md: the filing method DERIVES
   * from the year, staff never pick the lane) and a row that says nothing reads as that lane rather
   * than as e-file — a 2021 return whose row was written by anything but the filing route must not
   * claim a lane 2021 cannot use.
   */
  const defaultFilingMethod: FilingMethod = filingLane(r.tax_year);
  // Federal first, then the states alphabetically: the order the modal and every note read in.
  const decl = await app.db.query<{
    jurisdiction: string; accepted_on: string | null; filing_method: string | null;
    mailed_on: string | null; mailing_method: string | null; tracking_number: string | null; receipt_document_id: string | null;
  }>(
    `SELECT jurisdiction, accepted_on::text AS accepted_on, filing_method,
            mailed_on::text AS mailed_on, mailing_method, tracking_number, receipt_document_id
       FROM tax_engagement_jurisdictions
      WHERE tax_engagement_id = $1 ORDER BY (jurisdiction <> 'federal'), jurisdiction`,
    [taxEngagementId]
  );
  const declared: DeclaredJurisdiction[] = decl.rows.map((d) => ({
    jurisdiction: d.jurisdiction,
    filingMethod: (d.filing_method as FilingMethod | null) ?? defaultFilingMethod,
    acceptedOn: d.accepted_on,
    mailedOn: d.mailed_on,
    mailingMethod: d.mailing_method as MailingMethod | null,
    trackingNumber: d.tracking_number,
    receiptDocumentId: d.receipt_document_id,
  }));
  const declaredJurisdictions = declared.map((d) => d.jurisdiction);
  const expected = declaredJurisdictions.length > 0 ? declaredJurisdictions : defaults;
  const stateCode = normaliseState(r.state_accepted_code);
  const summaryAccepted = [
    ...(r.federal_accepted_on ? ['federal'] : []),
    ...(r.state_accepted_on && stateCode && expected.includes(stateCode) ? [stateCode] : []),
  ];
  const accepted =
    declaredJurisdictions.length > 0 ? declared.filter((d) => d.acceptedOn).map((d) => d.jurisdiction) : summaryAccepted;
  const satisfied =
    declaredJurisdictions.length > 0
      ? declared
          .filter((d) => (d.filingMethod === 'paper' ? d.mailedOn !== null : d.acceptedOn !== null))
          .map((d) => d.jurisdiction)
      : summaryAccepted;
  const awaiting = expected.filter((j) => !satisfied.includes(j));
  return {
    defaultJurisdictions: defaults,
    declaredJurisdictions,
    expected,
    accepted,
    satisfied,
    awaiting,
    rows: declared,
    defaultFilingMethod,
    paperAwaitingMailing: declared.filter((d) => d.filingMethod === 'paper' && !d.mailedOn).map((d) => d.jurisdiction),
    federalAcceptedOn: r.federal_accepted_on,
    stateAcceptedOn: r.state_accepted_on,
    stateAcceptedCode: r.state_accepted_code,
  };
}

/** The jurisdictions this return still waits on; empty when it is accepted everywhere it files. */
export async function jurisdictionsAwaiting(app: FastifyInstance, taxEngagementId: string): Promise<string[]> {
  return (await acceptanceStatus(app, taxEngagementId)).awaiting;
}

/**
 * Record that ONE jurisdiction accepted, and say whether it was this return's to record.
 *
 * Two ways it is not. `not_declared`: the jurisdiction is not on the return's list. `paper`
 * (Brian, 2026-09-20, ruling 15): it IS on the list and it was filed on paper, so there is no
 * acknowledgment for it and an ack row claiming one is about some other return or some other
 * filing. Either way nothing is stamped and the caller surfaces the row for a person rather than
 * filing it away quietly.
 *
 * The summary columns on tax_engagements are written beside the row — the FIRST state to accept
 * fills the state pair — so every existing reader keeps working (migration 0104).
 */
export type StampResult = { ok: true } | { ok: false; reason: 'not_declared' | 'paper' };

export async function stampJurisdictionAccepted(
  app: FastifyInstance,
  taxEngagementId: string,
  jurisdiction: string,
  acceptedOn: string | null,
  submissionId: string | null = null
): Promise<StampResult> {
  const status = await acceptanceStatus(app, taxEngagementId);
  if (!status.expected.includes(jurisdiction)) return { ok: false, reason: 'not_declared' };
  if (status.rows.find((d) => d.jurisdiction === jurisdiction)?.filingMethod === 'paper') {
    return { ok: false, reason: 'paper' };
  }
  if (status.declaredJurisdictions.length > 0) {
    await app.db.query(
      `UPDATE tax_engagement_jurisdictions
          SET accepted_on = COALESCE(accepted_on, $3::date, CURRENT_DATE),
              submission_id = COALESCE(submission_id, $4)
        WHERE tax_engagement_id = $1 AND jurisdiction = $2`,
      [taxEngagementId, jurisdiction, acceptedOn, submissionId]
    );
  }
  if (jurisdiction === 'federal') {
    await app.db.query(
      `UPDATE tax_engagements SET federal_accepted_on = COALESCE(federal_accepted_on, $2::date, CURRENT_DATE) WHERE id = $1`,
      [taxEngagementId, acceptedOn]
    );
  } else {
    await app.db.query(
      `UPDATE tax_engagements
          SET state_accepted_on = COALESCE(state_accepted_on, $2::date, CURRENT_DATE),
              state_accepted_code = COALESCE(state_accepted_code, $3)
        WHERE id = $1`,
      [taxEngagementId, acceptedOn, jurisdiction]
    );
  }
  return { ok: true };
}

/**
 * The list the return declares from this filing onward. An explicit list is validated and becomes
 * the list — a jurisdiction the preparer removed on a re-file goes away unless it has already
 * accepted, because an acceptance is a fact and not a preference. No list means: keep what is
 * already declared, or take the defaults on the first filing.
 *
 * EACH ROW ALSO SAYS HOW IT WAS FILED (ruling 15). The method comes from the preparer when the
 * modal sent one for that jurisdiction, and from the YEAR otherwise — never from nothing, so no row
 * this route writes leaves the lane to be guessed later. A method already on the row is not
 * overwritten by a re-file that says nothing about it, and IS overwritten when the preparer says
 * something: a return that went out on paper and is re-filed electronically changed lane, and the
 * row is the record of the latest filing.
 */
async function declareJurisdictions(
  app: FastifyInstance,
  taxEngagementId: string,
  requested: readonly string[] | undefined,
  methods: Readonly<Record<string, FilingMethod>> | undefined
): Promise<string[]> {
  const status = await acceptanceStatus(app, taxEngagementId);
  const list = requested
    ? assertJurisdictions(requested)
    : status.declaredJurisdictions.length > 0
      ? status.declaredJurisdictions
      : status.defaultJurisdictions;
  const said = methods ? assertFilingMethods(methods, list) : {};
  for (const jurisdiction of list) {
    const method: FilingMethod = said[jurisdiction] ?? status.defaultFilingMethod;
    await app.db.query(
      `INSERT INTO tax_engagement_jurisdictions (tax_engagement_id, jurisdiction, filing_method) VALUES ($1, $2, $3)
       ON CONFLICT (tax_engagement_id, jurisdiction)
         DO UPDATE SET filing_method = CASE WHEN $4 THEN $3 ELSE COALESCE(tax_engagement_jurisdictions.filing_method, $3) END`,
      [taxEngagementId, jurisdiction, method, said[jurisdiction] !== undefined]
    );
  }
  if (requested) {
    await app.db.query(
      `DELETE FROM tax_engagement_jurisdictions
        WHERE tax_engagement_id = $1 AND accepted_on IS NULL AND NOT (jurisdiction = ANY($2::text[]))`,
      [taxEngagementId, list]
    );
  }
  return list;
}

/** The state a return files in, as the acknowledgment report spells it: two upper-case letters, or nothing. */
export function normaliseState(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().toUpperCase();
  return v ? v : null;
}

/**
 * NOTHING POSTS AN E-FILE RESULT FOR A PAPER JURISDICTION (ruling 15) — one refusal, in one
 * wording, for the manual door and for anything else that tries. The ATX ingest does not raise it:
 * a report row is surfaced for review instead of refused, because the report is a file somebody
 * uploaded whole and a single bad row must not reject the rest of it.
 */
export function paperJurisdictionRefusal(jurisdiction: string): AppError {
  return new AppError(
    409,
    'jurisdiction_is_paper',
    `${jurisdiction} was filed on paper on this return, so there is no e-file acknowledgment for it — ` +
      'record the mailing instead. If it really went electronically, change its filing method on the return first.'
  );
}

/**
 * THE RETURN IS FINISHED WHEN NOTHING IS AWAITED — whichever fact finished it.
 *
 * Extracted because there are now two: the last acknowledgment, and the last MAILING. A paper
 * jurisdiction is satisfied by its mailing (ruling 15), so a return declared federal-e-file plus
 * IL-paper completes on the federal ack when IL is already mailed, and on the IL mailing when the
 * federal ack came first. Both paths must do the same three things or the two orders leave the
 * record telling different stories.
 *
 * `efile_accepted_at` is stamped ONLY when an e-file jurisdiction actually accepted. A return filed
 * entirely on paper has no e-file acceptance and stamping one would be a comfortable lie on the
 * one column every report reads as "the IRS said yes".
 *
 * #44 §4 — and the engagement holding the return might be finished too. `completed` was terminal
 * here from the start and nothing propagated it: the return ended, the engagement stayed active
 * forever, and the client kept reading as active because an "open" engagement existed. Only closes
 * when EVERY return on the engagement is terminal.
 */
async function completeNowNothingIsAwaited(
  app: FastifyInstance,
  actor: { staffId: string | null; label: string },
  taxEngagementId: string,
  note: string
): Promise<void> {
  const status = await acceptanceStatus(app, taxEngagementId);
  if (status.accepted.length > 0) {
    await app.db.query(`UPDATE tax_engagements SET efile_accepted_at = COALESCE(efile_accepted_at, now()) WHERE id = $1`, [taxEngagementId]);
  }
  await transitionStage(app, actor, taxEngagementId, 'completed', { note });
  const { closeEngagementIfAllReturnsDone } = await import('../engagements/close.ts');
  await closeEngagementIfAllReturnsDone(app, taxEngagementId, {
    type: 'staff', id: actor.staffId, label: actor.label,
  });
}

/**
 * THE FOLLOW-UP A CERTIFIED MAILING EARNS (Brian, 2026-09-20, ruling 15).
 *
 * Certified mail has tracking, so there is something to check and a day by which to check it
 * (certifiedMailFollowUp: the expected delivery window). Owned by the return's preparer, else the
 * role's alert recipient — the same owner rule and the same door as the re-file task, so an unfilled
 * role is a RECORDED fact that falls back to the CEO rather than a silently unowned follow-up.
 *
 * `jurisdiction` is null for the resolution lane's whole-return mailing, which is recorded before
 * the return declares anything. Shared by both doors so the two cannot drift.
 */
export async function certifiedMailingFollowUpTask(
  app: FastifyInstance,
  taxEngagementId: string,
  jurisdiction: string | null,
  mailedOn: string,
  tracking: string | null
): Promise<string | null> {
  const { rows } = await app.db.query<{
    tax_year: number; return_type: string; preparer_id: string | null;
    contact_id: string; first_name: string; last_name: string;
  }>(
    `SELECT te.tax_year, te.return_type, te.preparer_id, c.id AS contact_id, c.first_name, c.last_name
       FROM tax_engagements te
       JOIN engagements e ON e.id = te.engagement_id
       JOIN contacts c ON c.id = e.contact_id
      WHERE te.id = $1`,
    [taxEngagementId]
  );
  const te = rows[0];
  if (!te) throw new AppError(404, 'not_found', 'Tax engagement not found.');
  const followUp = certifiedMailFollowUp(mailedOn);
  const label = `${te.first_name} ${te.last_name} ${te.tax_year} ${te.return_type.toUpperCase()}`;
  const who = jurisdiction === null || jurisdiction === 'federal' ? 'the IRS' : jurisdiction;
  const owner = te.preparer_id ?? (await alertRecipientForRole(app.db, 'tax_preparer', 'paper_mailing_followup'));
  const task = await createTask(app, {
    title: `Check certified mail delivery: ${label} (${who}) — mailed ${mailedOn}`,
    description:
      `${label} went to ${who} on paper, certified, on ${mailedOn}` +
      `${tracking ? ` under tracking ${tracking}` : ' with no tracking number recorded'}.\n` +
      `Check the carrier's tracking by ${followUp} and file the receipt to the client record. ` +
      'A paper filing has no acknowledgment to wait for: this is the only confirmation the return gets.',
    assignedStaffId: owner,
    contactId: te.contact_id,
    dueDate: followUp,
    priority: 2,
    source: 'automation',
    sourceType: 'paper_mailing_followup',
    sourceId: `${taxEngagementId}:${jurisdiction ?? 'return'}`,
  });
  return task.id;
}

/**
 * RECORD THE MAILING OF ONE PAPER JURISDICTION (Brian, 2026-09-20, ruling 15).
 *
 * This is the paper lane's acceptance. The jurisdiction must be declared on the return and must be
 * filed on paper — a mailing on an e-file jurisdiction is a category error and is refused by name,
 * because the two are satisfied by different facts and confusing them is how a return gets counted
 * as filed twice or not at all.
 *
 * WHAT IT WRITES: the mailing on the jurisdiction row, and the return's summary columns
 * (paper_mailed_on / certified_tracking, migration 0026) beside it, so the resolution case view and
 * everything else already reading those keep working — the FIRST mailing fills them, the same rule
 * the state acceptance pair follows.
 *
 * A CERTIFIED mailing gets its follow-up task: tracking exists, so somebody checks it by the
 * expected-delivery day (certifiedMailFollowUp). The other methods have nothing to check and raise
 * nothing — a task nobody can act on is worse than no task.
 *
 * COMPLETION FOLLOWS, when this was the last thing the return waited on. Only from 'filed': a
 * rejected return is not completed by a mailing, it is completed by the re-file that fixes it.
 */
export async function recordJurisdictionMailing(
  app: FastifyInstance,
  actor: { staffId: string | null; label: string; ip?: string | null; userAgent?: string | null },
  taxEngagementId: string,
  jurisdiction: string,
  input: {
    mailedOn: string;
    method: MailingMethod;
    trackingNumber?: string | null;
    receiptDocumentId?: string | null;
    today?: string | undefined;
  }
): Promise<{ jurisdiction: string; mailedOn: string; followUpTaskId: string | null; stage: TaxStage; awaiting: string[] }> {
  const code = jurisdiction === 'federal' ? 'federal' : normaliseState(jurisdiction);
  if (!code || (code !== 'federal' && !/^[A-Z]{2}$/.test(code))) {
    throw new AppError(400, 'jurisdiction_invalid', `'${jurisdiction}' is not a jurisdiction: say 'federal' or a two-letter state code in upper case (IL, WI).`);
  }
  if (!(MAILING_METHODS as readonly string[]).includes(input.method)) {
    throw new AppError(400, 'mailing_method_invalid', `'${input.method}' is not a mailing method: certified, first_class, hand_delivered or mailed_by_client.`);
  }
  const { rows } = await app.db.query<{
    stage: TaxStage; tax_year: number; return_type: string; preparer_id: string | null;
    contact_id: string; first_name: string; last_name: string;
  }>(
    `SELECT te.stage, te.tax_year, te.return_type, te.preparer_id, c.id AS contact_id, c.first_name, c.last_name
       FROM tax_engagements te
       JOIN engagements e ON e.id = te.engagement_id
       JOIN contacts c ON c.id = e.contact_id
      WHERE te.id = $1`,
    [taxEngagementId]
  );
  const te = rows[0];
  if (!te) throw new AppError(404, 'not_found', 'Tax engagement not found.');

  const today = input.today ?? todayChicago();
  if (calendarDay(input.mailedOn, 'mailedOn') > calendarDay(today)) {
    throw new AppError(400, 'mailed_on_future', 'A mailing is recorded on the day it went out or after it: the date cannot be in the future.');
  }

  const status = await acceptanceStatus(app, taxEngagementId);
  const row = status.rows.find((d) => d.jurisdiction === code);
  if (!row) {
    throw new AppError(
      409,
      'jurisdiction_not_declared',
      `${code} is not declared on this return — it files in ${status.expected.join(', ')}. Declare ${code} on the return before recording a mailing for it.`
    );
  }
  if (row.filingMethod !== 'paper') {
    throw new AppError(
      409,
      'jurisdiction_is_efile',
      `${code} was e-filed on this return, so it is satisfied by an acknowledgment rather than a mailing. Change its filing method on the return if it actually went out on paper.`
    );
  }
  if (row.mailedOn) {
    throw new AppError(
      409,
      'mailing_already_recorded',
      `${code} was already recorded as mailed on ${row.mailedOn}. The mailing that went out is the one that counts.`
    );
  }

  const tracking = input.trackingNumber?.trim() || null;
  await app.db.query(
    `UPDATE tax_engagement_jurisdictions
        SET mailed_on = $3::date, mailing_method = $4, tracking_number = $5, receipt_document_id = $6
      WHERE tax_engagement_id = $1 AND jurisdiction = $2`,
    [taxEngagementId, code, input.mailedOn, input.method, tracking, input.receiptDocumentId ?? null]
  );
  // The summary pair on the return, kept in step for every reader that already uses it (0026).
  await app.db.query(
    `UPDATE tax_engagements
        SET paper_mailed_on = COALESCE(paper_mailed_on, $2::date),
            certified_tracking = COALESCE(certified_tracking, $3)
      WHERE id = $1`,
    [taxEngagementId, input.mailedOn, tracking]
  );
  await writeAudit(app.db, {
    actorType: actor.staffId ? 'staff' : 'system', actorId: actor.staffId, actorLabel: actor.label,
    action: 'tax_engagement.paper_mailed', objectType: 'tax_engagement', objectId: taxEngagementId,
    contactId: te.contact_id, ip: actor.ip, userAgent: actor.userAgent,
    details: {
      jurisdiction: code, mailed_on: input.mailedOn, mailing_method: input.method,
      tracking_number: tracking, receipt_document_id: input.receiptDocumentId ?? null,
    },
  });

  const followUpTaskId =
    input.method === CHASED_MAILING_METHOD
      ? await certifiedMailingFollowUpTask(app, taxEngagementId, code, input.mailedOn, tracking)
      : null;

  const after = await acceptanceStatus(app, taxEngagementId);
  if (after.awaiting.length === 0 && te.stage === 'filed') {
    await completeNowNothingIsAwaited(app, actor, taxEngagementId, `paper filing mailed to ${code} — every jurisdiction has answered`);
    return { jurisdiction: code, mailedOn: input.mailedOn, followUpTaskId, stage: 'completed', awaiting: [] };
  }
  return { jurisdiction: code, mailedOn: input.mailedOn, followUpTaskId, stage: te.stage, awaiting: after.awaiting };
}

export async function recordEfileResult(
  app: FastifyInstance,
  actor: { staffId: string | null; label: string },
  taxEngagementId: string,
  input: {
    result: 'accepted' | 'rejected'; rejectCode?: string | undefined; rejectReason?: string | undefined; today?: string | undefined;
    /** Which jurisdiction answered. Federal when unsaid (the manual route records the IRS acknowledgment). */
    jurisdiction?: 'federal' | 'state' | undefined;
    /** With jurisdiction 'state': the state that answered. */
    stateCode?: string | undefined;
  }
): Promise<{ stage: TaxStage; perfectionDeadline: string | null; awaiting: string[] }> {
  const { rows } = await app.db.query<{
    id: string; stage: TaxStage; return_type: string; tax_year: number;
    preparer_id: string | null; contact_id: string; first_name: string; last_name: string;
  }>(
    `SELECT te.id, te.stage, te.return_type, te.tax_year, te.preparer_id,
            c.id AS contact_id, c.first_name, c.last_name
     FROM tax_engagements te
     JOIN engagements e ON e.id = te.engagement_id
     JOIN contacts c ON c.id = e.contact_id
     WHERE te.id = $1`,
    [taxEngagementId]
  );
  const te = rows[0];
  if (!te) throw new AppError(404, 'not_found', 'Tax engagement not found.');
  if (te.stage !== 'filed') {
    throw new AppError(409, 'not_filed', `E-file results apply to filed returns — this one is '${te.stage}'.`);
  }

  /*
   * ONE TRANSACTION, BOTH BRANCHES (#48, same shape as acceptance).
   *
   * This is the path that turns an IRS response into everything that follows it, and each
   * branch is a chain where a break leaves the return telling one story and its surroundings
   * another:
   *
   *   ACCEPTED — stamp `efile_accepted_at`, move the stage to `completed`, then close the
   *   engagement and recompute the client's lifecycle (#44 §4). Break it midway and the
   *   return is accepted while the engagement stays open forever, which is the exact untruth
   *   #44 §4 was built to remove, reintroduced by a failed write instead of a missing one.
   *
   *   REJECTED — stamp the reject code and the perfection deadline, move the stage, then
   *   create the owned re-file task and alert its owner. Break it midway and the return
   *   reads `rejected` with a live perfection clock and NOBODY OWNS IT: no task, no alert,
   *   and the D3/D7/D14/D30 ladder has nothing to hang from. The original filing date is
   *   what runs out, silently.
   *
   * Nothing in either branch reaches outward — checked call by call. `transitionStage`,
   * `createTask` and `notifyOnce` are all database-only, and the client is not told about an
   * e-file result from here at all.
   */
  return withTransaction(app.db, () => applyEfileResult(app, actor, taxEngagementId, input, te));
}

/** The durable half of {@link recordEfileResult} — see the transaction note there. */
async function applyEfileResult(
  app: FastifyInstance,
  actor: { staffId: string | null; label: string },
  taxEngagementId: string,
  input: Parameters<typeof recordEfileResult>[3],
  te: {
    return_type: string; tax_year: number; preparer_id: string | null;
    contact_id: string; first_name: string; last_name: string;
  }
): Promise<{ stage: TaxStage; perfectionDeadline: string | null; awaiting: string[] }> {
  if (input.result === 'accepted') {
    /*
     * EVERY JURISDICTION, NOT FEDERAL ALONE (Brian, 2026-09-19, item 4). The acknowledgment
     * ingest stamps the jurisdiction's date before calling here and this COALESCE leaves that
     * stamp alone; the manual route, which stamps nothing, gets today's date so its acceptance
     * is a fact on the row and not only a stage. Then: complete only when nothing is awaited.
     * The order the acknowledgments arrive in does not matter — whichever comes second finds
     * the first already stamped and finishes the return.
     */
    const jurisdiction = input.jurisdiction ?? 'federal';
    const asOf = input.today ?? todayChicago();
    const code = jurisdiction === 'federal' ? 'federal' : normaliseState(input.stateCode);
    if (!code) {
      throw new AppError(409, 'state_code_required', 'A state acknowledgment says which state accepted (a two-letter code).');
    }
    /*
     * ONLY A DECLARED JURISDICTION IS STAMPED (Brian, 2026-09-19 evening, ruling 2), and one that
     * is not declared is REFUSED here rather than swallowed. The route used to ignore another
     * state's acceptance silently, which reads as "recorded" to whoever sent it.
     */
    const stamped = await stampJurisdictionAccepted(app, taxEngagementId, code, asOf);
    if (!stamped.ok) {
      const { expected } = await acceptanceStatus(app, taxEngagementId);
      if (stamped.reason === 'paper') throw paperJurisdictionRefusal(code);
      throw new AppError(
        409,
        'jurisdiction_not_declared',
        `${code} is not declared on this return — it files in ${expected.join(', ')}. Declare ${code} on the return before recording an acknowledgment for it.`
      );
    }
    const awaiting = await jurisdictionsAwaiting(app, taxEngagementId);
    if (awaiting.length > 0) {
      await writeAudit(app.db, {
        actorType: actor.staffId ? 'staff' : 'system', actorId: actor.staffId, actorLabel: actor.label,
        action: 'tax_engagement.efile_accepted_partial', objectType: 'tax_engagement', objectId: taxEngagementId, contactId: te.contact_id,
        details: { jurisdiction, state_code: input.stateCode ?? null, awaiting },
      });
      return { stage: 'filed', perfectionDeadline: null, awaiting };
    }

    await completeNowNothingIsAwaited(app, actor, taxEngagementId, 'e-file ACCEPTED by every jurisdiction');
    return { stage: 'completed', perfectionDeadline: null, awaiting: [] };
  }

  const today = input.today ?? todayChicago();
  const deadline = addDays(today, perfectionDays(te.return_type));
  await app.db.query(
    `UPDATE tax_engagements
     SET rejected_at = now(), reject_code = $2, reject_reason = $3, perfection_deadline = $4
     WHERE id = $1`,
    [taxEngagementId, input.rejectCode ?? null, input.rejectReason ?? null, deadline]
  );
  await transitionStage(app, actor, taxEngagementId, 'rejected', {
    note: `e-file REJECTED${input.rejectCode ? ` (${input.rejectCode})` : ''}`,
  });

  /*
   * OWNED WORK ITEM — and "owned" now means it, which it did not before (#48, Brian's
   * statutory-tier ruling 2026-08-17).
   *
   * This resolved the owner with `firstActiveByRole('tax_preparer')`, which has NO FALLBACK,
   * and `tax_preparer` is a role nobody currently holds — production has one staff account.
   * So the task was created UNASSIGNED and the alert below, gated on `if (owner)`, never
   * fired at all. A statutory perfection clock started and literally nobody was told.
   *
   * That is finding #17 exactly, reproduced in the tax pipeline with a different role, and
   * worse here because what runs out is the original filing date rather than a follow-up.
   * `ownerForRole` is the resolver that falls back to Brian and returns null only when the
   * firm has nobody at all; the alert below is no longer gated on the role being filled.
   *
   * The transaction wrapping this branch guarantees the clock and the task land together. It
   * could not make the task owned — "together" happily included "together with no owner".
   * Both halves are needed, which is why the deferred constraint trigger in migration 0068
   * enforces the pair at COMMIT rather than trusting this comment.
   */
  /*
   * THE RETURN'S PREPARER OWNS THE RE-FILE (Brian, 2026-09-19, item 4). When the return has no
   * preparer the role holder does, and an unfilled role is a RECORDED fact that falls back to
   * the CEO (alertRecipientForRole → staffing.role_unfilled), never a silently unowned clock.
   * Federal or state, the same door: one createTask, one task type, one owner rule.
   */
  const owner = te.preparer_id ?? (await alertRecipientForRole(app.db, 'tax_preparer', 'efile_reject'));
  const by = (input.jurisdiction ?? 'federal') === 'federal' ? 'the IRS' : (normaliseState(input.stateCode) ?? 'the state');
  await createTask(app, {
    title: `E-file REJECTED by ${by}: ${te.first_name} ${te.last_name} ${te.tax_year} ${te.return_type.toUpperCase()} — fix & re-file by ${deadline}`,
    description:
      `Rejected by ${by}. Reject code: ${input.rejectCode ?? 'n/a'}. ${input.rejectReason ?? ''}\n` +
      `Perfection window: re-file by ${deadline} (${perfectionDays(te.return_type)} days) to keep the original filing date.`,
    assignedStaffId: owner,
    contactId: te.contact_id,
    dueDate: deadline,
    // P1, not P2. A statutory clock is running and the original filing date is what expires.
    priority: 1,
    source: 'automation',
    sourceType: 'efile_reject',
    sourceId: taxEngagementId,
  });
  /*
   * The alert still needs a real person to alert — a notification row with no staff_id belongs
   * to nobody's queue. But `owner` now falls back to Brian, so this is only skipped when the
   * firm has NO active staff at all, which is a different situation from "the role is unfilled".
   */
  if (owner) {
    await notifyOnce(app.db, {
      staffId: owner,
      type: 'efile_rejected',
      severity: 'critical',
      title: `E-file rejected — ${te.first_name} ${te.last_name} ${te.tax_year} ${te.return_type.toUpperCase()}, perfection ends ${deadline}`,
      contactId: te.contact_id,
      relatedObjectType: 'efile_reject',
      relatedObjectId: taxEngagementId,
    });
  }
  return { stage: 'rejected', perfectionDeadline: deadline, awaiting: [] };
}

/**
 * Daily perfection-clock sweep: T-2 warning to the owner, past-deadline
 * critical to Brian (the original filing date is now at risk). notifyOnce
 * keys keep each alert to exactly one firing per engagement.
 */
export async function runPerfectionClockJob(
  app: FastifyInstance,
  today: string
): Promise<{ skipped: boolean; warnings: number; overdue: number }> {
  const ACTION = 'job.perfection_clock';
  const already = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = $1 AND details->>'run_date' = $2 LIMIT 1`,
    [ACTION, today]
  );
  if (already.rows.length > 0) return { skipped: true, warnings: 0, overdue: 0 };

  const { rows } = await app.db.query<{
    id: string; perfection_deadline: string; preparer_id: string | null;
    contact_id: string; first_name: string; last_name: string; tax_year: number; return_type: string;
  }>(
    `SELECT te.id, te.perfection_deadline::text AS perfection_deadline, te.preparer_id,
            c.id AS contact_id, c.first_name, c.last_name, te.tax_year, te.return_type
     FROM tax_engagements te
     JOIN engagements e ON e.id = te.engagement_id
     JOIN contacts c ON c.id = e.contact_id
     WHERE te.stage = 'rejected' AND te.perfection_deadline IS NOT NULL`
  );

  let warnings = 0;
  let overdue = 0;
  const brian = await firstActiveByRole(app.db, 'ceo');
  for (const te of rows) {
    const label = `${te.first_name} ${te.last_name} ${te.tax_year} ${te.return_type.toUpperCase()}`;
    if (calendarDay(te.perfection_deadline, 'perfection_deadline') < calendarDay(today)) {
      if (brian) {
        const fired = await notifyOnce(app.db, {
          staffId: brian,
          type: 'perfection_overdue',
          severity: 'critical',
          title: `PERFECTION WINDOW MISSED: ${label} (was ${te.perfection_deadline}) — original filing date at risk`,
          contactId: te.contact_id,
          relatedObjectType: 'perfection_overdue',
          relatedObjectId: te.id,
        });
        if (fired) overdue++;
      }
    } else if (daysBetween(today, te.perfection_deadline) <= 2 && te.preparer_id) {
      const fired = await notifyOnce(app.db, {
        staffId: te.preparer_id,
        type: 'perfection_closing',
        severity: 'warning',
        title: `Perfection window closes ${te.perfection_deadline}: ${label} — re-file now`,
        contactId: te.contact_id,
        relatedObjectType: 'perfection_closing',
        relatedObjectId: te.id,
      });
      if (fired) warnings++;
    }
  }

  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'daily-jobs',
    action: ACTION,
    details: { run_date: today, warnings, overdue },
  });
  return { skipped: false, warnings, overdue };
}

/**
 * Automation 4 (pipeline half): a document request flips the engagement to
 * pending_client_response and stamps docs_requested_at. The request/reminder
 * machinery itself lands in M10 — this is the stage side-effect.
 */
export async function markDocumentsRequested(
  app: FastifyInstance,
  actor: { staffId: string | null; label: string },
  taxEngagementId: string
): Promise<void> {
  await app.db.query(
    `UPDATE tax_engagements SET docs_requested_at = COALESCE(docs_requested_at, now()) WHERE id = $1`,
    [taxEngagementId]
  );
  const { rows } = await app.db.query<{ stage: TaxStage }>(
    `SELECT stage FROM tax_engagements WHERE id = $1`,
    [taxEngagementId]
  );
  const stage = rows[0]?.stage;
  if (stage === 'documents_requested' || stage === 'in_preparation') {
    await transitionStage(app, actor, taxEngagementId, 'pending_client_response', {
      note: 'auto: document request sent',
    });
  } else if (stage === 'scheduled') {
    // scheduled → documents_requested → pending_client_response (gates apply).
    await transitionStage(app, actor, taxEngagementId, 'documents_requested', { note: 'auto: document request sent' });
    await transitionStage(app, actor, taxEngagementId, 'pending_client_response', {
      note: 'auto: document request sent',
    });
  }
}
