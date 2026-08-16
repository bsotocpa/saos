# UX findings #27–#35 — architecture pass

Brian's rule for this batch: **"Rule-then-build; flag anything conflicting with existing
architecture before building."** This is the flag pass. Nothing below is built yet.

Each item is marked:

- **CLEAR** — no conflict, build as described.
- **RULING** — a decision only Brian can make; the work is blocked on it.
- **CONFLICT** — collides with something already built; needs a ruling on which gives way.

Three bugs surfaced during the pass. They are listed at the bottom and are worth fixing
whichever way the findings are ruled.

---

## Intake (#27–#31)

### #27 — Prefill fields we already hold · **RULING**

The intake renderer opens with `POST /public/forms/{key}/start` carrying nothing but
`{ language, source }`. It is public on purpose — the file's own header says *"PUBLIC by
necessity: this is how a stranger becomes a client, so it must work with no account."*
Prefill requires knowing who is asking, which that route deliberately does not.

**The flag is a privacy one, not a plumbing one.** Progress is saved against
`submissionId + resumeToken`. Today that pair only ever exposes what the client typed
themselves. Prefill from the contact record turns the same pair into a disclosure vector
for data they never entered into that form — phone, address, EIN — to anyone holding the
link.

Two ways to have it:

- **(a) Prefill only for an authenticated portal session.** A signed-in client filling a
  form gets their held fields; a stranger's path is untouched. No new exposure: they could
  see the same data on `/profile`.
- **(b) Signed per-contact form links.** Prefills for anyone Brian sends a link to, including
  clients who have never signed in. Strictly more useful and strictly more exposed — the link
  in an inbox now carries PII.

Recommend **(a)**. It covers the case Brian actually hit (an existing client re-typing what
we hold) without making an emailed link sensitive.

### #28 — Free-text for every "Other" · **CLEAR, with one exception**

No architecture conflict and **no application code**. The renderer already honours
`showWhen: { field: 'industry', equals: 'other' }` for selects and
`includesAny: ['other']` for multiselects. Every companion free-text box is a form-definition
edit — admin-editable, no deploy, exactly as the form-is-data design intends.

Where "Other" exists today with no free-text companion:

| Form | Field | Notes |
|---|---|---|
| Soto intake | `industry` | drives NAICS + module routing, so "Other" is currently a dead end for both |
| Soto intake | `how_heard` | `referred_by` already exists for the `referral` option; "Other" has nothing |
| Hilo intake | `business_kind` | |
| Hilo intake | `demo_race` | **see below** |

**The exception is `demo_race`.** That screen is funder-reporting demographics, aggregated
only, with the seed comment *"never copied to the contact record, never shown on day-to-day
views."* A free-text box there invites someone to type a sentence about themselves into a
field the system is built never to read — and it becomes free-text PII inside the grant
export path. Recommend **"every Other except `demo_race`"**, which needs your yes.

Also note: `entity_type`, `services` and `help_domains` use **"Not sure"**, not "Other".
Different question — "I don't know" is not "you're missing my answer" — so I left them out.
Say if you want free-text on those too.

### #29 — Last-year gross revenue · **RULING**

Also a pure definition change. The conflict is with a question already there:
`revenue_range`, an optional bucketed select (`<$50K` … `$1M+`, plus *Prefer not to say*).

Asking for a bucket and an exact figure in the same form is duplicative, and the exact
figure is the bigger ask of the two — pre-engagement, from a stranger, it is the question
most likely to get an abandoned form or a made-up number.

Ruling needed on all three:

1. **Replace** `revenue_range`, or **add alongside** it?
2. **Required or optional?** (`revenue_range` is optional today.)
3. **Which year?** "Last year" on a form filled in January means something different than
   in November. Recommend labelling the concrete year rather than "last year".

### #30 — Discovery voice → onboarding voice · **RULING** (and see #31)

Copy-only, admin-editable, no deploy — by design. But the audit you asked for cannot be
answered without #31, because **the two are the same decision**. See below.

The pre-engagement-only questions, for your ruling, are the ones that only make sense
before you have agreed to work together:

| Question | Why it reads as pre-engagement |
|---|---|
| `how_heard` | attribution; nobody asks a client this after signing them |
| `referred_by` | same, though it drives referral credit |
| `services` (*"What You Need"*) | by onboarding, the quote already answered this |
| `filed_last_year` | genuinely useful either way, but phrased as qualification |
| `owns_business` | a signed client's entity is already on the record |
| `revenue_range` / `employees_range` | sizing questions — scoping input, not onboarding input |
| `ssn_preference` | onboarding-relevant, phrased as an option menu rather than a next step |

The consents (`communication_consent`, `esign_consent`, `sms_ok`) and the contact block are
voice-neutral — they are required at both stages.

### #31 — Intake as an explicit dashboard checklist step · **CONFLICT**

I flagged this one in advance and it is worse than the mechanical collision I expected.

The mechanical part is small: the portal dashboard's `STEPS` array is keyed to
`portal_onboarding.step_*` columns, so a new step means a migration, a column, and a
decision about which form key it points at.

**The real conflict: intake is what creates the client.** Submitting the Soto intake is the
call that creates the contact *and* the portal user (`forms/service.ts:293`). So anyone
looking at the portal dashboard has already submitted intake, by construction. The step
would render complete for every client who arrived the normal way, and would only ever be
pending for contacts created some other way — the July migration, staff-created records,
quote-first clients.

So #31 only means something if intake moves, or splits, to **after** the engagement — which
is precisely what #30's "onboarding voice" is asking for. **They are one ruling, not two:**

- **(A) Intake stays pre-engagement.** #30 becomes a small copy pass; #31 becomes "a checklist
  step for clients who have no intake on file" — real, but only for migrated and staff-created
  contacts.
- **(B) Intake splits.** A short pre-engagement form (contact, consents, what you need) plus a
  post-engagement onboarding questionnaire that becomes the checklist step. This is the version
  that makes #30 and #31 both land, and it is the larger build.
- **(C) Intake moves entirely post-engagement.** Cleanest voice, but then nothing collects a
  stranger, and the "how a stranger becomes a client" path has to be rebuilt elsewhere.

**Worth knowing before you rule:** Form 5 already exists as data — `ONBOARDING_MODULES`,
the industry-triggered A–I module set, assembled per client. It is exactly the shape option
(B) needs. But `form_definitions` holds only `soto_intake` and `hilo_intake`; there is **no
`service_onboarding` row**, so the modules are assembled and never delivered to anyone. Option
(B) is closer to finishing something already half-built than to starting something new.

---

## Ops client record (#32–#33)

### #32 — Portal-access status with inline grant · **CLEAR**

No conflict, no schema change. All three states derive from what is already stored:

| State | Derivation |
|---|---|
| not invited | no `portal_users` row for the contact |
| invited | row exists, `last_login_at IS NULL` |
| active | `last_login_at` is set |
| revoked | `is_active = false` — a fourth state you did not list, but it exists and should show |

Inline grant is the existing `POST /portal-users`: already gated on `magic_links.manage`,
already audited, and already sends the invite-vs-plain-link correctly (that was #21). The
client record needs to call it, not reimplement it.

**One flag:** magic links expire in minutes. An invite sent three days ago is functionally
*not invited*. "Invited" should carry **when**, and the button should stay available as
*Resend* rather than disappearing once a row exists.

### #33 — Client record as the operating surface · **CONFLICT (partial)**

Overlap was expected; here is the actual line. Present today: *Before you work this*
(compliance gate), Contact, Businesses, Documents, Quotes, Engagement packet, Returns,
Sessions, Notes. Missing from your list: **invoices**, **editable basic info**, **book a
meeting**.

Two conflicts in the missing three:

- **"Take payment" vs the Lane 1 ruling.** You retired the direct-deposit invoice path;
  deposits exist only on accepted quotes. Settling a real invoice is a different act and does
  not reinstate Lane 1 — but it has to run the *same single settlement path* (`markInvoicePaid`,
  via reconcile) that #24 established, and staff-side "take payment" must mean **send or copy
  the client's pay link**, never a staff-entered card. I do not handle payment credentials, and
  the one-path rule says Stripe confirms payment, not a person.
- **"Book meetings" vs the calendar cross-check hard rule.** CLAUDE.md: never create a
  session-scheduling task without first checking for an existing recurring session with that
  client — attach to the existing session, only create when none exists. A booking button on the
  client record has to run that check, or it becomes the fastest way to violate the rule.

*Editable basic info* is clean — no conflict, just not built.

---

## Portal (#34–#35)

### #34 — Onboarding as one continuous flow from one email · **CONFLICT + bug**

The seams, traced end to end:

| # | Seam | What happens now |
|---|---|---|
| 1 | intake submitted | sends `welcome_soto` **and** a magic link — **two emails, back to back** |
| 2 | magic link | 15-minute expiry; if they read the welcome first and the link second, it may already be dead |
| 3 | quote | `quote_ready` — a separate email with its own token link |
| 4 | deposit | paid on the quote, then back to the portal with no email |
| 5 | packet | `packet_ready_to_sign` — another email, another link |
| 6 | portal home | the 5-step checklist, which is where the flow was supposed to start |

**The bug** (see below): seam 1 sends the *wrong one* of those two emails.

**The conflict** is that "one email" argues with the magic-link model itself. Every step
above is a separate email because each carries a separate short-lived token. One continuous
flow from one email means one durable entry point — which is now possible, because #13 gave
the portal 30-day cookie-backed sessions. A client who lands once stays landed, so steps
3–5 could be portal destinations rather than emailed tokens.

That is a genuine redesign and it depends on your #31 ruling (whether intake is inside the
flow or in front of it). Recommend ruling #31 first.

### #35 — Post-onboarding portal home · **RULING**

Home today, in order: setup checklist → engagement/sign → open invoices → quick actions →
estimate-due. So **progress exists but only as setup progress**, and it has nowhere to go once
the checklist completes. Projects and scheduling are both absent — the *Book your consultation*
step was deliberately removed on 2026-08-13 and `step_book_consult_at` is now an unused column.

**The flag is your own policy:** *"every channel a client can claim they used must be one the
system tracks."* Putting scheduling back on portal home means a portal booking has to land in
the same session record as a Cal.com booking — same table, same task, same visibility on the
client record. If it writes anywhere else, the portal becomes exactly the untracked channel
the policy exists to prevent. That is the constraint to build to, not a blocker.

Ruling needed on what "projects" means to a client: engagements as-is (the client sees
*"1040 — 2025"*), or a friendlier grouping over them.

---

## Bugs found during the pass — ALL THREE FIXED AND DEPLOYED (2026-08-15)

Brian ruled: fix all three before the batch. Done and live. Each fix was sabotaged
separately and failed exactly its own tests. Two extras came out of fixing #1: the
double welcome email, and Hilo being welcomed under Soto's name.

1. **New clients from intake get the phishing-shaped email — #21 is only half fixed.**
   `forms/service.ts:294` and `:379` call `issueMagicLink(app, portalUser.id)` with no
   `purpose`, so a brand-new portal user gets the bare `portal_magic_link` instead of
   `portal_invite`. That is the exact email #21 identified as *"no context, fifteen-minute
   expiry, and indistinguishable from phishing."* The staff-grant path passes
   `purpose: user.created ? 'invite' : 'login'`; the intake path — the one every new client
   actually walks — does not. Both Soto and Hilo.

2. **Intake does not resume, despite being built to.** The renderer's header says *"a client
   who loses signal on a phone mid-intake does not start over,"* and each screen does PATCH its
   answers. But `resumeToken` lives only in React state and the page POSTs `/start` on every
   mount — so a refresh, a backgrounded phone, or a closed tab starts a **new submission** and
   abandons the old one. The server-side resume is real and complete; nothing on the client
   ever uses it. This also inflates the abandoned-submission count.

3. **A new required field on an early screen strands in-flight submissions.**
   `validateSubmission` walks every screen, but the renderer only validates and displays the
   current one. Ship a required field on screen 1 and someone on screen 4 submits, fails on a
   field that is not on their screen, and reads *"fix the issues below"* with nothing below.
   Directly relevant to **#29** if that lands as required. Mitigation is either "new required
   fields go on the last screen" or making the submit-time error scroll the client back to the
   offending screen.

---

## Rulings received (Brian, 2026-08-15)

**#30/#31 — intake splits.** Pre-engagement short form stays where it is and keeps
creating the contact: identity, contact info, language, service interest, nothing more.
The post-engagement questionnaire is the onboarding-voice instrument, **built from Form 5's
already-assembled A–I module set**, and it is the checklist step. Finish the half-built
thing; do not start a new one.

**The canonical client journey**, ruled — this is both the checklist and #34's target:

1. Login setup, from the one email
2. Review & sign packet
3. §7216 consent — its own screen, immediately after signing
4. Intake questionnaire
5. Document upload
6. Book kickoff — optional, completable at any time

**Deposit is not a checklist step.** It is collected at quote acceptance, before the portal
journey begins. #34's job is closing the seams so steps 1–5 can be completed in one sitting
from one email. Home flips to the #35 state once the required steps are done.

**#28** — approved as "every Other except `demo_race`".
**#32** — proceed as scoped.
**#33** — both conflicts ruled as framed: staff "take payment" means sending the client's
pay link, never a staff-entered card, through the same `markInvoicePaid` path as #24 — one
settlement path, no exceptions. The booking button runs the calendar cross-check or it does
not ship.

**Sequence:** three bugs → #30/#31 split → #34 seams → #35 → #33 → rest of batch.

### What the journey ruling changes about what is already built

Flagged here so it is not discovered mid-build:

- **The dashboard checklist is a different list now.** It currently runs sign → deposit →
  confirm info → upload → track services. The ruled journey drops the deposit step, adds
  §7216 consent and the questionnaire as their own steps, and returns booking as optional.
  `step_pay_deposit_at` and `step_confirm_info_at` hold real dates and stay as columns; what
  changes is which steps the client is shown.
- **`welcome_soto` is now unsent and its copy is stale** — it lists paying a deposit as a
  checklist step, which the ruling removes. Left in the table for Brian to rewrite or retire;
  not deleted by me.
- **Step 3 is sequencing, not building. My earlier note was wrong — corrected 2026-08-15.**
  The isolated `/consent` screen already exists (built as #12, RC2 signed on it). Step 3
  places that existing screen into the checklist immediately after signing; there is nothing
  to build but the ordering.

  I had written that §7216 was "collected in the intake form today". It is not. The intake's
  `communication_consent` and `esign_consent` are CAN-SPAM/e-sign checkboxes and are not
  §7216 instruments. The audit below confirms nothing treats them as such.

### §7216 conflation audit (Brian asked; result: CLEAN)

Every path that could conflate the two, checked:

| Check | Result |
|---|---|
| Consent types | `consent_type` is (`7216_use`, `7216_disclose`, `esign`, `communication`, `sms`) — separate values, not aliases |
| What intake writes to `consents` | `type='sms'` only, via `recordSmsConsent` |
| What intake writes for the other two | `contacts.communication_consent_at` / `esign_consent_at` timestamps — **written and never read as a gate anywhere** |
| Writers of `contacts.consent_7216_status` | exactly two, both §7216-only: `compliance/consent.ts` (`recordSignedConsent`) and `consent-presentation.ts` (the `/consent` screen). Column default is `not_on_file` |
| The gate itself | `has7216Consent` / `require7216Consent` read `consent_7216_status = 'signed'` and nothing else. Callers: referrals (2 hard gates), referral visibility, CRM health |
| Draft envelopes | intake creates `signature_envelopes` of type `consent_7216` as **drafts**; a draft grants nothing, because the gate reads `consent_7216_status`, which drafts never touch |
| Production reality | 862 contacts `not_on_file`, 2 `signed` — and both signed rows are `7216_use`, `portal_checkbox`, policy `v3-t2`, i.e. RC2 through `/consent`. The consent screen is the only path that has ever produced a signed §7216 |

**Conclusion: (a) confirmed — nothing treats the intake checkboxes as §7216 consent. (b)
confirmed — step 3 sequences the existing `/consent` screen.**

**One defect found while auditing** (fixed 2026-08-15, not a conflation):
`apps/internal/app/clients/[id]/page.tsx` tested `consent_7216_status === 'granted' || === 'on_file'`
for its "Before you work this" gate. Neither string is a value of the enum, so `consentOk`
could never be true: the two clients who genuinely signed saw a green `signed` badge inside a
warning-bordered card saying the gate was unmet. It failed in the safe direction — never
claiming consent that was absent — but a permanently-red gate is one people learn to scroll
past. Both gates now share one predicate.

---

## #30/#31 — BUILT AND DEPLOYED (2026-08-15)

The split, as ruled. Pre-engagement intake untouched and still minimal; the
onboarding-voice questions are now a post-engagement questionnaire assembled from the
Form 5 A–I modules, and it is checklist step 4.

**What already existed** (and is why this was "finish the half-built thing"):
`assembleModules` fires modules from the client's service lines and industry;
`processServiceOnboarding` evaluates the flags, raises the PLLC conversion from module I,
and feeds tax complexity from module F; two routes served both. All of it tested since M14.

**What was missing was not plumbing — it was labels.** Every one of the 161 answer
options was a bare value: `qbo`, `fba`, `group_1099`. That is exactly the state the
intake definitions were in before M28 ("v1 shipped structure only, with no field labels,
because nothing rendered it"), and it is why the questionnaire could not be shown to
anyone: you cannot put "qb_desktop" in front of a client, and half this firm's clients
read Spanish.

Built:

- **161 options, EN + ES.** Values frozen — the flag rules match on them (`H3 === 'fba'`
  → multistate nexus; C4 / G4 / I6 → worker classification), so a value is a behaviour
  identifier and only the labels are new. A test asserts every option in every assembled
  module carries both languages.
- **Seed upgrade that can only run once per row.** It rewrites a module only while that
  module still holds a bare string option, so a module Brian has since edited in Admin is
  skipped and a second deploy reports zero. Verified: first run upgraded 9, second run 0.
- **`/questionnaire`** — one module per screen (49 questions on one page is unusable on a
  phone, and the modules are already honest groupings), server-side autosave, resume, and
  nothing required. These questions scope work; they are not a gate on being served.
- **`step_questionnaire_at`**, self-completing like the deposit. Submitting *is* the
  completion — a client cannot honestly tick "answered the questions" without answering.
- **The step hides for clients who have no questions.** A notice-only client assembles no
  modules; showing them a step they can never complete would hold them at 4/5 forever.

**Fixed while building:** the checklist-completion rule lived only inside the manual
step-tick route, so no self-completing step could ever finish the list. The deposit
already had that latently — a client whose last outstanding step was the deposit got the
date filled in by the dashboard GET while `completed_at` stayed null, with no remaining
step to tick. Extracted; every path that can finish a step now re-evaluates completion.

### Still open on this item

- **Spanish needs Brian's review.** 161 option labels and the questionnaire's own copy
  are my Spanish, not reviewed. Precedent is `legal_v3_es`, which waited for approval.
  Nothing blocks a client — the wording is admin-editable without a deploy.
- **Not walked in a browser.** The API is covered by tests and sabotage-verified, and the
  page builds and typechecks, but the authenticated flow has not been clicked through on a
  phone-width viewport. Worth doing before a real client sees it.

### Journey status after this

| Step | State |
|---|---|
| 1 · Login setup from one email | **built** — one welcome carrying the link, Soto and Hilo |
| 2 · Review & sign packet | existing `/sign` |
| 3 · §7216 consent, own screen | existing `/consent` — needs SEQUENCING into the checklist |
| 4 · Intake questionnaire | **built** |
| 5 · Document upload | existing `/documents` |
| 6 · Book kickoff, optional | in Quick actions; not yet a checklist step |

Steps 3 and 6 are the remaining checklist work, and both are #34's job — sequencing what
exists, not building.

---

## #34 — BUILT AND DEPLOYED (2026-08-16)

Consent and booking are sequenced into the checklist. Both screens already existed; this
was ordering and wiring, as ruled.

**The seam that was actually open.** `/consent` was not linked from anywhere in the
portal. The dashboard *knew* a §7216 offer was outstanding — it used the offer count to
suppress "you're all caught up" — and gave the client no route to it. A client could walk
the entire checklist to the end and never be asked for §7216 consent.

**Ordering is not re-implemented.** `consentsToPresent` already withholds every offer
until the Master is signed, on the grounds that a consent presented beside the document
you must sign to be served is the conditioning §7216 prohibits. So step 3 appears exactly
when step 2 completes — "immediately after signing" falls out of the compliance layer,
and the checklist only renders what it allows.

**Declining completes the step.** A step that ticked only on "yes" would make finishing
setup depend on consenting: the same pressure §7216 exists to forbid, moved to a different
screen. Answering is what is asked of the client; the answer is theirs. Sabotage-verified
— restricting the stamp to granted consents fails exactly that test.

**Booking completes from the webhook, not from a claim.** Per the standing policy that
every channel a client can claim they used must be one the system tracks, step 6 is
stamped by the Cal.com `BOOKING_CREATED` arriving. A client who books by phone leaves the
step open, which is honest: the system does not know about that meeting.
`booking.kickoff_slugs` narrows it when wanted; empty means any booking except a free
question call, because an unconfigured setting that made the step uncompletable would be
worse than one that is slightly generous.

The deposit left the displayed checklist per the ruling and no longer gates completion —
completion means every step the client can SEE is done. Its column still fills in.

**Production after deploy:** both RC2 rehearsal clients backfilled with step 3 already
complete (they answered §7216 at policy `v3-t2`), so nobody is asked to re-answer.

Found while wiring: four self-completing steps were all keyed `null` in the same React
list, and the waiting label was hardcoded to "Waiting on payment" — nonsense under a
consent step.

### One thing needing your ruling

**Your numbered journey has six steps. The checklist now renders seven.** The two extras
are `confirm_info` ("Confirm your information") and `track_services` ("Track your
services") — both already there, neither in your list. I kept them rather than deleting
two live steps on an inference.

It is not academic. In production right now:

| | signed | consent | questionnaire | tracked | complete |
|---|---|---|---|---|---|
| rehearsal | ✓ | ✓ | — | ✗ | ✗ |
| rehearsal2 | ✓ | ✓ | — | ✗ | ✗ |

**Both RC2 clients are held open by `track_services`, the step your journey does not
include.** Dropping it would complete them both.

My read, for what it is worth: `track_services` looks like #35's job to absorb — its
whole content is "look at the services list below", and #35 turns home into exactly that.
`confirm_info` is less clear; #27's prefill may make it redundant, or it may still earn
its place. Both are your call, not mine.

---

## #35 — BUILT AND DEPLOYED (2026-08-16)

`track_services` dropped, per the ruling — a step whose whole instruction was "look at
the services below" stops being a step once the services below are the home page. Its
column stays, holding the dates of clients who really did tick it.

Two defects were underneath this, both of which made the portal quietly untrue about a
client's own business.

**The services section was tax-only.** It selected `FROM tax_engagements`, so a
bookkeeping or payroll client saw nothing at all. Worse, in production **four of six
active tax engagements had no tax row either** — so those clients were invisible to
themselves too. Verified after deploy: both RC2 clients went from **0 projects visible to
2**. They were signed in, walking the journey, and their portal showed them nothing about
work that was genuinely underway.

**The client-facing name is composed, not stored.** `engagements.title` is internal and
four production rows read "Accepted quote", which is not a thing to tell someone about
their own business. Names now come from service line + tax year.

**Progress is drawn only where there is a finish line.** Tax is a pipeline, so a position
in the stage ladder means something. Bookkeeping and payroll are ongoing — a bar creeping
toward completion would promise an ending the service does not have, so they show whether
they are running instead.

**Scheduling shows real bookings**, which needed somewhere to keep them. The Cal.com
webhook fired, tasked the team and wrote an audit row, and kept nothing a client-facing
screen could read — so the portal could offer a booking link and then show the client
nothing about the booking they just made. Per the policy attached to this finding, an
audit row is tracked forensically and untracked in the sense that matters to the person
who booked. `client_bookings` is written by the webhook only, never by a client asserting
a meeting exists, and is idempotent because Cal.com retries.

**Found while verifying:** completion was only ever evaluated when a client ticked a step,
so it depended on them having some OTHER step left to press — and the automatic steps tick
nothing. Dropping `track_services` turned that into a live problem: the clients who had
finished everything else were left with `completed_at` null, and no action of theirs would
have re-examined it. They would have stared at a checklist with every box ticked instead
of seeing their home. Every dashboard load now settles it.

### Still open

- **Not walked in a browser.** Same as #30/#31 — API tested and sabotage-verified, builds
  clean, but the authenticated home has not been clicked through at phone width.
- **`engagements.title` holds legacy junk internally.** The client no longer sees it, but
  four active engagements still read "Accepted quote" on the ops side. Worth a pass, not
  urgent, and not something I would rewrite without a ruling on what they should say.

---

## Batch status

| # | State |
|---|---|
| 27 · prefill held fields | **awaiting ruling** — recommend (a), authenticated sessions only |
| 28 · free-text for every "Other" | ruled, **not yet built** — every Other except `demo_race` |
| 29 · last-year gross revenue | **awaiting ruling** — replace or add, required or optional, which year |
| 30 · onboarding voice | **built** (via the split) |
| 31 · questionnaire as a step | **built** |
| 32 · portal-access status + inline grant | ruled, **not yet built** |
| 33 · client record as operating surface | ruled, **not yet built** |
| 34 · one flow, seams closed | **built** |
| 35 · post-onboarding home | **built** |

Remaining build work in the batch: **#28, #32, #33**, plus #27 and #29 once ruled.
`confirm_info` is re-evaluated when #27 ships, per the ruling.

---

## #29, #28, #32, #33 — BUILT AND DEPLOYED (2026-08-16)

**#29 — gross revenue as a figure.** Replaces `revenue_range` on the intake; optional;
labelled with the named year. The label carries a `{{tax_year}}` token resolved when the
form is SERVED, from the same `currentTaxYear()` the filing lane uses — a year typed into
the stored definition rots exactly the way "last year" does, only more quietly. The figure
is stored WITH the year it describes, held by a CHECK constraint. Production serves
"2025 gross revenue" / "Ingresos brutos de 2025". `revenue_range` the column stays: staff
set it, the migrated book carries it.

*Fixed alongside:* the intake computed its tax year as `new Date().getFullYear() - 1` —
the server's year in UTC — beside a shared `currentTaxYear()` computed in Chicago. They
disagree for six hours every New Year's Eve, so a late-December intake would have created
a tax engagement stamped with the wrong year.

**#28 — "Other" stops being a dead end.** Free-text companions on `industry`, `how_heard`
and Hilo's `business_kind`; **`demo_race` deliberately without one**, and a test asserts
the exception as firmly as the rule. `industry` mattered most: it drives NAICS *and* Form 5
module routing, so choosing Other silently dropped the client out of industry-specific
onboarding. Required only when they chose Other; stored only when they chose it, so a
client who changes their mind does not leave a stale description beside a real industry.

Both shipped as new definition versions (Soto v3→v4, Hilo v2→v3). v3 had been served for
minutes with zero submissions, so amending it would have been harmless — and still wrong.
A version that was in force is frozen.

**#32 — portal access is four states.** not invited / invited / active / revoked, derived
rather than stored, replacing a boolean that conflated "invited and never arrived" with
"using the portal". Invited carries WHEN, because links expire in minutes and an invite
from three days ago is functionally not-invited. The button never disappears once an
account exists — hiding *Resend* hides the one action that helps. Revoked gets no
one-click restore. Production: **861 not invited, 2 active, 0 invited**.

*Caught before shipping:* my first state query had a CASE arm for the missing row, which
never fires — with no `portal_users` row the subquery returns no row at all, so every
client without an account would have read NULL rather than "not invited". On 861 contacts
that is the whole book.

**#33 — the client record as an operating surface.** Invoices, editable basic info, and
scheduling, with both rulings enforced server-side rather than in buttons:

- **Staff never take a card.** "Take payment" is *Send reminder* plus the client's own pay
  link shown for reading out on a call. No staff-side checkout exists; the Stripe session
  is created under the client's portal session. A test asserts the reminder leaves
  `status` and `amount_paid_cents` untouched.
- **The calendar cross-check is in the endpoint.** A client with something booked gets a
  409 and the screen shows that session. In the button it would be a habit; in the route
  it is a rule. Meetings scope to an open engagement belonging to *this* client.

The reminder is **not** behind `isAutomationEnabled` — that gate exists so no client gets
an AUTOMATED message before Brian arms it, and `ar_dunning` still suppresses the automatic
chase. A person clicking a button about a named client is the decision the gate stands in
for, which is already how sending an engagement packet works. **Flagged for Brian to
overrule if he disagrees.**

Editable info is limited to fields that go stale — name, contact details, language,
preference. Status, consent and the gates stay read-only: those change because something
happened, and a text box beside them invites asserting a fact rather than recording one.

### Batch complete

| # | State |
|---|---|
| 27 | **awaiting ruling** — recommend (a), authenticated sessions only |
| 28 · 29 · 30 · 31 · 32 · 33 · 34 · 35 | **built and deployed** |

**#27 is the only item left**, and it is blocked on a ruling, not on work.

### Still open across the batch

- **Spanish is mine and unreviewed** on the questionnaire's 161 option labels, the #28
  companions, and the #29 label. Brian is walking `/questionnaire` in Spanish as RC2.
- **The authenticated flows have not been walked at phone width** — the questionnaire,
  the new portal home, and now the client record. All are API-tested and sabotage-verified;
  none has been clicked through.
- **`engagements.title` holds legacy junk** ("Accepted quote" on four active rows). Clients
  no longer see it; the ops side still does.

---

## #27 — BUILT AND DEPLOYED (2026-08-16). BATCH COMPLETE.

Prefill only behind an authenticated portal session. The unauthenticated pre-engagement
form prefills nothing — verified in production: the public route returns
`key, version, definition, consentTextPending, rehearsalBanner*` and no contact block.

That is a privacy shape, not a convenience one. A public form is resumable by whoever
holds its link, so prefilling it would turn that link into a disclosure of data the client
never typed there. Behind a portal session there is no new exposure — it is the same data
they can already read on `/profile`. The sabotage pass adds the tempting shortcut (a
contact block on the public route) and the test fails, which is the point.

**`confirm_info` dropped, per the earlier ruling.** The questionnaire opens with the held
fields prefilled and correctable, so a separate confirm-your-info step is duplicate work.
Email is shown and NOT editable: it is the login identity, `/portal/me` has never accepted
a change to it, and someone who needs it changed should reach a person. Saving goes
through that same endpoint — a second write path for a contact would eventually disagree
with the first about what a client may change.

**Consequence worth noting:** the questionnaire now applies to EVERY client, not only
those whose services fire a module, because every client has details. That inverts the
#31 test which asserted the opposite; it now guards what did *not* change — that no module
is invented for a client whose services do not call for one.

### The canonical journey, as shipped

| Step | Surface | Completes |
|---|---|---|
| 1 · Login setup | one email carrying welcome + link | arriving |
| 2 · Review & sign packet | `/sign` | by hand |
| 3 · §7216 consent | `/consent` | on ANSWER — yes or no |
| 4 · Questionnaire | `/questionnaire` | on submit |
| 5 · Upload documents | `/documents` | by hand |
| 6 · Book kickoff *(optional)* | scheduler | when Cal.com says so |

Deposit is collected at quote acceptance, before the journey. `confirm_info` and
`track_services` were absorbed (by #27 and #35). All their columns survive.

### Batch status: 27–35 all built and deployed

Also cleared while here: `engagements.title` backfilled from the same composition the
client sees — 4 rows of "Accepted quote" → "Taxes", **0 placeholders remaining**. Narrow
on purpose: "2025 intake" and a human-written withdrawal note were left alone, because
neither is placeholder text.

### What remains open across the whole batch

1. **Spanish is mine and unreviewed** — the questionnaire's 161 option labels, the #28
   free-text companions, the #29 revenue label, and now the #27 details screen. Brian is
   walking `/questionnaire` in Spanish as RC2; findings come back numbered.
2. **No authenticated flow has been walked at phone width** — questionnaire, portal home,
   client record. All API-tested and sabotage-verified; none clicked through.
