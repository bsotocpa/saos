/*
 * STEP-7 CONTROLS ON THE RETURN'S PAGE (Brian, 2026-09-19, item 2) — the pure parts.
 *
 * The Returns card on the client page offers estimate lock, final fee, and the legal next stage
 * transition(s), to a session that holds engagements.tax.manage and to nobody else. What the
 * decision reads and what the buttons say live here, with no React in them, so the rule can be
 * proven by a test rather than believed from a screenshot.
 */

/** The one permission behind the three controls; '*' (the CEO) holds it by wildcard, the same rule as the API. */
export const RETURN_CONTROLS_PERMISSION = 'engagements.tax.manage';

export function canManageReturns(permissions: readonly string[] | null | undefined): boolean {
  if (!permissions) return false;
  return permissions.includes('*') || permissions.includes(RETURN_CONTROLS_PERMISSION);
}

/**
 * The transition button says where the return goes, in the words of the stage it lands in.
 * 'filed' is "Mark filed" because filing happened in ATX; the button records it and issues the
 * invoice. An unknown stage falls back to the enum with the underscores spaced, never crashes.
 */
const STAGE_ACTION: Record<string, string> = {
  scheduled: 'Schedule',
  documents_requested: 'Request documents',
  pending_client_response: 'Waiting on client',
  in_preparation: 'Start preparation',
  internal_review: 'Internal review',
  client_review: 'Client review',
  ready_to_file: 'Ready to file',
  filed: 'Mark filed',
  completed: 'Complete',
};
export function stageActionLabel(stage: string): string {
  return STAGE_ACTION[stage] ?? stage.replaceAll('_', ' ');
}

/** The stages where the three controls apply: everything before filed, plus the re-file path after a rejection. */
const PRE_FILED = new Set([
  'intake_started', 'scheduled', 'documents_requested', 'pending_client_response',
  'in_preparation', 'internal_review', 'client_review', 'ready_to_file', 'rejected',
]);
export function controlsApply(stage: string): boolean {
  return PRE_FILED.has(stage);
}

/**
 * Dollars as a person types them (with or without a dollar sign, commas, or spaces) to integer cents; null when it is
 * not an amount. Rounded to the cent so 0.1 + 0.2 never becomes a fee.
 */
export function dollarsToCents(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

export interface QuotedRange { min_cents: number; max_cents: number; price_book_version: number }

/** Outside the quoted range in either direction; no range means nothing to be outside of. */
export function outsideRange(cents: number, range: QuotedRange | null): boolean {
  if (!range) return false;
  return cents < range.min_cents || cents > range.max_cents;
}

/**
 * ABOVE A LOCKED ESTIMATE (Brian, 2026-09-19 evening, ruling 1): the same predicate the route
 * uses — a locked estimate is one with a top, and the fee is over it. Outside the quoted range is
 * a wider thing (below counts, and a return with no lock still has a quote); only THIS one brings
 * out the scope-creep category.
 */
export function aboveLockedEstimate(cents: number, te: { estimated_fee_max_cents: number | null }): boolean {
  return te.estimated_fee_max_cents !== null && cents > te.estimated_fee_max_cents;
}

/**
 * The scope_creep_reason enum, in the order the select offers it. NEVER preselected: the modal's
 * first option is an empty "Choose…", because a category nobody chose is worth nothing — that is
 * exactly what filing every overrun under 'other' had made of it.
 */
export const SCOPE_CREEP_CATEGORIES = [
  'additional_states', 'additional_sch_c', 'additional_sch_e', 'foreign',
  'late_docs', 'prior_year_cleanup', 'irs_notice', 'other',
] as const;
export type ScopeCreepCategory = (typeof SCOPE_CREEP_CATEGORIES)[number];

export const SCOPE_CREEP_LABEL: Record<ScopeCreepCategory, string> = {
  additional_states: 'Additional state returns',
  additional_sch_c: 'Additional Schedule C',
  additional_sch_e: 'Additional Schedule E',
  foreign: 'Foreign reporting',
  late_docs: 'Late documents',
  prior_year_cleanup: 'Prior-year cleanup',
  irs_notice: 'IRS notice work',
  other: 'Other (say what in the reason)',
};

/**
 * JURISDICTIONS DECLARED ON THE RETURN (Brian, 2026-09-19 evening, ruling 2) — the pure parts of
 * the Mark filed modal's list. Federal is always on it and cannot be taken off; the states are the
 * preparer's to add and remove.
 */
export const FEDERAL = 'federal';

/** What the modal starts with: what the return already declares, else what the address suggests. */
export function startingJurisdictions(detail: {
  declared_jurisdictions?: readonly string[] | null;
  default_jurisdictions?: readonly string[] | null;
}): string[] {
  const declared = detail.declared_jurisdictions ?? [];
  const list = declared.length > 0 ? declared : (detail.default_jurisdictions ?? [FEDERAL]);
  return normaliseJurisdictions(list);
}

/** Federal first, then the states alphabetically — the order the API and the notes read in. */
export function normaliseJurisdictions(list: readonly string[]): string[] {
  const states = [...new Set(list.map((j) => j.trim().toUpperCase()).filter((j) => j && j !== FEDERAL.toUpperCase()))].sort();
  return [FEDERAL, ...states];
}

/**
 * A state code a person typed, ready to add — or the words refusing it. Two letters, upper-cased;
 * a duplicate is refused rather than silently dropped, because the list is what the return will
 * say and a person who typed IL twice meant something.
 */
export function addState(list: readonly string[], typed: string): { list: string[]; error: string } {
  const code = typed.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return { list: [...list], error: 'A state is its two-letter code (IL, WI).' };
  if (normaliseJurisdictions(list).includes(code)) return { list: [...list], error: `${code} is already on the list.` };
  return { list: normaliseJurisdictions([...list, code]), error: '' };
}

/** Federal never leaves; a state does. */
export function removeState(list: readonly string[], code: string): string[] {
  return normaliseJurisdictions(list.filter((j) => j.toUpperCase() !== code.trim().toUpperCase() || j === FEDERAL));
}

/** The list in the words the modal prints under the control. */
export function jurisdictionsSentence(list: readonly string[]): string {
  const states = normaliseJurisdictions(list).filter((j) => j !== FEDERAL);
  return states.length === 0
    ? 'Federal only — no state return is declared on this filing.'
    : `Federal and ${states.join(', ')} — the return completes when every one of them has accepted.`;
}

/*
 * ═══ 2026-09-20, ruling 15: PAPER FILING, PER JURISDICTION ═════════════════════════════════════
 *
 * A jurisdiction was filed one of two ways, and the two are satisfied by different facts: an e-file
 * jurisdiction by an acknowledgment, a paper one by a recorded MAILING. So the row must never say
 * "Accepted" for a paper filing — nobody accepted anything, and there is no acknowledgment coming.
 *
 * The lane the year implies is derived by the API (filingLane) and arrives on the detail as
 * `default_filing_method`: this file does not re-derive it, the same way it grows no date formatter.
 */

export const FILING_METHODS = ['efile', 'paper'] as const;
export type FilingMethod = (typeof FILING_METHODS)[number];

export const FILING_METHOD_LABEL: Record<FilingMethod, string> = {
  efile: 'E-filed',
  paper: 'Paper (mailed)',
};

export const MAILING_METHODS = ['certified', 'first_class', 'hand_delivered', 'mailed_by_client'] as const;
export type MailingMethod = (typeof MAILING_METHODS)[number];

export const MAILING_METHOD_LABEL: Record<MailingMethod, string> = {
  certified: 'USPS certified (tracked)',
  first_class: 'USPS first-class',
  hand_delivered: 'Hand-delivered',
  mailed_by_client: 'Mailed by the client',
};

/** One declared jurisdiction as GET /tax-engagements/:id reports it. */
export interface JurisdictionView {
  jurisdiction: string;
  filingMethod: FilingMethod;
  acceptedOn: string | null;
  mailedOn: string | null;
  mailingMethod: MailingMethod | null;
  trackingNumber: string | null;
  receiptDocumentId: string | null;
}

/** 'federal' prints as Federal; a state prints as its code. */
export function jurisdictionLabel(jurisdiction: string): string {
  return jurisdiction === FEDERAL ? 'Federal' : jurisdiction.toUpperCase();
}

/**
 * What the row says about one jurisdiction. The day arrives already formatted — this file has no
 * date formatter and must not grow one. A paper jurisdiction reads "Mailed <date>" and an e-file one
 * "Accepted <date>"; neither is ever printed for the other, and a jurisdiction that has not answered
 * says what it is waiting for rather than nothing.
 */
export function jurisdictionStatusText(row: JurisdictionView, dayText: string): string {
  if (row.filingMethod === 'paper') {
    return row.mailedOn ? `Mailed ${dayText}` : 'Paper — no mailing recorded';
  }
  return row.acceptedOn ? `Accepted ${dayText}` : 'Awaiting acceptance';
}

/** The declared paper jurisdictions with no mailing on them: each one needs a Record mailing. */
export function mailingsNeeded(rows: readonly JurisdictionView[] | null | undefined): JurisdictionView[] {
  return (rows ?? []).filter((r) => r.filingMethod === 'paper' && !r.mailedOn);
}

/**
 * The Record mailing control lives on a FILED return, which is where the pre-filing controls stop:
 * a jurisdiction is declared at filing, so nothing can be mailed before then. A rejected return
 * keeps it — the paper jurisdictions on it were still mailed — and a completed one does not, because
 * nothing is awaited any more.
 */
const MAILABLE_STAGES = new Set(['filed', 'rejected']);
export function mailingControlsApply(stage: string): boolean {
  return MAILABLE_STAGES.has(stage);
}

/**
 * What the Mark filed modal's per-jurisdiction select opens on: the method already on the row, else
 * the lane the return's year implies. Never a guess and never e-file by habit — an old year defaults
 * to paper because that is the only lane it has.
 */
export function startingFilingMethods(detail: {
  jurisdictions?: readonly JurisdictionView[] | null;
  default_filing_method?: FilingMethod | null;
}, list: readonly string[]): Record<string, FilingMethod> {
  const fallback: FilingMethod = detail.default_filing_method ?? 'efile';
  const out: Record<string, FilingMethod> = {};
  for (const j of normaliseJurisdictions(list)) {
    out[j] = (detail.jurisdictions ?? []).find((r) => r.jurisdiction === j)?.filingMethod ?? fallback;
  }
  return out;
}

/** The map, kept to the list: a state removed from the filing takes its method with it. */
export function filingMethodsFor(
  list: readonly string[],
  methods: Readonly<Record<string, FilingMethod>>,
  fallback: FilingMethod
): Record<string, FilingMethod> {
  const out: Record<string, FilingMethod> = {};
  for (const j of normaliseJurisdictions(list)) out[j] = methods[j] ?? fallback;
  return out;
}

/*
 * ═══ 2026-09-20: THE PREPARER, THE EXTENSION AND THE LETTER ON PAPER ═══════════════════════════
 */

/**
 * WHO PREPARES THIS RETURN, in the words the row prints beside the control. A return with nobody on
 * it says so plainly — "No preparer", not a blank — because a blank reads as "nothing to see" and
 * the whole point is that somebody has to be named before preparation starts.
 */
export function preparerLine(assigned: { name: string } | null | undefined): string {
  return assigned?.name ? `Preparer: ${assigned.name}` : 'No preparer';
}

/**
 * What the Assign preparer select opens on: whoever is already assigned, else the firm's only
 * active tax preparer when there is exactly one, else nothing — a select that opens on somebody
 * nobody chose is the same mistake the scope-creep category made.
 */
export function defaultPreparerId(detail: {
  assigned_preparer?: { id: string } | null;
  sole_tax_preparer_id?: string | null;
}): string {
  return detail.assigned_preparer?.id ?? detail.sole_tax_preparer_id ?? '';
}

/**
 * THE EXTENSION FORM (Brian, 2026-09-20). Two real forms: 4868 for an individual return, 7004 for
 * an entity return. The same rule the API uses, so the control opens on the same answer the route
 * would have defaulted to — and the person filing can still say the other one.
 */
export const EXTENSION_FORMS = ['4868', '7004', '8868'] as const;
export type ExtensionForm = (typeof EXTENSION_FORMS)[number];

export function defaultExtensionForm(returnType: string | null | undefined): ExtensionForm {
  const t = (returnType ?? '').toLowerCase();
  if (t === '1040' || t === '1040_expat') return '4868';
  // R66: the whole 990 family (990, 990-EZ, 990-PF, 990-T) extends on 8868.
  if (t.startsWith('990')) return '8868';
  return '7004';
}

export const EXTENSION_FORM_LABEL: Record<ExtensionForm, string> = {
  '4868': 'Form 4868 (individual)',
  '7004': 'Form 7004 (entity)',
  '8868': 'Form 8868 (exempt organization)',
};

/**
 * The badge the row shows once an extension is recorded: which form went in and the deadline it
 * bought. The deadline arrives already formatted — this file has no date formatter and must not
 * grow one; an unrecorded form reads "form not recorded" rather than pretending to know.
 */
export function extensionBadgeText(form: string | null | undefined, extendedDeadlineText: string): string {
  const which = form ? `Form ${form}` : 'form not recorded';
  return extendedDeadlineText
    ? `Extended · ${which} · deadline ${extendedDeadlineText}`
    : `Extended · ${which}`;
}

/*
 * ═══ 2026-09-26: THE FILING, CORRECTED ═════════════════════════════════════════════════════════
 *
 * A return at filed carries three facts about the filing — the day, whose PTIN is on it, the
 * jurisdictions declared — and each is corrected by APPENDING a correction with a reason, never by
 * editing in place. The control lives on the filed row only: before filing there is nothing to
 * correct, and after completion the acknowledgments have answered for what was declared.
 */
export function correctionsApply(stage: string): boolean {
  // R86 (2026-09-27): at completed too; the signed day, the scan, the filed day and the PTIN holder
  // stay correctable, and the route refuses removing a jurisdiction that answered.
  return stage === 'filed' || stage === 'completed';
}

/** One correction as GET /tax-engagements/:id reports it. `created_at` is an INSTANT: the row formats it with dayOf. */
export interface FilingCorrectionView {
  id: string;
  fields: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  reason: string;
  actor_label: string;
  created_at: string;
}

/** The field names the API records, in the words the row prints them. */
export const CORRECTION_FIELD_LABEL: Record<string, string> = {
  filed_date: 'the filed date',
  preparer_ptin_holder_id: 'the PTIN holder',
  jurisdictions: 'the declared jurisdictions',
  // R69 / R66 (2026-09-26/27): the authorization's day, its scan, and which 8879 it is.
  f8879_signed_on: 'the 8879 signed date',
  f8879_document: 'the 8879 scan',
  f8879_variant: 'the 8879 form',
};

/**
 * "Corrected the filed date on Sep 26, 2026 by Brian Soto: <reason>" — the history line under the
 * return row. The day arrives already formatted (this file has no date formatter); the actor is
 * the name the correction recorded, never an address; an unknown field prints as itself rather
 * than crashing the row.
 */
export function correctionLine(c: Pick<FilingCorrectionView, 'fields' | 'reason' | 'actor_label'>, dayText: string): string {
  const what = c.fields.map((f) => CORRECTION_FIELD_LABEL[f] ?? f.replaceAll('_', ' ')).join(', ');
  return `Corrected ${what} on ${dayText} by ${c.actor_label}: ${c.reason}`;
}

/** What the correction modal opens on, and what it compares against: the filing as recorded. */
export interface FilingAsRecorded {
  filedOn: string;
  ptin: string;
  jurisdictions: string[];
  /** R69: the day on the signed 8879, as recorded; '' when none is on file. Optional so older callers and tests stand. */
  f8879SignedOn?: string;
  /** R66: which Form 8879 the scan is, as recorded; '' when unrecorded. */
  f8879Variant?: string;
}

/**
 * ONLY WHAT MOVED goes to the route: a field equal to the filing as recorded is not a correction,
 * and sending it would make the route say so about a field the person did not touch. The
 * jurisdictions compare as normalised lists (federal first, states sorted) so order is never a
 * difference. An empty result is sent as-is: the route's refusal — nothing to correct — is the
 * words the modal shows.
 */
export interface FilingCorrectionBody {
  filedOn?: string;
  preparerPtinHolderId?: string;
  jurisdictions?: string[];
  f8879SignedOn?: string;
  f8879Variant?: string;
}
export function changedFilingFields(current: FilingAsRecorded, draft: FilingAsRecorded): FilingCorrectionBody {
  const out: FilingCorrectionBody = {};
  if (draft.filedOn && draft.filedOn !== current.filedOn) out.filedOn = draft.filedOn;
  if (draft.ptin && draft.ptin !== current.ptin) out.preparerPtinHolderId = draft.ptin;
  const was = normaliseJurisdictions(current.jurisdictions);
  const now = normaliseJurisdictions(draft.jurisdictions);
  if (was.join(',') !== now.join(',')) out.jurisdictions = now;
  // R69 / R66: the authorization's day and its form move the same way — only when they differ from the record.
  if (draft.f8879SignedOn && draft.f8879SignedOn !== (current.f8879SignedOn ?? '')) out.f8879SignedOn = draft.f8879SignedOn;
  if (draft.f8879Variant && draft.f8879Variant !== (current.f8879Variant ?? '')) out.f8879Variant = draft.f8879Variant;
  return out;
}

/**
 * THE PREPARER OFFER opens CHECKED when the PTIN holder being corrected was also the assigned
 * preparer — the wrong person was picked once and landed in both places — and unchecked when the
 * two were already different people, because then the assignee was a separate decision.
 */
export function preparerOfferDefault(ptinHolderId: string | null | undefined, assignedPreparerId: string | null | undefined): boolean {
  return Boolean(ptinHolderId) && ptinHolderId === assignedPreparerId;
}

/** A declared jurisdiction that has answered — accepted or mailed — cannot leave the filing; the row says which. */
export function jurisdictionSatisfiedText(row: JurisdictionView | undefined, dayText: string): string {
  if (!row) return '';
  if (row.acceptedOn) return `accepted ${dayText}`;
  if (row.mailedOn) return `mailed ${dayText}`;
  return '';
}

/*
 * ═══ 2026-09-26, R66 (and 2026-09-27, R72): WHICH 8879 THE PAPER IS ═══════════════════════════
 *
 * One Form 8879 is five forms, by the return it authorizes: 8879 (an individual return), 8879-CORP
 * (a corporation), 8879-PE (a partnership), 8879-TE (an exempt organization), 8879-F (an estate or
 * trust, the 1041: R72). The upload's select opens on the return type's default — the same rule the
 * API applies (signed-8879.ts) — and the person can say another one.
 */
export const F8879_VARIANTS = ['8879', '8879-CORP', '8879-PE', '8879-TE', '8879-F'] as const;
export type F8879Variant = (typeof F8879_VARIANTS)[number];

export const F8879_VARIANT_LABEL: Record<F8879Variant, string> = {
  '8879': 'Form 8879 (individual)',
  '8879-CORP': 'Form 8879-CORP (corporation)',
  '8879-PE': 'Form 8879-PE (partnership)',
  '8879-TE': 'Form 8879-TE (exempt organization)',
  '8879-F': 'Form 8879-F (estate or trust)',
};

export function defaultF8879Variant(returnType: string | null | undefined): F8879Variant {
  const t = (returnType ?? '').toLowerCase();
  if (t === '1065') return '8879-PE';
  if (t.startsWith('1120')) return '8879-CORP';
  if (t.startsWith('990')) return '8879-TE';
  if (t === '1041') return '8879-F';
  return '8879';
}

/**
 * "8879-TE on file, signed Sep 15, 2026" — the row's words for the authorization. The variant is the
 * document's own; an unrecorded one reads the bare form rather than a guess. The day arrives
 * formatted (this file has no date formatter).
 */
export function f8879OnFileText(variant: string | null | undefined, signedDayText: string): string {
  return `${variant || '8879'} on file, signed ${signedDayText}`;
}

/*
 * ═══ 2026-09-26, R67: REOPEN A COMPLETED RETURN ═══════════════════════════════════════════════
 *
 * The one control on a COMPLETED row, for the one person who holds it. engagements.tax.reopen is
 * explicit-only on the API: the wildcard does not confer it, so this reads the named permission and
 * never '*' — a session that holds every other control still gets no Reopen unless it holds this one.
 */
export const REOPEN_PERMISSION = 'engagements.tax.reopen';

export function canReopenReturns(permissions: readonly string[] | null | undefined): boolean {
  return Boolean(permissions?.includes(REOPEN_PERMISSION));
}

export function reopenApplies(stage: string): boolean {
  return stage === 'completed';
}
