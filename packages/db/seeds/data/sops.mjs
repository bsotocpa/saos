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
  sop('rene-portal-access', 'Client cannot sign in to the portal', 'comms_billing', 'Client communications', `
## Why you have this task
Someone we already have on file asked for a portal sign-in link and got nothing.
Either they have no portal account, or their account is on a **different email
address** than the one they typed.

The portal cannot tell them which — saying "that address has no account" would
confirm to any stranger who our clients are. So it gives everyone the same answer
and raises this task instead.

1. Open the client record. Check **Portal access**: is there an account, and on
   which address?
2. If the account is on another address (a work address, a +tag, an old one), call
   or email them at an address you already trust and tell them which one to use.
   Do not create a second account — one client, one portal.
3. If there is no account, confirm the email is right and **Grant portal access**.
   They get an invitation explaining what the portal is, not a bare link.
4. If the address they tried is better than the one on file, update the contact
   FIRST, then grant — the account is created from the contact's email.
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
  sop('rene-question-call', 'A question call was booked', 'comms_billing', 'Onboarding', `
## Why you have this task
Someone booked a question call. **These are free** — no invoice, no deposit, whatever the
question turns out to be.

1. Take the call. Answer what you can answer.
2. **Where free stops:** a question is free; DOING the work is not. If answering means
   preparing a return, reconstructing books, or writing to the IRS, that is an engagement —
   say so on the call, and send a quote instead of starting.
3. If it becomes work, build the quote from the price book. Never name a price on the call
   that the book does not support.
4. If it stays a question, close this task with a one-line note on what they asked. That note
   is how we find out which questions keep coming up.
`),
  sop('rene-ssn-by-phone', 'Collecting an SSN by phone', 'comms_billing', 'Intake', `
## Why you have this task
The client asked to give their SSN by phone rather than type it into the portal. That is a
reasonable thing to prefer, and it puts the number in your hands for a few minutes.

**Hard rules — these are not preferences:**
1. Call THEM on the number already on their record. Never accept an SSN from an inbound
   caller you have not verified.
2. Type it straight into the client record while they are on the line. It goes nowhere else.
3. **Never** write it in a task note, a message, an email, a text, or on paper. If you wrote
   it somewhere to hold it, delete that and tell Brian.
4. Read it back once to confirm, then close the task. Do not repeat it in the note.
5. If they cannot verify who they are, stop and reschedule. An unverified SSN is worse than a
   missing one.
`),
  sop('rene-service-request', 'A client asked for a service', 'comms_billing', 'Onboarding', `
## Clock
The portal promised them a reply **within 24 hours**. The task is due tomorrow for that
reason, and the reply is what the deadline is about — not the answer.

1. Reply first, same day if you can: you have it, and here is what happens next. A holding
   reply inside 24 hours keeps the promise; a perfect one on day three does not.
2. Work out whether it is new work or something their engagement already covers. Check the
   engagement's scope on the client record before quoting anything.
3. New work → build a quote from the price book. Covered work → schedule it and say so.
4. Not something Soto does → say that plainly and refer out. "No" delivered quickly is a
   good answer.
`),
  sop('laura-pllc-conversion', 'PLLC conversion, step by step', 'va_entity', 'Entity', `
## Why this exists
Illinois requires a licensed professional to organise as a **PLLC**, not a plain LLC. A
licensed client operating through an LLC is improperly formed — often for years, usually
because whoever set it up did not ask about the licence.

This is a real service line, not a cleanup favour. Quote it from the price book.

**This page has one section per checklist item on the task, in the same order.** The task
names the step; this explains it. Work down the task, read the matching section here.

## What to say before anything else
The client is about to learn their entity has been wrong for years. Lead with the fix, not the
error: "Illinois wants licensed professionals in a PLLC rather than an LLC — we can convert
you, here is what it takes." Do not speculate about consequences of the years already elapsed;
that is Brian's call if the client asks.

---

### 1. Verify professional license (IDFPR)
Look the client up on the **IDFPR** licence-lookup site yourself. Do not take the licence
number from the intake form as proof — a lapsed or differently-named licence changes the
answer completely.

Record what you found: licence type, number, status, expiry. If the licence is **lapsed or
inactive**, stop here and tell Brian. A conversion for someone not currently licensed is a
different conversation, and possibly the wrong one.

**If the profession is not on the IDFPR list at all: STOP and bring it to Brian.** Not because
it is complicated, but because the likely answer is that the client belongs at the Secretary of
State as an ordinary LLC and needs no conversion — and deciding that changes what we are
engaged to do. That is a scope conversation with the client, so it is Brian's to have, not
yours. Say nothing to the client until he has had it.

### 2. Confirm current entity is improperly formed for a licensed professional
Pull the entity's actual filing from the **IL Secretary of State**, not the client's
description of it. You are confirming two things:

- the entity type on file really is an LLC (not already a PLLC someone mislabelled)
- the entity is in **good standing** — if it is not, that is a separate problem and it blocks
  the conversion. Run the SOS restoration first (see \`laura-sos-restore\`).

**If it turns out to be correctly formed already: tell the client, then close the conversion as
dismissed.** Both halves matter. They were flagged for a problem they do not have, so they hear
that from us — "we checked your filing against the licence and it is correctly formed, nothing
needed" — rather than never hearing anything.

Closing with "nothing needed" is a **completed outcome, not a failure**. We were asked whether
the entity was wrong; the answer was no; that is the work finished. Note what you checked and
close it.

### 3. Advisory session scheduled with client
Brian takes this session — it is advisory work, not admin. Your job is to get it on the
calendar with the findings from steps 1 and 2 attached, so he is not discovering the licence
type on the call.

**Check for an existing recurring session with this client before creating anything.** If they
already have a standing session, attach this to it rather than booking a second meeting.

The session is where scope and price are agreed. Nothing gets filed before it.

### 4. Articles of amendment / conversion prepared
Prepare the amendment for the client's signature. Two things that are easy to get wrong:

- the **name** must carry the PLLC designator exactly as Illinois requires; a name that reads
  fine but is not compliant comes back rejected
- the **purpose clause** has to state the professional service. A generic clause is the most
  common rejection reason

The client signs — never sign on their behalf. Send it through the portal, not as an email
attachment.

### 5. Filed with IL Secretary of State
File it, pay the fee, and **record the confirmation on the conversion record**. Keep the
stamped copy in their documents.

Filing is not the end of the step: re-check the entity on the SOS site afterwards and confirm
it now reads PLLC. A submitted filing that was quietly rejected looks identical to a successful
one from our side until someone looks.

### 6. EIN, bank, and insurance records updated
The part that gets forgotten, and the part that actually bites the client. The entity is
converted; everything pointing at it still says LLC.

- **IRS/EIN — no new EIN. Update the name on file, keep the number.** The reason, because the
  rule is useless without it: an Illinois statutory conversion **continues the same legal
  entity**. The LLC does not dissolve and a PLLC does not come into existence — one entity
  changes its organisational form, so its EIN follows it. Applying for a new one would split the
  client's tax history in two across a single continuous business.

  That reasoning is also the limit of the rule. It holds because the filing is a **statutory
  conversion**. If this client's situation is instead a dissolve-and-reform — a new entity
  formed and the old one wound up — it is a different filing and the EIN question reopens. Stop
  and ask Ana-Maria in that case, and only that case.
- **Bank** — the account name must match the new entity name or deposits start bouncing
- **Insurance** — the malpractice or professional-liability policy must name the PLLC. A policy
  naming a dissolved LLC is the worst outcome on this list
- Anything else in their own records: contracts, licences, letterhead, invoicing

When all six are ticked, set the conversion to **completed**. If a step turns out not to apply,
tick it with a note saying why — a skipped step and a done step must not look the same.
`),
  sop('laura-sos-restore', 'Restoring IL SOS good standing', 'va_entity', 'Entity', `
## Why you have this task
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
`),
  sop('rene-acceptance-failed', 'A client tried to accept and could not', 'comms_billing', 'Onboarding', `
## Why you have this task
Someone clicked Accept on their quote and the system could not complete it. The whole
acceptance was rolled back, so **nothing exists**: no engagement, no invoice, no charge.
The quote went back to open and they can still accept it.

This is a hot lead with a broken checkout, which needs more attention than a successful
acceptance, not less.

1. **Check the reason on the task.** If it says the quote was already accepted, close this
   task — a double-click, and their real acceptance went through.
2. **Look at the client record.** Confirm there is no engagement and no invoice. If there
   IS one, stop and tell Brian: a rollback left something behind, which should be
   impossible.
3. **Call them the same day.** They tried to buy. Say the link had a problem, not that
   "the system failed" — and do not ask them to try again until step 4.
4. **Get the cause fixed before re-accepting.** A second attempt down the same path fails
   the same way. Once it is fixed, either send them back to the quote link or accept it on
   their behalf.
5. **Nothing else chases this.** There is no ladder behind it, because there is no
   engagement for a ladder to hang from.
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
  sop('laura-annual-report', 'Annual report filing', 'va_entity', 'Entity services', `
## Clock
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
(\`due_date_override_reason\`). That is not paperwork: it is what stops the next disagreement
from being identical to this one. A date with a recorded reason is explained, and the task comes
to you as routine instead of coming to Brian again.

The system raises this for you — a mismatch with no recorded reason arrives titled **NEEDS A
RULING** and assigned to Brian, with both dates in the description. You do not have to spot it.

#### When there is no formation date on record

Whether that blocks you **depends on the state's shape**, which is the practical reason the two
kinds of rule are described separately below.

**Illinois: it blocks.** The formation date *is* the deadline there, so nothing can be derived
and nothing is stored. The system does not let that sit quietly — enrolling a business with no
formation date creates a **"Find the formation date"** task for you, because a compliance row
with a blank due date receives no T-60 and no T-30. It appears in the compliance list looking
tracked, and no reminder is ever coming. Get the date from the Secretary of State's record, save
it on the row, and the due date derives itself from there.

**Florida: it does not block.** 1 May is 1 May whoever you are, so the date derives with no
formation date at all. The only thing lost is knowing whether the entity is new enough to skip
its first year — and there the derivation deliberately errs toward the **earlier** date. An
early report is a wasted filing; a late one is $400 that nobody can waive.

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
book — **CO (3), and one each in WI, IN, AZ, TX, AR** — against IL 603 and FL 8.

**Those five are staying that way on purpose.** Brian's standing rule, 2026-08-17: escalation is
cheaper than five statutes. At one to three entities each it is roughly six tasks a year reaching
him, which is less work than reading and encoding five states' law that would then sit unused for
another eleven months. **The escalation is the design, not a gap** — if you are handed one of
these, nothing has gone wrong and nothing is stuck waiting on you.

A state gets researched when **either** trigger fires, whichever comes first: its entity count
crosses about **five**, or its escalated tasks start annoying Brian. Each escalated task carries
that decision on it — the state, its live entity count, and the threshold — so the answer is on
the task rather than somewhere else. Once a state is researched, its rule is read from a primary
source, encoded, and added to \`RESEARCHED_ANNUAL_REPORT_STATES\`, and its tasks come to you as
ordinary work from then on.

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

  sop('brian-infected-upload', 'A client upload failed the virus scan', 'ceo', 'Documents', `
## Why you have this task
A file a client uploaded to the portal came back **infected**. The technical side is
already handled and needs nothing from you:

- the file is stored, but it **cannot be filed** against a document request and
  **cannot be downloaded** by anyone, including you;
- whatever we asked the client for is therefore **still outstanding**, and the chase
  clock is still running;
- the client has **not** been told anything. No automated message goes out.

## What is actually yours to decide
1. **How to ask for a replacement.** A client whose machine has malware is usually not
   at fault and does not know. "Your file has a virus" is not the opening line.
   Ask for a re-upload, or offer the in-person option.
2. **Whether this is a pattern.** Once is an accident. Repeatedly infected uploads from
   the same client is a conversation about their computer, and possibly a reason to
   take documents in person only.
3. **Whether anything else of theirs is suspect.** Other uploads from the same client
   are listed on their record with scan status; a clean verdict there is a real clean
   verdict, not an assumption.

Do not ask the client to email the file instead. Documents never travel by email
attachment or text — that rule does not bend because the scanner caught something.
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
