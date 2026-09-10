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
