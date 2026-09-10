// Client-acting automation registry (Brian's directive 2026-08-09). EVERY
// entry ships enabled=false — Brian arms them individually in Admin as real
// clients reach the portal. The seed NEVER flips an existing row, so his
// choices survive every deploy and a NEW automation arrives disabled.
//
// Registering here is not optional: an automation that sends to a client
// without a row + gate check is a build failure (see apps/api/src/automations.ts).

export const automations = [
  {
    key: 'escalation_ladder',
    name: 'Escalation ladder (waiting-for-input chase)',
    description:
      'D3 portal-reminder email → D7 SMS nudge → D14 Rene call task → D30 stalled flag on tasks waiting on a client. OFF: rungs do not advance and nothing is sent; the waiting count still shows on the owner rollup.',
  },
  {
    key: 'document_chase',
    name: 'Document-request reminders',
    description:
      'Recurring reminder emails while a document request sits open (automation 4). OFF: no client email; the internal 7-day non-response alert to leadership still fires.',
  },
  {
    key: 'ar_dunning',
    name: 'A/R dunning (overdue-invoice reminders)',
    description:
      'Client reminder emails on invoices past the unpaid window (automation 17). OFF: invoices still flip to overdue and Rene is still flagged — the client just is not chased.',
  },
  {
    key: 'late_fees',
    name: 'Late fees on overdue balances',
    description:
      'Applies the price-book late-fee rate to balances 30+ days past due. Engagement-letter disclosure gate applies regardless. OFF: no fee is ever assessed.',
  },
  {
    key: 'extension_notices',
    name: 'Extension client notices + summer chase',
    description:
      'Bilingual extension-filed notices, payment-estimate prompts, and the Jun/Jul/Aug document chase for extended clients. OFF: the internal decision list and at-risk flags still run.',
  },
  {
    key: 'estimate_reminders',
    name: 'Quarterly estimated-payment reminders',
    description:
      'T-7 reminder emails before each estimate due date (per-client toggle still applies on top). OFF: the staff deadline board still shows the dates.',
  },
  {
    key: 'annual_report_client_reminders',
    name: 'Annual-report client reminders (T-30)',
    description:
      'Client-facing annual-report reminder 30 days out. OFF: the T-60 staff reminder and compliance task still fire.',
  },
  {
    key: 'attachment_acks',
    name: 'Inbound-attachment acknowledgements',
    description:
      'Warm reply when a client emails/texts a file, pointing at the secure portal link. Transactional (a reply to something they just sent) — recommended ON once client intake begins. OFF: the file is still accepted, scanned, and quarantined for review.',
  },
  {
    key: 'portal_upload_acks',
    name: 'Portal-upload acknowledgements',
    description:
      'Receipt confirmation when a client uploads through the portal, saying what happens next. Separate from attachment_acks on purpose: that one redirects people away from email attachments, and telling a client who just used the portal to use the portal is nonsense. THROTTLED to one ack per client per window (booking.upload_ack_throttle_minutes) so a ten-file upload session sends one email, not ten. OFF: the upload still works, is still scanned, and is still filed — the client simply is not told.',
  },
  {
    key: 'review_requests',
    name: 'Google review asks (milestone-triggered)',
    description:
      'Asks for a Google review after an ACCEPTED return or a completed onboarding. Throttled to one ask per client per 180 days, and never sent to a client with an open or recent IRS notice, an overdue invoice, paused work, or a stalled onboarding — a review ask at those moments invites the review you least want. OFF: the decision still runs and every skip is recorded, so you can see what arming it would send.',
  },
  {
    key: 'event_reminders',
    name: 'Hilo workshop reminders (T-1)',
    description:
      'The day-before reminder for Hilo workshops — email, plus SMS only where the registrant ticked the box at signup AND the contact carries standing TCPA consent. OFF: the registration CONFIRMATION still goes out (that is transactional, a reply to something they just did), the check-in list is unaffected, and every suppressed reminder is counted in the job record.',
  },
  {
    key: 'session_recaps',
    name: 'Session recaps to clients',
    description:
      'Sends the bilingual session recap to the client\'s portal thread and emails a pointer to it — only ever after YOU approve it; nothing here auto-sends. OFF: recaps still draft themselves after each session and still queue for your approval, and an approved recap waits at "approved" with the reason recorded instead of going out. Arm this once you are happy with the recap copy on a few real sessions.',
  },
  {
    key: 'booking_confirmations',
    name: 'Booking confirmation email (discovery calls)',
    description:
      'Confirms a booked discovery call and says plainly that there is nothing to pay now — the deposit comes with the engagement quote. Cal.com already sends its own calendar confirmation, so this one exists to set the money expectation. OFF: the booking is still recorded, the contact is still created or linked, the discovery call still lands in the team\'s queue, and the suppression is counted in the audit record. Arm this when real clients start booking. Registered 2026-08-14, when the booking-time deposit charge was retired — that flow used to email a checkout link, so this is what replaced it.',
  },
  {
    key: 'sos_adverse_client_notice',
    name: 'IL SOS adverse-standing notice to the client',
    description:
      'Emails the client their bilingual fix-steps when a manual ILSOS lookup finds their entity is NOT in good standing. OFF: Laura still gets the restoration task with all six steps, still gets the alert, and the suppression is logged — only the client-facing email waits. Registered 2026-09-06 as a FIX: this send had shipped with no toggle and no gate at all, which is a build failure by the rule at the top of this file. It reached nobody only because the automated lookup that triggered it never once succeeded. Arm it when you want clients told without you seeing the wording first — an adverse standing is a conversation most owners would rather have from a person.',
  },
];

export const ITEM_9_2026_09_09 = [
  {
    key: 'payment_receipt',
    name: 'Payment receipt (email after a card payment)',
    description:
      'Emails the client a receipt when Stripe confirms a payment on their invoice. OFF: the invoice still flips to Paid, the tax engagement still reads paid, the send log records "receipt held — automation off", and Stripe\u2019s own receipt (if enabled in the dashboard) is unaffected. Registered 2026-09-09 (item 9): a send that fires from a webhook, not from a person pressing Send.',
  },
  {
    key: 'refund_receipt',
    name: 'Refund receipt (email after a refund is recorded)',
    description:
      'Emails the client when a refund lands on their invoice. OFF: the invoice still reads Refunded / Partially refunded with the amount, and the send log records the hold. Registered 2026-09-09 (item 9): fires from the Stripe webhook, not from a person.',
  },
  {
    key: 'void_notice',
    name: 'Cancellation notice (email when an invoice is voided)',
    description:
      'Emails the client that an invoice they may hold a pay link for was cancelled. OFF: the invoice still reads Cancelled in the portal, its pay link is dead, and the send log records the hold — but nobody tells the client unless a person does. Registered 2026-09-09 (item 9): the void is a person\u2019s action; the notice was automatic.',
  },
];
automations.push(...ITEM_9_2026_09_09);

export async function seedAutomations(client) {
  let inserted = 0;
  for (const a of automations) {
    const res = await client.query(
      `INSERT INTO automations (key, name, description, audience, enabled)
       VALUES ($1, $2, $3, 'client', false)
       ON CONFLICT (key) DO NOTHING`,
      [a.key, a.name, a.description]
    );
    inserted += res.rowCount;
  }
  return `${inserted} of ${automations.length} automations registered (all ship DISABLED; existing rows untouched)`;
}
