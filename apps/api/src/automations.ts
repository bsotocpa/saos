// Client-acting automation gate (Brian's directive 2026-08-09).
//
// THE RULE: no automation sends anything to a client without passing through
// isAutomationEnabled(). Every gated automation has a row in the `automations`
// table (packages/db/seeds/data/automations.mjs) and ships DISABLED — Brian
// arms them individually in Admin as real clients reach the portal.
//
// The gate covers the CLIENT-FACING SEND only. Internal alerts, tasks, and
// state bookkeeping keep running (the notification-vs-task principle): staff
// never lose visibility because an outbound channel is disarmed. Every
// suppression is COUNTED and audited so the run record shows what would have
// gone out — that's how Brian decides when to arm each one.

import type { FastifyInstance } from 'fastify';

/**
 * Every gated automation, as runtime data (the seed in
 * packages/db/seeds/data/automations.mjs registers the same keys with their
 * admin-facing copy; a test asserts the two never drift).
 */
export const AUTOMATION_KEYS = [
  'escalation_ladder',
  'document_chase',
  'ar_dunning',
  'late_fees',
  'extension_notices',
  'estimate_reminders',
  'annual_report_client_reminders',
  'attachment_acks',
  'portal_upload_acks',
  'review_requests',
  'event_reminders',
  'session_recaps',
  'booking_confirmations',
  'sos_adverse_client_notice',
  // Item 9 (2026-09-09, Brian's ruling): the three client sends that fire from a system event
  // (a webhook, a void) rather than a person pressing Send on that message.
  'payment_receipt',
  'refund_receipt',
  'void_notice',
] as const;

export type AutomationKey = (typeof AUTOMATION_KEYS)[number];

/**
 * Is this client-acting automation armed? An UNREGISTERED key returns false —
 * a new automation is silent until it is registered and switched on, never
 * the other way round.
 */
export async function isAutomationEnabled(app: FastifyInstance, key: AutomationKey): Promise<boolean> {
  const { rows } = await app.db.query<{ enabled: boolean }>(
    `SELECT enabled FROM automations WHERE key = $1`,
    [key]
  );
  return rows[0]?.enabled === true;
}
