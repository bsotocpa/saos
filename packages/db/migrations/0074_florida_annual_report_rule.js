/*
 * FLORIDA researched and encoded — Laura's annual-report SOP gains the rule and its cites
 * (Brian's instruction 2026-08-17: primary source, and capture the rule's SHAPE).
 *
 * WHAT WAS VERIFIED, from primary sources rather than a summary:
 *
 *   Fla. Stat. § 605.0212 (LLCs) and § 607.1622 (corporations), both:
 *     "The first annual report must be delivered to the department between January 1 and May 1
 *      of the year following the calendar year in which the [articles] became effective …
 *      Subsequent annual reports must be delivered … between January 1 and May 1 of each
 *      calendar year thereafter."
 *
 *   Sunbiz, Annual Report Filing Requirements:
 *     "A $400 late fee will be imposed on all profit corporations, limited liability companies,
 *      limited partnerships, and limited liability limited partnerships which fail to file their
 *      annual reports on or before May 1st." … "There is no provision to abate or waive the
 *      $400 late fee." … "Failure to file an annual report by the 3rd Friday of September will
 *      result in the administrative dissolution or revocation of the business entity on our
 *      records at the close of business on the 4th Friday of September."
 *
 * THE SHAPE, which is the part that could not be captured as a date: Florida is
 * UNIFORM-DEADLINE — one day a year for every entity — where Illinois is ANNIVERSARY-BASED.
 * Formation date is load-bearing exactly once in Florida (the first report is skipped in the
 * formation year) and irrelevant every year after. That is why the derivation was restructured
 * around a rule object rather than by adding another branch to the date arithmetic.
 *
 * Same mechanism as 0070/0071/0073: the seeder is ON CONFLICT DO NOTHING so an edited seed
 * reaches only fresh databases; scoped to version = 1, the un-edited seed text.
 *
 * Body generated FROM the seed so the two agree today, then frozen. `down` is empty: restoring
 * a page that does not name the $400 unwaivable penalty or the dissolution dates would put worse
 * guidance in front of the person doing the work.
 */

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

#### Which states are researched

Two so far. A state is "researched" when its rule has been read from the **statute or the
Secretary of State's own published requirement** — never a summary of one — and encoded. Until
then its tasks escalate to Brian rather than coming to you.

**ILLINOIS — anniversary-based.** Due the first day of the entity's anniversary (formation)
month. Every entity has its own date.

**FLORIDA — uniform deadline. Structurally different, and the difference matters.**

> "The first annual report must be delivered to the department between January 1 and May 1 of
> the year following the calendar year in which the limited liability company's articles of
> organization became effective … Subsequent annual reports must be delivered to the department
> between January 1 and May 1 of each calendar year thereafter."
> — **Fla. Stat. § 605.0212** (LLCs); **§ 607.1622** says the same for corporations.

So for Florida:

- **Everyone is due 1 May.** Not the anniversary. A company formed on 19 July is due 1 May like
  every other Florida entity — if you find yourself looking at a July date for a Florida
  company, something derived it wrongly.
- **The window opens 1 January.** There is no filing before then.
- **Formation date matters exactly once:** the first report is due the year AFTER the year of
  formation. An entity formed in 2026 files nothing in 2026; its first report is 1 May 2027.

**The Florida penalty regime, which is why the date is not negotiable** (Sunbiz, *Annual Report
Filing Requirements*):

> "A $400 late fee will be imposed on all profit corporations, limited liability companies,
> limited partnerships, and limited liability limited partnerships which fail to file their
> annual reports on or before May 1st." … **"There is no provision to abate or waive the $400
> late fee."**

Not-for-profits are exempt from the fee. And missing it far enough is terminal:

> "Failure to file an annual report by the 3rd Friday of September will result in the
> administrative dissolution or revocation of the business entity on our records at the close of
> business on the 4th Friday of September."

**$400 per entity, unwaivable, one day late.** Treat a Florida 1 May like a tax deadline, not a
filing chore — and if a Florida report is going to be late, say so before 1 May rather than
after, because there is no appeal to make afterwards.

**Every other state still STOPS and goes to Brian.** That is five more with entities in the
book — **CO (3), and one each in WI, IN, AZ, TX, AR** — against IL 603 and FL 8. When a state's
rule is confirmed from a primary source it is added to \\\`RESEARCHED_ANNUAL_REPORT_STATES\\\` and
its tasks stop escalating.

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
    `UPDATE sops SET body_md = $$${ANNUAL_REPORT}$$, updated_at = now()
      WHERE slug = 'laura-annual-report' AND version = 1`
  );

  pgm.sql(`
    DO $report$
    DECLARE v int;
    BEGIN
      SELECT version INTO v FROM sops WHERE slug = 'laura-annual-report';
      IF v = 1 THEN
        RAISE WARNING '0074: laura-annual-report updated with the Florida rule and cites';
      ELSIF v IS NULL THEN
        RAISE WARNING '0074: laura-annual-report absent — a fresh database seeds the new text directly';
      ELSE
        RAISE WARNING '0074: laura-annual-report is at version % — hand-edited, LEFT ALONE. Re-apply the Florida section by hand if missing.', v;
      END IF;
    END
    $report$;
  `);
};

exports.down = () => {
  /* Empty on purpose — see the header. */
};
