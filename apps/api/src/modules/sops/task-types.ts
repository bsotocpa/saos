// The canonical registry of task source types and their SOPs.
//
// CLAUDE.md, non-negotiable: "task types carry an optional 'how to do this' link
// into the knowledge base; building a task-generating feature without its SOP
// hook is incomplete."
//
// This file is the enforcement point. `scripts/check-task-sop-hooks.mjs` greps
// the API source for every `sourceType: '...'` literal and fails the build if one
// is missing here — so a new task-generating feature cannot ship without someone
// deciding, in writing, whether it needs a procedure.
//
// `null` means "no SOP needed", and the reason is mandatory. That is a real
// answer for a task whose title IS the instruction ("Fix the stale nightly
// backup"); it is not a place to park work you didn't want to think about.

export interface TaskTypeSop {
  /** SOP slug, or null when the task genuinely needs no procedure. */
  sop: string | null;
  /** Required when sop is null. Shown in the admin registry view. */
  reason?: string;
}

export const TASK_TYPE_SOPS: Record<string, TaskTypeSop> = {
  // ── Client comms & billing (Rene) ──────────────────────────────────────────
  ladder_call: { sop: 'rene-escalation-call' },
  dunning_call: { sop: 'rene-dunning-call' },
  // A known client asked for a sign-in link and could not get one. Same fix as a
  // bounced link — confirm the address and grant access — so it shares that SOP.
  portal_access_blocked: { sop: 'rene-portal-access' },
  call_ticket: { sop: 'rene-phone-flow' },
  sms_unmatched: { sop: 'rene-unmatched-inbound' },
  invoice_overdue: { sop: 'rene-dunning-call' },
  invoice_needed: { sop: 'rene-invoice-on-filed' },
  quote_accepted: { sop: 'rene-quote-accepted-onboarding' },
  /*
   * ── The eight types that were invisible until 2026-08-17 ──
   *
   * All eight were created by raw `INSERT INTO tasks`, so `check-task-sop-hooks.mjs` — which
   * reads task types emitted through `createTask()` — never saw them and nobody was ever asked
   * to decide. Routing them through the one door surfaced eight unmade decisions at once.
   * That is the SOP hole Brian named, and this block is what closed it.
   */
  /** A booked question call. Free by policy — the SOP is where "free" stops. */
  booking_question: { sop: 'rene-question-call' },
  /** Restoring IL Secretary of State good standing: a filing procedure with an order. */
  sos_check: { sop: 'laura-sos-restore' },
  /** Collecting an SSN by phone. PII handling with hard rules, so it gets written rules. */
  ssn_by_phone: { sop: 'rene-ssn-by-phone' },
  /** A client asked for a service and we promised 24 hours. */
  service_request: { sop: 'rene-service-request' },
  /** Same work as any other portal lockout — reuses the SOP that already covers it. */
  magic_link_bounce: { sop: 'rene-portal-access' },
  /** Filing an annual report; Laura's procedure already existed and was simply unwired. */
  annual_report: { sop: 'laura-annual-report' },
  /**
   * Chasing the formation date for a business enrolled in tracking without one, so its row stops
   * being a silent no-op. Same SOP — step one of it is "confirm the state and the actual due
   * date", which is this task with the answer still missing.
   */
  annual_report_setup: { sop: 'laura-annual-report' },
  /*
   * WAS `sop: null`, and that was wrong (Brian, 2026-08-17).
   *
   * My reasoning had been "the six checklist items ARE the procedure". They are not — they are
   * the NAMES of the six steps. "Verify professional license (IDFPR)" tells you what to do only
   * if you already know which register to search, what a lapsed licence means for the
   * conversion, and who to stop and ask. The task names each step; the SOP explains it.
   *
   * The two share structure literally: `laura-pllc-conversion` has one `### N. <step>` section
   * per checklist item, headings verbatim, and `scripts/check-sop-task-alignment.mjs` fails the
   * build if they drift. That is what makes a page-per-step safe to have rather than a second
   * description of the same work waiting to disagree.
   */
  pllc_conversion: { sop: 'laura-pllc-conversion' },
  enrichment: {
    sop: null,
    reason:
      'The task body lists the exact fields that are missing and says the portal first-login backfill resolves most of them on its own. There are two moves — fill them from what we already hold, or wait for the client to log in — and both are in the task. An SOP page would restate it. STILL null after 2026-08-17, when the entity-type gap gained a third move (look it up at the Secretary of State) and a stated consequence (nothing enrols in annual-report tracking on an unknown type): both went into the task body, naming the businesses, rather than onto a page the reader would have to go and find.',
  },
  meeting_action_item: {
    sop: null,
    reason:
      'The action item IS the procedure: it is a commitment someone made out loud in the session, captured verbatim as the task description. A generic page about how to do an unknown thing cannot be written, and writing one per item is what the task already is.',
  },
  /*
   * #48. `sop: null` deliberately: the task's own description IS the procedure — the
   * invoice is a draft on the client record and the one action is to send it. An SOP page
   * would say the same sentence a click further away, and this task is P1 precisely
   * because the client is sitting there waiting for a payment link that never arrived.
   */
  invoice_send_failed: {
    sop: null,
    reason:
      'The procedure is one action and the task already names it: the deposit invoice is sitting as a draft on the client record, and it needs sending. An SOP page would repeat that sentence a click further away, which is the wrong trade for a P1 task that exists because a client is waiting on a payment link they never received.',
  },
  /*
   * #48 part two. Deliberately NOT null: this one needs a written procedure, because the
   * right first move is not obvious. The client is a hot lead with a broken checkout, the
   * quote is open again, nothing was charged — and whether to call them, accept on their
   * behalf, or wait for a fix depends on why it failed. That is a judgement call, which is
   * exactly what an SOP is for.
   */
  acceptance_failed: { sop: 'rene-acceptance-failed' },
  /*
   * #48 outbox dead letter. `sop: null`: the task's description carries the whole procedure —
   * the record is fine, only delivery failed, so send it by hand and then find out why
   * delivery broke. What the effect WAS is named in the title, so one SOP page covering every
   * effect would have to be vaguer than the task already is.
   */
  outbox_abandoned: {
    sop: null,
    reason:
      'The task names which delivery failed and to whom, and the fix is to send that one thing by hand from the client record. An SOP would have to generalise across every effect type and would say less than the task does.',
  },
  client_non_response: { sop: 'rene-escalation-call' },

  // ── Tax (Ana-Maria) ───────────────────────────────────────────────────────
  irs_notice: { sop: 'ana-notice-playbook' },
  efile_reject: { sop: 'ana-efile-reject' },
  extension_batch_review: { sop: 'ana-extension-batch' },
  resolution_year: { sop: 'ana-resolution-year' },
  transcript_request: { sop: 'ana-transcript-request' },
  // Caught by check-task-sop-hooks.mjs on its first run — the resolution lane
  // shipped this task without an SOP decision, which is exactly the gap the
  // rule exists to catch.
  f8821_send: { sop: 'ana-8821-authorization' },
  intake_irs_letters: { sop: 'ana-notice-playbook' },

  // ── Books (Marian) ────────────────────────────────────────────────────────
  close_cycle: { sop: 'marian-month-end-close' },
  close_session_scheduling: { sop: 'marian-close-session-scheduling' },
  /*
   * #33: the same act, asked for from the client record instead of falling out of a
   * books close. It points at the same SOP because the work is identical once the task
   * exists — send the booking link, do not double-book — and the calendar cross-check
   * that decides whether the task should exist at all is enforced in the endpoint.
   */
  client_session_scheduling: { sop: 'marian-close-session-scheduling' },

  // ── Nonprofit / grants (Jackson) ──────────────────────────────────────────
  voucher_period: { sop: 'jackson-grant-voucher-period' },
  referral_approval: { sop: 'jackson-referral-approval' },
  // Caught by the build check the moment Hilo events added it — which is the
  // whole point of the guard.
  event_followup: { sop: 'jackson-event-followup' },

  // ── Onboarding & health (Brian) ───────────────────────────────────────────
  onboarding_stalled: { sop: 'brian-stalled-onboarding' },
  onboarding_flag: { sop: 'brian-stalled-onboarding' },
  stalled_flag: { sop: 'brian-stalled-onboarding' },
  health_red: { sop: 'brian-health-red' },
  quote_declined: { sop: 'brian-quote-declined' },

  // ── Booking hygiene ───────────────────────────────────────────────────────
  booking_not_zoom: { sop: 'booking-zoom-only' },
  booking_unmapped: { sop: 'booking-unmapped-event-type' },
  booking_discovery: {
    sop: null,
    reason:
      'A booked discovery call needs no written procedure — the procedure is the meeting, which is Brian’s own work. This task exists so the booking is visible in someone’s queue at all, which used to be a side effect of the deposit invoice landing in A/R before the booking charge was retired (2026-08-14).',
  },

  // Finding #14. Deliberately NOT null: the hard part of an infected client upload
  // is the conversation, not the quarantine. The technical side is automatic (stored,
  // unfileable, undownloadable) — what needs a written procedure is how to ask a
  // client for a replacement without accusing them of something they almost certainly
  // did not do on purpose, and when a repeat infection stops being an accident.
  document_infected: { sop: 'brian-infected-upload' },

  // ── Ops tasks whose title is the whole instruction ─────────────────────────
  backup_stale: {
    sop: null,
    reason: 'The alert states the fix (check the cron and the B2 credentials); the restore-drill SOP covers the deeper procedure.',
  },
  container_unhealthy: {
    sop: null,
    reason:
      'The task description carries the whole procedure for this one, generated per container: the logs command, the health-inspect command, and the restart that clears a wedged service. A separate SOP would duplicate text that is already in front of whoever opens the task — and the first real instance (ClamAV wedged mid-database-reload) was fixed by exactly that restart.',
  },
  restore_drill: {
    sop: 'ops-restore-drill',
  },
  dubsado_retirement: {
    sop: null,
    reason: 'One-time migration decision with the checklist written into the task description itself.',
  },
  manual: {
    sop: null,
    reason: 'A staff-created ad-hoc task. The author decides whether it needs a procedure; the SOP field is available to them.',
  },
};

/** Every registered task type. */
export function registeredTaskTypes(): string[] {
  return Object.keys(TASK_TYPE_SOPS).sort();
}
