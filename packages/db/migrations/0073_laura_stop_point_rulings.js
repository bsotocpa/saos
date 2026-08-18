/*
 * Brian's four annual-report / SOS stop-point rulings into the SOP text (2026-08-17).
 *
 * Same mechanism and same reason as 0070 and 0071: the SOP seeder is
 * `ON CONFLICT (slug) DO NOTHING` so his edits beat a re-seed, which means an edited seed
 * reaches only databases that do not exist yet. Scoped to `version = 1` — the un-edited seed —
 * because editing a published SOP through the app bumps the version.
 *
 * WHAT THE RULINGS ADDED, all of it the REASON rather than the instruction:
 *
 *   1. Voluntary dissolution — stops and goes to Brian. Someone chose to wind that company up;
 *      often the real answer is a new entity rather than a resurrection. A business
 *      conversation, not a filing task.
 *   2. Reinstatement cost vs a fresh entity — escalates rather than being a threshold Laura
 *      applies, and the SOP now carries WHY: the comparison is not just fees. A fresh entity
 *      resets the EIN, the bank accounts, the licences and the contract counterparty, so
 *      "cheaper" is rarely the whole answer and there is no number at which it becomes one.
 *   3. A stored due date disagreeing with the derivation — Laura never picks between them,
 *      because a legitimate override and a wrong date look identical in advance. She verifies
 *      against the state's own record and brings Brian BOTH dates; his ruling is then recorded
 *      in `entity_compliance.due_date_override_reason` (migration 0072) so the next
 *      disagreement is answered from the row instead of escalated again.
 *   4. A non-Illinois entity — stops and escalates for now. The IL derivation is researched;
 *      the fallback is not, and the two come out looking equally confident. Non-IL annual
 *      reports go to Brian until that state's rule is researched and added to
 *      RESEARCHED_ANNUAL_REPORT_STATES. The SOP names the actual list, because it is seven
 *      states and not fifty: FL 8, CO 3, and one each in WI, IN, AZ, TX, AR against IL 603.
 *
 * The routing for 3 and 4 lives in the job, not in Laura noticing — a stop-point only works if
 * the person spots the condition, and the system can spot both. Those tasks arrive titled
 * NEEDS A RULING and assigned to Brian, with both dates in the description.
 *
 * Bodies generated FROM the seed so the two agree today, then frozen. `down` is empty for the
 * same reason as 0070/0071: restoring guidance that told Laura to pick between two dates would
 * put worse instructions in front of the person doing the work.
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

**STOP and bring it to Brian if the entity was dissolved VOLUNTARILY.** Someone chose to wind
that company up. Reinstating it is not a clerical fix — it is a question about what the client
is doing **now**, and often the real answer is a new entity rather than a resurrection. That is
a business conversation, not a filing task, so it is Brian's and not yours.

### 3. Total what is owed and tell the client before filing
Add up back reports, penalties and the reinstatement fee, and tell the client the number
**before** anything is filed. Two reasons: it is their money, and the total sometimes changes
their mind.

**If the total is large enough that forming a fresh entity might be the better answer, bring
Brian the number — it is a scope conversation, not a threshold you apply.**

The reason it escalates rather than being a rule you could follow: the comparison is **not just
fees**. A fresh entity resets the **EIN**, the **bank accounts**, the **licences**, and the
**contract counterparty** — every agreement the client has signed names the old company. So
"cheaper" is rarely the whole answer, and there is no number at which it becomes one. That
judgement needs to see the client's whole situation, which is why it is Brian's.

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

**If the stored due date disagrees with the derived one: STOP. Verify against the Secretary of
State's own record, then bring Brian BOTH dates.** You never pick between them.

The reason you never pick: a legitimate admin override and a plain wrong date **look identical
in advance**. There is nothing in the row that distinguishes "a state assigned this entity a
different date" from "somebody typed it wrong", and the cost of guessing wrong is a missed
statutory deadline. So the tiebreaker is the state's own record plus Brian's call — two things,
neither of which is the stored value.

When he rules, **the reason is recorded on the compliance row**
(\\\`due_date_override_reason\\\`). That is not paperwork: it is what stops the next disagreement
from being identical to this one. A date with a recorded reason is explained, and the task comes
to you as routine instead of coming to Brian again.

The system raises this for you — a mismatch with no recorded reason arrives titled **NEEDS A
RULING** and assigned to Brian, with both dates in the description. You do not have to spot it.

**A non-Illinois entity STOPS and goes to Brian, for now.** Illinois is derived from the real
rule; every other state falls back to the formation anniversary, and the two come out looking
equally confident. Rather than have you file against a plain fallback in a state nobody has
verified, non-IL annual reports go to him until that state's rule is researched and added — and
then they are routine.

Today that is seven states, not fifty: **FL (8 entities), CO (3), and one each in WI, IN, AZ,
TX, AR.** Illinois is 603. When a state's rule is confirmed it is added to
\\\`RESEARCHED_ANNUAL_REPORT_STATES\\\` and its tasks stop escalating.

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
    `UPDATE sops SET body_md = $$${ANNUAL_REPORT}$$, updated_at = now()
      WHERE slug = 'laura-annual-report' AND version = 1`
  );

  pgm.sql(`
    DO $report$
    DECLARE r record;
    BEGIN
      FOR r IN SELECT slug, version FROM sops
                WHERE slug IN ('laura-sos-restore', 'laura-annual-report') ORDER BY slug
      LOOP
        IF r.version = 1 THEN
          RAISE WARNING '0073: % updated with the stop-point rulings', r.slug;
        ELSE
          RAISE WARNING '0073: % is at version % — hand-edited, LEFT ALONE. Re-apply the rulings by hand if missing.', r.slug, r.version;
        END IF;
      END LOOP;
    END
    $report$;
  `);
};

exports.down = () => {
  /* Empty on purpose — see the header. */
};
