/*
 * Laura's other two SOPs get the same treatment as the PLLC one (Brian, 2026-08-17):
 * one section per task-checklist step, headings verbatim, stop-points carrying their reasons.
 *
 * Same mechanism as 0070, and for the same reason: the SOP seeder is
 * `ON CONFLICT (slug) DO NOTHING` so Brian's edits always beat a re-seed — which means an
 * edited seed reaches only databases that do not exist yet. Scoped to `version = 1`, the
 * un-edited seed text, because editing a published SOP through the app bumps the version.
 *
 * ALSO FIXES A ROLE THAT DOES NOT EXIST. `laura-annual-report` shipped with
 * `role_key = 'entity_admin'`; the ten roles are ceo, ed_coo, tax_preparer, va_entity, auditor,
 * comms_billing, bookkeeper, intern, client_success, advisory_manager. The SOP list filters by
 * role, so Laura — `va_entity` — could never surface her own annual-report procedure. It failed
 * silently: nothing errored, the page simply never appeared. Now `va_entity`, and
 * scripts/check-sop-task-alignment.mjs fails the build on any SOP filed under a role that is not
 * real (null stays allowed — the booking SOPs belong to no one role).
 *
 * WHAT THE NEW TEXT ADDS beyond section-per-step structure — the stop-points, each with the
 * reason rather than just the instruction:
 *
 *   SOS restoration
 *     · a name collision looks identical to a real adverse result, so confirm before acting
 *     · a VOLUNTARY dissolution stops and goes to Brian — reinstating a company someone chose
 *       to wind up is a question about what the client is doing now, not a clerical fix
 *     · the total is told to the client BEFORE filing, and if it is large enough that a fresh
 *       entity might be better, that is a scope conversation for Brian
 *     · oldest-first is not a preference: a reinstatement filed before the outstanding reports
 *       is rejected, so you pay the fee and get nothing
 *     · the last step decides whether it recurs — a restoration that leaves the calendar wrong
 *       buys exactly one year
 *
 *   Annual report
 *     · filing does not restore standing, so not-in-good-standing STOPS and runs the
 *       restoration first; this report becomes one of the back filings inside it
 *     · recording the filing in SAOS is what rolls the due date and re-arms T-60 — skipping it
 *       reproduces the failure that creates a restoration task
 *     · the derived date is researched for Illinois and a plain fallback elsewhere, so a
 *       non-IL entity gets checked against that state's own rule
 *
 * The bodies are inlined rather than imported from the seed, because a migration must mean the
 * same thing forever. Generated FROM the seed on 2026-08-17 so the two agree today; they are
 * allowed to diverge afterwards, which is the point.
 *
 * `down` is deliberately empty, as in 0070: restoring a procedure that hid a rejection cause
 * and a role nobody holds would put worse guidance in front of the person doing the work, to
 * undo a change that is only words.
 */

const SOS_RESTORE = `## Why you have this task
The Secretary of State search came back adverse for this entity — dissolved, revoked, or not in
good standing. The client has already had the fix-steps email; this is our side.

**This page has one section per checklist item on the task, in the same order.** The task names
the step; this explains it.

## What losing standing actually costs
Not a filing inconvenience. An entity not in good standing can lose the right to sue in
Illinois courts, and the liability shield the client believes they have may not be there. That
is why this is P1 and why it blocks the annual report rather than waiting behind it.

---

### 1. Confirm the adverse result on the ILSOS site
Look it up yourself before doing anything else. The monitor scrapes ILSOS HTML, and a **name
collision** — a different company with a similar name — looks identical to a real problem from
the scraper's side.

If the entity is actually fine, close the task with a note saying what you searched and what
you found. A false positive is a normal outcome, not a failure, and the note is how we find out
the matcher needs work.

### 2. Find out why standing was lost
The cause decides the whole rest of the list, so do not skip to filing. Usually it is **missed
annual reports**; sometimes a **registered-agent lapse**, which no amount of report filing
fixes.

**STOP and bring it to Brian if the entity was dissolved VOLUNTARILY.** Someone chose to close
it, and reinstating a company the client deliberately wound up is not a clerical fix — it is a
question about what they are doing now, and possibly about a new entity instead. Not Laura's
call.

### 3. Total what is owed and tell the client before filing
Add up back reports, penalties and the reinstatement fee, and tell the client the number
**before** anything is filed. Two reasons: it is their money, and the total sometimes changes
their mind.

**If the total is large enough that forming a fresh entity might be the better answer, that is
a scope conversation for Brian**, not a decision to make on their behalf. Bring him the number.

### 4. File back reports oldest-first, then reinstatement
The order is not a preference. Illinois processes the reports as a sequence, and a reinstatement
filed before the outstanding reports is rejected — you pay the fee and get nothing.

File every missing year oldest-first, confirm each one landed, then file the reinstatement.

### 5. Re-check standing and record the confirmation
Look the entity up again after filing and confirm it now reads in good standing. A submitted
filing that was quietly rejected looks identical to a successful one from our side until
somebody looks.

Record the confirmation on the business record and keep the stamped copies in their documents.

### 6. Correct the annual-report due date so the next one is caught
The step that decides whether this happens again. Standing was almost certainly lost because
nothing was watching the date — so set or correct \`annual_report_due_date\` on the compliance
record, and let the T-60 reminder pick it up.

**A restoration that leaves the calendar wrong buys exactly one year.** If there is no
compliance record for this business at all, create one; that absence is the reason we are here.

---
**⚠ Skeleton.** These steps come from what the system enforces, not from Brian dictating the procedure. Add the judgement calls, the phone wording, and the exceptions before treating this as complete.`;

const ANNUAL_REPORT = `## Clock
You are reminded at **T-60**. The client is reminded at T-30, and that email is gated by the
\`annual_report_client_reminders\` automation — so if it is disarmed, the client has heard
nothing and the whole deadline is yours to carry.

**This page has one section per checklist item on the task, in the same order.** The task names
the step; this explains it.

---

### 1. Confirm the state and the actual due date
The due date is **derived**, never a fixed calendar entry: in Illinois it is the first day of
the entity's anniversary (formation) month; elsewhere it is the formation anniversary itself.
Check it against the formation date on record rather than trusting the stored date.

**If the stored due date disagrees with the state rule, do not just file to whichever is
sooner — find out which is right.** An admin override is legitimate (a state can assign a date
that does not follow the general rule), but a wrong stored date is also exactly what a missed
deadline looks like in advance.

**For a non-Illinois entity, check the state's own rule before relying on the derived date.**
The calculation covers Illinois properly and falls back to the formation anniversary elsewhere,
which is a reasonable default and not a researched one. Bring anything unusual to Brian.

### 2. Check IL SOS good standing before filing
Look the entity up before filing anything. If it is **not in good standing**, stop: filing an
annual report does not restore standing, and Illinois will not process the report as if it did.
You would spend the fee and still have a dissolved company.

Not-in-good-standing is its own task with its own procedure — see \`laura-sos-restore\`. Work
that first; this report becomes one of the back filings inside it.

### 3. File the report and pay the fee
File it and pay. Nothing subtle here except one thing worth checking as you go: if the entity's
**registered agent** or address has changed since last year, correct it in the same filing
rather than leaving a second one to do.

### 4. Record the filing in SAOS so the next due date rolls
Mark it filed on the compliance record in SAOS. This is not bookkeeping — **recording it is what
rolls the due date to next year and re-arms the T-60 reminder.** Skip it and the next reminder
never fires, which is the same failure that produces a restoration task.

If a filing you already made is not showing, fix the record rather than filing again.

### 5. Store the stamped confirmation on the business record
Put the stamped copy in the client's documents, on the business record. Documents go through the
portal or SAOS storage, never an email attachment.

A year from now the question is "did we file it", and the confirmation is the only thing that
answers it without asking Illinois.

---
**⚠ Skeleton.** These steps come from what the system enforces, not from Brian dictating the procedure. Add the judgement calls, the phone wording, and the exceptions before treating this as complete.`;

exports.up = (pgm) => {
  pgm.sql(
    `UPDATE sops SET body_md = $$${SOS_RESTORE}$$, updated_at = now()
      WHERE slug = 'laura-sos-restore' AND version = 1`
  );
  pgm.sql(
    `UPDATE sops
        SET body_md = $$${ANNUAL_REPORT}$$,
            role_key = 'va_entity',
            updated_at = now()
      WHERE slug = 'laura-annual-report' AND version = 1`
  );

  /*
   * Report which branch each took. A migration whose only job is to change text can no-op
   * perfectly silently, and "did it apply?" should not need a query to answer.
   */
  pgm.sql(`
    DO $report$
    DECLARE
      r record;
    BEGIN
      FOR r IN SELECT slug, version, role_key FROM sops
                WHERE slug IN ('laura-sos-restore', 'laura-annual-report') ORDER BY slug
      LOOP
        IF r.version = 1 THEN
          RAISE WARNING '0071: % updated (seed version 1, role now %)', r.slug, r.role_key;
        ELSE
          RAISE WARNING '0071: % is at version % — hand-edited, LEFT ALONE. Brian''''s edit wins; re-apply the stop-point wording by hand if it is missing.', r.slug, r.version;
        END IF;
      END LOOP;
    END
    $report$;
  `);
};

exports.down = () => {
  /*
   * Empty on purpose. See the header: the previous annual-report text was filed under a role
   * nobody holds and omitted that filing does not restore standing. Rolling back a schema should
   * not roll back the firm's rules.
   */
};
