// Admin-configurable settings (MP Admin Interface: SLA windows, alert
// thresholds). Values here are the spec's defaults; Brian adjusts in admin.
// Seed NEVER overwrites an existing key — admin edits win over re-seeds.

export const settings = [
  // Owner-comp default for S corp conversions: 1/3 of net profits (MP v4.2 Setups).
  // A fraction, not a price — prices live in price_book.
  {
    key: 'owner_comp_default_fraction',
    value: { numerator: 1, denominator: 3 },
    description: 'S corp owner-comp default: 1/3 of net profits (MP v4.2).',
  },
  {
    key: 'sla.doc_request_reminder_days',
    value: 3,
    description: 'Days after a document request before the automated reminder (automation 4).',
  },
  {
    key: 'sla.client_non_response_alert_days',
    value: 7,
    description: 'Days of client non-response before Brian + Jackson are alerted (automation 5).',
  },
  {
    key: 'sla.irs_notice_unactioned_alert_hours',
    value: 48,
    description: 'Hours an IRS notice may sit unactioned before Brian + Jackson are alerted.',
  },
  {
    key: 'sla.irs_notice_escalation_deadline_days',
    value: 14,
    description: 'Response deadlines closer than this many days escalate to Brian.',
  },
  {
    key: 'irs_notice.default_response_days',
    value: 30,
    description: 'Auto response-deadline: notice date + this many days when the notice itself is not specific.',
  },
  {
    key: 'sla.invoice_unpaid_reminder_days',
    value: 14,
    description: 'Days an invoice may sit unpaid before the reminder + Rene flag (automation 17).',
  },
  {
    key: 'sla.service_request_response_hours',
    value: 24,
    description: 'Response commitment for portal service requests (MP Request a Service).',
  },
  {
    key: 'extension.decision_list_days_before',
    value: 21,
    description: 'T-minus days before Mar 15 / Apr 15 when the Extension Decision List generates (automation 10).',
  },
  {
    key: 'extension.auto_batch_cutoffs',
    value: { business: '03-25', individual: '04-01' },
    description:
      'v4.3 flow 3 auto-extension cutoffs (MM-DD): engagements still missing documents on these dates sweep into that lane’s protective-extension batch. Lane derives from the return’s ORIGINAL deadline month (March filers → business, April → individual). Brian approves each batch before preparers file.',
  },
  {
    key: 'extension.summer_chase_dates',
    value: ['06-01', '07-15', '08-15'],
    description: 'Summer document-chase reminder dates for extended clients (MM-DD, escalating copy).',
  },
  {
    key: 'extension.at_risk_no_docs_by',
    value: '08-15',
    description: 'Extended engagements without docs received by this date (MM-DD) flag red on the deadline dashboard.',
  },
  {
    key: 'annual_report.staff_reminder_days_before',
    value: 60,
    description: 'Annual report reminder to assigned staff (Laura) at T-minus days.',
  },
  {
    key: 'annual_report.client_reminder_days_before',
    value: 30,
    description: 'Annual report reminder to the client at T-minus days.',
  },
  {
    key: 'funder.pro_bono_rate_item_code',
    value: 'IND_SPECIALIZED_HOURLY',
    description:
      'Price-book item whose rate values pro bono hours for funder reports (hours × standard rate — MP Time Tracking). Never a hardcoded dollar figure.',
  },
  {
    key: 'booking.deposit_items',
    value: { 'new-client-discovery': 'DEPOSIT_1040', 'business-discovery': 'DEPOSIT_BUSINESS_TAX' },
    description:
      'Lane 1 (v4.2 two-lane booking): Cal.com event-type slug → price_book deposit item collected at booking. Add slugs here when event types are created (M23).',
  },
  {
    key: 'booking.question_slugs',
    value: ['general-inquiries'],
    description:
      'Lane 2: event-type slugs that are ALWAYS FREE ("Book a question call — no charge", codified retention asset).',
  },
  {
    key: 'referral.disclosure_policy_version',
    value: '2026-07-05.v1',
    description:
      'Version stamp logged with every Hilo→Soto disclosure acknowledgement (referral-integrity audit trail). Bump when Brian adopts a revised board policy.',
  },
  {
    key: 'sos.recheck_days',
    value: 90,
    description: 'IL SOS good-standing re-check cadence for active clients (days since last check).',
  },
  {
    key: 'pricing.estimate_band_percent',
    value: 15,
    description:
      'Estimate range width: one-time quote maximums widen by this percent (scope uncertainty). Recurring prices stay exact. ⚠ Default awaits Brian’s confirmation — tune here, no deploy needed.',
  },
  {
    key: 'ladder.days',
    value: [3, 7, 14, 30],
    description:
      'Escalation ladder rungs in days from waiting_since (v4.3/v4.5): portal reminder → SMS nudge → Rene call task → STALLED flag.',
  },
  {
    key: 'tasks.layout',
    value: {
      sections: [
        {
          title: 'Task Information',
          fields: [
            { key: 'assignedStaffId', label: 'Task Owner', required: false },
            { key: 'title', label: 'Subject', required: true },
            { key: 'dueDate', label: 'Due Date', required: false },
            { key: 'contactId', label: 'Contact', required: false },
            { key: 'businessId', label: 'Business', required: false },
            { key: 'status', label: 'Status', required: false },
            { key: 'priority', label: 'Priority', required: false },
            { key: 'remindAt', label: 'Reminder', required: false },
            { key: 'recurFreq', label: 'Repeat', required: false },
            { key: 'tags', label: 'Tags', required: false },
          ],
        },
        { title: 'Description Information', fields: [{ key: 'description', label: 'Description', required: false }] },
      ],
    },
    description:
      'v4.5 editable page layout for the task record (field order, sections, required flags). Edit here — the create/edit form renders from this. Extends the no-code module-builder pattern to tasks.',
  },
  {
    key: 'ops.last_restore_drill_at',
    value: null,
    description:
      'ISO timestamp of the last PASSING restore drill (scripts/restore-drill.sh). Update after each quarterly drill; null = never run → the daily job nags until the first one.',
  },
  {
    key: 'ops.restore_drill_interval_days',
    value: 90,
    description: 'Quarterly restore-drill cadence (WISP): a drill older than this opens a reminder for Brian.',
  },
  {
    key: 'health.red_below',
    value: 40,
    description: 'Health score below this = Red → alert assigned staff.',
  },
  {
    key: 'health.green_at_or_above',
    value: 70,
    description: 'Health score at/above this = Green; Green + tenure flags upsell (§7216-gated).',
  },
];

export async function seedSettings(client) {
  let inserted = 0;
  for (const s of settings) {
    const res = await client.query(
      `INSERT INTO app_settings (key, value, description)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO NOTHING`,
      [s.key, JSON.stringify(s.value), s.description]
    );
    inserted += res.rowCount;
  }
  return `${inserted} of ${settings.length} settings inserted (existing keys left untouched)`;
}
