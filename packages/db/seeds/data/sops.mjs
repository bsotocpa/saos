// Starter SOPs for the processes the spec names by person: Rene's phone flows,
// Marian's close checklist, Ana-Maria's notice playbook, Laura's annual-report
// steps — plus the ones the task registry points at.
//
// These ship PUBLISHED but deliberately SHORT. They are real skeletons of the
// procedure as it exists in the code (stages, gates, who owns what), not invented
// detail: writing steps Brian never agreed to would be worse than an empty KB,
// because a new hire would follow them. Each ends with the same honest marker.
//
// Seed never overwrites an existing SOP — Brian's edits win over re-seeds.

const NEEDS_BRIAN =
  '\n\n---\n**⚠ Skeleton.** These steps come from what the system enforces, not from ' +
  'Brian dictating the procedure. Add the judgement calls, the phone wording, and the ' +
  'exceptions before treating this as complete.';

const sop = (slug, title, roleKey, process, body) => ({
  slug,
  title,
  roleKey,
  process,
  bodyMd: body.trim() + NEEDS_BRIAN,
});

export const sops = [
  // ── Rene (client comms + billing) ──────────────────────────────────────────
  sop('rene-phone-flow', 'Answering the phone', 'comms_billing', 'Client communications', `
## When a call comes in
1. Every call becomes a **call ticket** task — the system creates it, you work it.
2. Identify the client. If the number is unmatched, the ticket says so; do not guess.
3. Questions are **always free** (firm policy). Never quote a price on a support call.
4. Anything needing a document: point them at the **portal**. Documents never travel
   by email attachment or text.
5. Close the ticket with what happened, not just "done".
`),
  sop('rene-escalation-call', 'The D14 escalation call', 'comms_billing', 'Client communications', `
## Why you have this task
The client has been in "waiting for input" for 14 days. Two automated nudges
(portal reminder at D3, text at D7) already went out. You are rung three.

1. Read the task's linked engagement first — know what you are waiting for.
2. Call. Do not email; email is what already failed twice.
3. If you reach them: agree a date and put it in the task.
4. If you do not: log the attempt. At D30 the engagement flags STALLED to Brian.
`),
  sop('rene-dunning-call', 'Overdue invoice call', 'comms_billing', 'Billing', `
## Why you have this task
An invoice has been unpaid past the reminder window, or three dunning emails have
gone out without payment.

1. Check whether a **deposit or credit** already covers the balance — the system
   nets those first, but confirm before you call.
2. Never mention a late fee unless the invoice shows one. Late fees only apply
   where the signed engagement letter carries the disclosure.
3. Agree a date or a plan. Work pauses at 30 days past due — say so plainly and
   without threat.
`),
  sop('rene-unmatched-inbound', 'Unmatched inbound message or file', 'comms_billing', 'Client communications', `
## Why you have this task
Something arrived from a number or address we cannot match to a client.

1. Attachments are **accepted, never rejected** — it is already scanned and
   quarantined.
2. Triage only. Do NOT file anything to a client folder until you have confirmed
   who sent it; the confirm tap is the control.
3. Sensitive document types from unknown senders get no auto-suggestions on
   purpose. Identify the person first.
`),
  sop('rene-invoice-on-filed', 'Invoice a filed return', 'comms_billing', 'Billing', `
## Why you have this task
A return reached Filed. If it had a final fee the invoice generated itself; if it
did not, you are here because the fee is missing.

1. Get the final fee from the preparer — do not invent it.
2. If the final exceeds the estimate top, a scope-creep reason is **required**.
3. The invoice goes out with a portal pay link, never a reply-to-pay.
`),
  sop('rene-quote-accepted-onboarding', 'A quote was accepted', 'comms_billing', 'Onboarding', `
## Why you have this task
A client accepted a proposal. The engagement and any deposit invoice already exist.

1. Send the engagement letter and the §7216 consent. Neither can send while the
   template is flagged PLACEHOLDER — that is a launch gate, not a bug.
2. Open the portal checklist for them.
3. If the deposit was reduced or waived, the engagement is stamped — do not
   re-invoice it.
`),

  // ── Ana-Maria (tax + notices) ──────────────────────────────────────────────
  sop('ana-notice-playbook', 'IRS notice playbook', 'tax_preparer', 'IRS notices', `
## Clock
A notice must be actioned within **48 hours** or it escalates to Brian and Jackson.

1. Log the notice type, tax year, and the response deadline from the letter itself.
2. Never route an old year to e-file — the filing lane derives from the year.
3. Draft the response; Brian reviews anything with money attached.
4. The notice is not resolved until the response is sent AND the outcome recorded.
`),
  sop('ana-efile-reject', 'E-file rejection', 'tax_preparer', 'Tax pipeline', `
## Why you have this task
A return was filed and the IRS rejected it. **Filed is not the finish line** —
acceptance is.

1. Read the reject code. The perfection period is 5 calendar days (individual) or
   10 business days (business) — the system has already set the deadline.
2. Fix and re-file inside the window. Re-filing clears the clock.
3. If the window will pass, tell Brian before it does, not after.
`),
  sop('ana-extension-batch', 'Protective extension batch', 'tax_preparer', 'Tax season', `
## Why you have this task
The sweep window opened (original due date minus the admin offset, default 10
days) and a batch of at-risk returns was drafted.

1. Review every engagement in the batch. Removing one is a decision, so say why.
2. Approve the batch — nothing files without approval.
3. Extension notices to clients are gated by the extension_notices automation.
   If it is off, the internal work still happened; the client email did not.
`),
  sop('ana-resolution-year', 'A resolution year', 'tax_preparer', 'Tax resolution', `
## Why you have this task
A multi-year resolution case spawned one engagement per unfiled year, chained
**oldest year first** so carryforwards flow forward.

1. Do not start this year until its blocker is complete — the system will refuse.
2. Check the filing lane: current + 2 prior e-file; older is **paper**, with a wet
   signature and certified mail.
3. Watch the refund statute on the task — three years from the original due date.
   Once it passes, the refund is gone and the client should be told plainly.
`),
  sop('ana-transcript-request', 'Request IRS transcripts', 'tax_preparer', 'Tax resolution', `
## Why you have this task
The client signed the 8821, which authorises transcript access.

1. An 8821 authorises **transcripts**, not representation. Anything adversarial
   needs a 2848 for that specific year.
2. Pull account and wage-and-income transcripts for every year in the case.
3. Attach them to the case; they drive which years actually need filing.
`),
  sop('ana-8821-authorization', 'The 8821 authorization envelope', 'tax_preparer', 'Tax resolution', `
## Why you have this task
A resolution case needs transcript access before any document work starts.

1. Send the 8821 envelope. Nothing else in the case proceeds until it is signed.
2. On signature, the transcript-request task creates itself.
3. If the client also needs representation, that is a **2848**, per year, and the
   system will refuse representation actions without one.
`),

  // ── Marian (books) ─────────────────────────────────────────────────────────
  sop('marian-month-end-close', 'Month-end close', 'bookkeeper', 'Bookkeeping', `
## The four steps, in order
1. **Categorize** every transaction.
2. **Reconcile** every account.
3. **Statements ready** — compile and check them.
4. **Close** — statements post to the client portal automatically.

Notes
- The order is enforced; you cannot close a period you have not reconciled.
- On close, the system checks for an upcoming client session. If one exists the
  statements attach to it; if not, a scheduling task is created. Never create a
  session by hand without checking first.
`),
  sop('marian-close-session-scheduling', 'Schedule a close review session', 'bookkeeper', 'Bookkeeping', `
## Why you have this task
A close finished and the client had no upcoming session to attach the statements to.

1. Check the client's cadence — how often are they entitled to a CPA session?
2. Book inside that cadence. Do not add sessions the engagement does not include.
3. An active S corp is never below two sessions a year; the configurator enforces it.
`),

  // ── Laura (entity) ─────────────────────────────────────────────────────────
  sop('laura-annual-report', 'Annual report filing', 'entity_admin', 'Entity services', `
## Clock
You are reminded at **T-60**; the client is reminded at T-30 (that email is gated
by the annual_report_client_reminders automation).

1. Confirm the entity's state and its actual due date — it derives from the state
   and formation date, never a fixed calendar entry.
2. Check IL SOS good standing before filing. Not-in-good-standing is its own task.
3. File, record the confirmation, and store it against the business.
`),

  // ── Jackson (nonprofit / grants) ───────────────────────────────────────────
  sop('jackson-grant-voucher-period', 'Grant voucher period', 'ed_coo', 'Grants', `
## Why you have this task
A voucher period is due or past its funder date.

1. The system tracks **status only** — it never generates voucher files. You
   prepare the voucher outside SAOS.
2. Record submission when it happens; the reminders stop then and not before.
3. Grant 1099 export defaults to **1099-MISC Box 3**, never NEC.
`),
  sop('jackson-referral-approval', 'Approve a referral', 'ed_coo', 'Referrals', `
## Why you have this task
A referral is waiting on approval.

1. Hilo → Soto referrals cannot send without the alternatives-exist **disclosure**
   on record. The database enforces this; do not try to work around it.
2. Where tax data is involved, §7216 consent is required first.
3. Approve or decline with a note. Silence is not a decision.
`),

  sop('jackson-event-followup', 'Post-workshop follow-up', 'ed_coo', 'Hilo events', `
## Why you have this task
A workshop was closed out. No-shows are recorded, and the out-survey has gone to
everyone who attended.

1. Attendees are **members of the public**, not contacts. Nothing was imported into
   the CRM — link the ones who want ongoing help, deliberately, one at a time.
2. Any referral to Soto stays **§7216-gated** and needs the alternatives-exist
   disclosure on record. The database will refuse a referral without it.
3. Survey replies come back by email. Record them against the registration so the
   satisfaction and NPS averages feed the funder report.
4. Attendance rate matters to funders as much as headcount — the no-show number is
   already there, do not quietly drop it.
`),

  // ── Brian (owner decisions) ────────────────────────────────────────────────
  sop('brian-stalled-onboarding', 'Stalled onboarding', 'ceo', 'Onboarding', `
## Why you have this task
A client started onboarding and stopped. At Day 60 this becomes your decision.

1. The deposit is **held as a credit**. The system never auto-refunds.
2. Options: keep chasing, apply the credit to a smaller scope, pause formally, or
   refund deliberately.
3. Whatever you choose, record it — this is the task that closes the loop.
`),
  sop('brian-health-red', 'A client turned red', 'ceo', 'Client health', `
## Why you have this task
A client's health band dropped to red on real signals, not on absence of activity.

1. Read which signal fired. Migrated-but-never-engaged is **gray**, not red.
2. Decide: intervene, reassign, or accept and note why.
`),
  sop('brian-quote-declined', 'A quote was declined', 'ceo', 'Sales', `
## Why you have this task
A client declined a proposal and gave a reason.

1. Read the reason — it is on the task and in the pipeline report.
2. If it is scope or timing, re-quote. If it is price, that is pricing information,
   not a loss to bury.
3. Close the lead or re-open it. Either is fine; leaving it is not.
`),

  // ── Booking + ops ──────────────────────────────────────────────────────────
  sop('booking-zoom-only', 'A discovery call was not booked on Zoom', null, 'Booking', `
## Why you have this task
Discovery calls are Zoom-only so they can be recorded and summarised. This one
came through on another location.

1. Rebook it on Zoom, or record the reason it stays as-is.
2. Without a recording there is no session summary and no auto-suggested tasks.
`),
  sop('booking-unmapped-event-type', 'Unmapped booking event type', null, 'Booking', `
## Why you have this task
A booking arrived on a Cal.com event type SAOS does not recognise, so it could not
be routed.

1. Map the event type in Admin, or rename it in Cal.com to match.
2. Until it is mapped, bookings on it keep landing here.
`),
  sop('ops-restore-drill', 'Quarterly restore drill', 'ceo', 'Operations', `
## Why this exists
A backup nobody has restored is a hope, not a backup. This runs quarterly.

1. Run \`bash scripts/restore-drill.sh\`. It restores the latest snapshot into a
   throwaway database and checks row counts against live.
2. All checks must pass. A partial pass is a failure.
3. Record the pass — recording it is what silences the reminder and closes the task.
4. If it fails, that is the top priority above everything else, because it means
   the backups are not real.
`),
];

export async function seedSops(client) {
  let inserted = 0;
  for (const s of sops) {
    // published_by_staff_id is deliberately left NULL: nobody has reviewed these.
    // They publish so the task→SOP links resolve on day one, and every body says
    // plainly that it is a skeleton awaiting Brian's judgement calls.
    const res = await client.query(
      `INSERT INTO sops (slug, title, role_key, process, body_md, status, version, published_at)
       VALUES ($1, $2, $3, $4, $5, 'published', 1, now())
       ON CONFLICT (slug) DO NOTHING`,
      [s.slug, s.title, s.roleKey, s.process, s.bodyMd]
    );
    inserted += res.rowCount;
  }
  return `${inserted} of ${sops.length} SOPs seeded (skeletons, published, UNREVIEWED; existing slugs untouched)`;
}
