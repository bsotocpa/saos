/*
 * THE REGISTER OF CLIENT-FACING SENDS THAT ARE NOT AUTOMATION-GATED.
 *
 * CLAUDE.md, non-negotiable: "every automation that sends to a client … is registered in the
 * `automations` table, gated by `isAutomationEnabled()`, and seeded `enabled = false`. A
 * client-facing send without a registered toggle + gate check is a build failure."
 *
 * That sentence had no enforcement until 2026-09-06, which is how the `sos_fix_steps`
 * adverse-standing email shipped with neither. `scripts/check-client-send-gates.mjs` now finds
 * every `sendTemplatedEmail` / `sendSms` call in the API and fails the build unless the enclosing
 * function checks the gate or appears here with a written reason.
 *
 * ── WHY A REGISTRY AND NOT "GATE EVERYTHING" ──
 *
 * Not every client-facing send is an automation, and gating the ones that are not would be worse
 * than leaving them alone. A magic-link email exists because the client asked for one three
 * seconds ago and is watching for it; an admin toggle over that is a kill switch on the front
 * door, and the failure mode is every client locked out of the portal with nothing to connect it
 * to a setting.
 *
 * THE LINE: did a person or a client ask for this exact message right now, or did the SYSTEM
 * decide to send it? The second kind gets a toggle. The first kind must not — a toggle between a
 * staff member pressing Send and the message leaving is a silent failure waiting to happen.
 *
 * `reason` is mandatory and is the point. Same discipline as `sop: null` in the task-type
 * registry: not "gate everything", but "decide, in writing, where the next person will find it".
 *
 * Keys are `<path under apps/api/src>:<enclosing function>`.
 */

export interface UngatedClientSend {
  /** Why this send is not behind an automation toggle. Required — the guard enforces it. */
  reason: string;
}

export const UNGATED_CLIENT_SENDS: Record<string, UngatedClientSend> = {
  // ── The client asked for this, seconds ago, and is watching for it ──────────
  'modules/portal-auth/service.ts:issueMagicLink': {
    reason:
      'The client just clicked "send me a sign-in link" and is looking at the screen. A toggle here is a kill switch on the front door: flip it and every client is locked out of the portal with no error anyone would connect to a setting. The controls that belong on this are rate limiting (3 per window, already enforced) and link expiry, not arming.',
  },
  'modules/billing/service.ts:markInvoicePaid': {
    reason:
      'The receipt for a payment the client made a moment ago, triggered by the Stripe webhook for their own card. Suppressing it would mean taking money and going quiet, which is worse than any risk arming protects against.',
  },

  // ── A person pressed Send on this specific message ──────────────────────────
  'modules/pricing/quotes.ts:sendQuote': {
    reason:
      'A staff member built this quote and pressed Send. Gating a deliberate human action would mean a person clicks send, sees success, and nothing goes out. The real control on this path is the PLACEHOLDER template gate, which refuses and says WHY.',
  },
  'modules/billing/service.ts:sendInvoiceNow': {
    reason:
      'One named invoice going out — either a staff member pressed Send, or acceptance enqueued the deposit invoice the client is waiting for after agreeing to pay it. The RECURRING chase over unpaid invoices is a different path (billing/dunning.ts) and IS gated as `ar_dunning`. Arming this one would break checkout for a client who has already said yes.',
  },
  'modules/bookkeeping/close.ts:completeClose': {
    reason:
      'The finished monthly close, sent when a staff member completes it. This is the deliverable the client pays for; a toggle that silently withholds it is a way to lose a client without anyone noticing.',
  },
  'modules/documents/service.ts:afterReturnDelivered': {
    reason:
      'The return is finished and a staff member delivered it. Same reasoning as the close: the message IS the delivery, and suppressing it means the work is done and the client does not know.',
  },
  'modules/referrals/service.ts:sendReferral': {
    reason:
      'A staff member chose this person and pressed Send on a referral introduction. Not a campaign — one message, one recipient, one decision, made by a human seconds earlier.',
  },
  'modules/billing/routes.ts:registerBillingRoutes': {
    reason:
      'The one-off "remind this client about this invoice" button. A staff member looked at an unpaid invoice and chose to nudge; the route even refuses if the invoice is already paid. The AUTOMATED chase over the same invoices is billing/dunning.ts and is gated as `ar_dunning` — this is a person deciding to do once what that automation would do on a schedule.',
  },
  'modules/tax/routes.ts:registerTaxRoutes': {
    reason:
      'The document request a preparer just built, item by item, and sent — the client is being told what is needed to continue their return. The recurring reminders that follow while it sits open ARE gated, as `document_chase`. Arming the first message would mean a preparer assembles a list, presses send, and the client never learns anything is wanted.',
  },

  // ── Gated, but by something stronger than an automation toggle ──────────────
  'modules/comms/broadcast.ts:sendBroadcast': {
    reason:
      'Broadcasts carry a STRICTER control than arming, per CLAUDE.md: the send refuses any status but `approved`, and a database CHECK prevents a row reaching `sent` without a named approver — so even direct SQL cannot produce an unapproved send. Suppression (unsubscribe, TCPA opt-out) is enforced at send time and shown to the approver beforehand. An on/off toggle on top would be the weaker of the two controls, and would let someone believe the campaign went out when it did not.',
  },
  'modules/engagements/packet.ts:deliverPacketSignatureLink': {
    reason:
      'Delivering the signature link for a packet a staff member deliberately sent — the step the whole engagement is waiting on. Its gate is the PLACEHOLDER template check, which refuses to send an unwritten engagement letter and names what is wrong, rather than going quiet. Reached through the outbox so a delivery failure raises `outbox_abandoned` loudly instead of vanishing.',
  },
};

/** Every registered key, for the guard and for the admin registry view. */
export const UNGATED_CLIENT_SEND_KEYS = Object.keys(UNGATED_CLIENT_SENDS);
