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
