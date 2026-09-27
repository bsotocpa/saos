/*
 * ONE LABEL MAP PER ENUM (audit item 11, 2026-09-09, Brian's ruling). Status badges printed the
 * raw enum — `sent`, `partially_refunded`, `on_hold` — to a person on their first day. Every
 * badge reads from here now, and where the client sees the same state in the portal the wording
 * matches the portal's English (the portal says "Open" for `sent`; so does Ops).
 *
 * The maps are exhaustive over the database enums, and labels.spec holds them to the enum
 * values, so a new status is a build failure until it has a word.
 */

export const INVOICE_STATUS_LABEL = {
  draft: 'Draft',
  sent: 'Open', // the portal's word (inv_open) — one state, one word
  paid: 'Paid',
  overdue: 'Overdue',
  void: 'Cancelled', // the portal's word (inv_void)
  refunded: 'Refunded',
  partially_refunded: 'Partly refunded', // the portal's word (inv_partially_refunded)
  disputed: 'Under review', // the portal's word (inv_disputed)
} as const;

export const ENGAGEMENT_STATUS_LABEL = {
  draft: 'Draft',
  active: 'Active',
  on_hold: 'On hold',
  completed: 'Completed',
  withdrawn: 'Withdrawn',
} as const;

export const QUOTE_STATUS_LABEL = {
  draft: 'Draft',
  sent: 'Sent',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
  void: 'Withdrawn',
} as const;

export const TAX_STAGE_LABEL = {
  intake_started: 'Intake started',
  scheduled: 'Scheduled',
  documents_requested: 'Documents requested',
  pending_client_response: 'Waiting on client',
  in_preparation: 'In preparation',
  internal_review: 'Internal review',
  client_review: 'Client review',
  ready_to_file: 'Ready to file',
  filed: 'Filed',
  completed: 'Completed',
  on_hold: 'On hold',
  withdrawn: 'Withdrawn',
  rejected: 'E-file rejected',
} as const;

export const CONSENT_7216_LABEL = {
  not_on_file: 'Not on file',
  requested: 'Requested',
  signed: 'Signed',
  declined: 'Declined',
  revoked: 'Revoked',
} as const;

export const LETTER_STATUS_LABEL = {
  none: 'Not on file',
  pending: 'Pending signature',
  signed: 'Signed',
} as const;

/** The price book's service lines (price_service_line), in words: what a discount rule reaches, for one. */
export const PRICE_SERVICE_LINE_LABEL = {
  individual_tax: 'Individual tax returns',
  business_tax: 'Business tax returns',
  recurring_accounting: 'Recurring accounting',
  scope_ladder: 'Scope ladder',
  setup_conversion: 'Setup and conversion',
  software_passthrough: 'Software pass-through',
  filings_1099_w2: '1099 / W-2 filings',
  entity_services: 'Entity services',
  attest: 'Attest',
  specialized_cpa: 'Specialized CPA',
  coo: 'COO services',
  deposit: 'Deposits',
} as const;

/** R75: a price-book discount rule's condition (who qualifies) and scope (when), in words. */
export const DISCOUNT_CONDITION_LABEL = {
  referred_by_hilo: 'Referred by Hilo on the record',
} as const;
export const DISCOUNT_SCOPE_LABEL = {
  first_engagement: 'First engagement only',
} as const;

/** The word for a status; an unknown value falls back to the raw enum with underscores spaced, never crashes a page. */
export function invoiceStatusLabel(status: string): string {
  return (INVOICE_STATUS_LABEL as Record<string, string>)[status] ?? status.replaceAll('_', ' ');
}
export function engagementStatusLabel(status: string): string {
  return (ENGAGEMENT_STATUS_LABEL as Record<string, string>)[status] ?? status.replaceAll('_', ' ');
}
export function quoteStatusLabel(status: string): string {
  return (QUOTE_STATUS_LABEL as Record<string, string>)[status] ?? status.replaceAll('_', ' ');
}
export function taxStageLabel(stage: string): string {
  return (TAX_STAGE_LABEL as Record<string, string>)[stage] ?? stage.replaceAll('_', ' ');
}
export function consent7216Label(status: string): string {
  return (CONSENT_7216_LABEL as Record<string, string>)[status] ?? status.replaceAll('_', ' ');
}
export function letterStatusLabel(status: string): string {
  return (LETTER_STATUS_LABEL as Record<string, string>)[status] ?? status.replaceAll('_', ' ');
}
export function priceServiceLineLabel(line: string): string {
  return (PRICE_SERVICE_LINE_LABEL as Record<string, string>)[line] ?? line.replaceAll('_', ' ');
}
export function discountConditionLabel(condition: string): string {
  return (DISCOUNT_CONDITION_LABEL as Record<string, string>)[condition] ?? condition.replaceAll('_', ' ');
}
export function discountScopeLabel(scope: string): string {
  return (DISCOUNT_SCOPE_LABEL as Record<string, string>)[scope] ?? scope.replaceAll('_', ' ');
}

/**
 * "Business — owner" (R51, 2026-09-26): what every Ops client search prints for a row the search
 * reached through a business legal name; the person's name when it matched the person. The API says
 * which (`business_matched`), so Deliver Return, New quote and the clients list read the same.
 */
export function clientSearchLabel(r: { first_name: string; last_name: string; business_name?: string | null; business_matched?: boolean | null }): string {
  const person = `${r.first_name} ${r.last_name}`;
  return r.business_matched && r.business_name ? `${r.business_name} — ${person}` : person;
}

/**
 * The engagement's status in plain words (R52, 2026-09-26): the state, and for one that is paused or
 * over, the day that happened. The caller formats the days (dayOf for the pause instant, formatDate
 * for the calendar day it ended), so this file stays a map of words with no date dependency.
 */
export function engagementStatusSentence(status: string, days: { pausedDay?: string | null; endedDay?: string | null; billingHold?: boolean } = {}): string {
  const word = engagementStatusLabel(status);
  // R68 (2026-09-26): the importer's billing hold is not a work hold; the sentence says both facts.
  const hold = days.billingHold ? ' · billing on hold (imported)' : '';
  if (status === 'on_hold' && days.pausedDay) return `${word} since ${days.pausedDay}${hold}`;
  if ((status === 'completed' || status === 'withdrawn') && days.endedDay) return `${word} on ${days.endedDay}${hold}`;
  return `${word}${hold}`;
}
