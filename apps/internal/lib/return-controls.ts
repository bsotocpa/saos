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
