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

## Bugs found during the pass

These are defects in what is already shipped, independent of how #27–#35 are ruled.

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
