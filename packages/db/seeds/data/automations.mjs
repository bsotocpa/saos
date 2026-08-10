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
];

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
