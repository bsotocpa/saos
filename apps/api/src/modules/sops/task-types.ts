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
  call_ticket: { sop: 'rene-phone-flow' },
  sms_unmatched: { sop: 'rene-unmatched-inbound' },
  invoice_overdue: { sop: 'rene-dunning-call' },
  invoice_needed: { sop: 'rene-invoice-on-filed' },
  quote_accepted: { sop: 'rene-quote-accepted-onboarding' },
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
