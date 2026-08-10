# Lessons

Patterns captured after corrections from Brian, per CLAUDE.md's self-improvement
loop. Review at session start. Format: **Lesson** — what went wrong → the rule
that prevents it.

**Every UI milestone ships with phone-width screenshot verification**
(2026-08-09, mobile defect pass) — desktop-verified screens shipped with
page-level horizontal scroll at 390px, a filter rail rendering inline into
the content flow, and an overflowing nav; Brian had to phone-screenshot the
defects himself. → Rule: before any UI milestone is "done", browser-test
every affected screen at 390×844 — assert
`document.documentElement.scrollWidth <= clientWidth` per page, exercise the
phone-specific affordances (sheets, cards, scrollable tabs), and include the
390px screenshots in the report. Wide content scrolls inside its own
container; the page itself never scrolls horizontally.

**Match the tool being replaced, not the minimum viable screen** (2026-07-11,
M25 task UI) — I shipped thin v1 task views (basic list, kanban with move
dropdowns) for a system explicitly specced as a "full Trello replacement"
whose real benchmark was the firm's live Zoho CRM: dense sortable tables,
saved/shared views, a full filter rail, four view types, recurrence,
reminders, bulk ops. Brian rejected the v1 views ("the thin v1 views don't
ship") and had to supply screenshots to reset the bar. → Rule: when a module
REPLACES a tool the team uses daily, benchmark the build against that tool's
actual screens BEFORE building — ask for screenshots/exports of the live
system up front, and treat "replacement" in the spec as meaning feature
parity for the workflows in daily use, not a functional subset.

## Run the full `npm test`, not just the workspace tests
**Pattern**: I reported "172/172 green" at M26.5 from `npm run test --workspaces`.
That skips `npm run check:prices`, which runs FIRST in the root `npm test`. A
price literal in a `bundles.ts` comment had been committed and sat broken until
the next full run.
**Rule**: the green check is `npm test` from the repo root. A workspace-only run
is a fast inner loop, never the thing I report.

## A status flip before an outbound send must be able to roll back
**Pattern**: `sendQuote` set status='sent' + token hash, then emailed. When the
email threw, the quote sat in 'sent' holding a hash whose plaintext died with the
request — the client had no link and `sendQuote` refuses non-draft quotes, so the
quote was unrecoverable.
**Rule**: when a state change claims an outbound message happened, wrap the send
and undo the claim on failure (audit the failure, rethrow). Ask of every
send path: "if the transport fails here, is the record still true?"

## Freeze BOTH languages when copying client-facing text onto a record
**Pattern**: quote lines stored one description, chosen by the quote's language.
A client toggling the portal to Spanish got Spanish chrome around English service
names — the price book has both, the snapshot threw one away.
**Rule**: any table that snapshots client-facing wording (quote lines, invoice
lines, checklist items) stores `*_en` AND `*_es`. The reader's toggle relabels;
it never re-prices.

## The global `input { width: 100% }` rule breaks inline checkboxes
**Pattern**: both apps style all inputs to full width. Any checkbox placed inline
with its label takes the whole row and shoves the label to the middle of the card
— visible only in a 390px screenshot, not in the DOM assertions.
**Rule**: inline checkboxes need an explicit `width/height` + `flex: 0 0 auto`
override. And a page passing `scrollWidth <= clientWidth` is necessary but NOT
sufficient — look at the image.

## Don't demote an existing client into the leads funnel
**Pattern**: quoting extra work to a current client moved `lead_stage` to
'quoted', and an expired add-on quote would have marked a paying client 'lost'.
Conversion metrics would have counted real clients as open leads and lost deals.
**Rule**: pipeline stages describe LEADS. Terminal-forward states are sticky:
record the attempted move in history, skip it on the record, and say so.

## A CSV that leaves the system is untrusted input somewhere else
**Pattern**: report exports carry client names and notes. A cell starting with
`=`, `+`, `-`, or `@` is a formula to Excel and Sheets, so exported client data
becomes executable content in whoever opens it.
**Rule**: any CSV/TSV writer prefixes formula-triggering text cells with an
apostrophe, quotes per RFC 4180, and converts cents to decimal dollars — raw
cents under a money header reads 100× too large.

## Generate the export from the same definition as the screen
**Pattern**: it is easy to write a report query for the UI and a second, similar
query for the CSV. They drift, and the numbers still look plausible.
**Rule**: one registry per report — columns, rows, and caveats — with the CSV
serializer consuming exactly what the JSON returned. Test that no row carries a
key the columns don't declare and none omits one they do.

## `to_char(0, 'FM990.99')` is `0.`
**Pattern**: the FM modifier strips the fractional zeros but leaves the decimal
separator, so a zero total renders as a dangling `0.` that looks truncated.
**Rule**: use `FM990.00` when the decimals must always show. Any format string
gets checked against its ZERO case, not just a representative value.

## A hard rule is a constant, not a setting
**Pattern**: I default to making thresholds admin-editable so Brian never needs a
deploy to change policy. For the S corp session floor that instinct was wrong — a
floor that can be edited down to zero is not a floor.
**Rule**: when CLAUDE.md calls something non-negotiable, it gets a named constant
and a comment explaining why it is NOT a setting. Store *evidence that it bound*
(a boolean on the record), never a switch that disables it.

## Gate every path that can lower a guarded value, especially the friendly one
**Pattern**: the S corp floor was easy to enforce on create. The dangerous path
was "maintenance mode" — a deliberately positive-sounding downgrade whose whole
job is reducing session frequency.
**Rule**: enumerate every write path that can move a guarded value the wrong way
and make them all call the same guard function. Then write the test as an attempt
to get AROUND the gate, not a demonstration that it works on the happy path.
Assert a refused write leaves NOTHING behind — no partial columns, no history row.

## Refuse, don't clamp
**Pattern**: it's tempting to silently raise a value to satisfy a floor.
**Rule**: clamping changes what a client is billed without anyone deciding to.
Throw with the reason and the evidence, and let a human choose.

## Test timeouts are hang-detectors, not performance budgets
**Pattern**: a stubbed-pipeline spec polled with an 8s ceiling. Alone it finished
in 3.2s; under the full suite, CPU contention pushed it past 8s and it flaked.
**Rule**: a poll loop that returns on success can afford a generous ceiling.
Size timeouts for the worst contention case, not the observed fast case — and if
a spec flakes, root-cause it before re-running, then say so.

## Compliance text must be appended by the sender, not authored in the template
**Pattern**: an unsubscribe footer or STOP line living in editable copy can be
deleted by whoever edits the copy — and the edit looks harmless.
**Rule**: legally-required text is concatenated at send time by the send function.
Then test it by authoring a body that deliberately omits it and asserting it
arrives anyway.

## Marketing opt-out is not transactional opt-out
**Pattern**: it's tempting to have one "do not contact" flag.
**Rule**: keep announcement opt-out separate from service delivery, and TELL the
client which one they just used. A client who thinks they switched off "your
return is ready" is worse off than before they clicked.

## Read the test harness defaults before asserting on gated behavior
**Pattern**: `createTestConfig` enables every automation so ON-path specs work.
My kill-switch test inherited that and "proved" the opposite of prod behavior.
**Rule**: a spec asserting a gate's OFF state sets the state itself. Never infer
prod defaults from harness defaults.

## Order suppression checks by how badly getting it wrong would land
**Pattern**: a review-request gate could check its cheapest condition first.
**Rule**: for anything client-facing, evaluate the most embarrassing condition
first (open notice, dispute) so the reason surfaced is the one a human would give.
And record the suppressed attempts — a rule is only provable from its near-misses.

## Date-window fixtures need ≥2 days of slack, not 1
**Pattern**: jobs compare a `timestamptz` (`now() - N days`) against a
date-truncated window (`todayChicago()::date - M days`, i.e. midnight Chicago).
Between UTC midnight and Chicago midnight the two calendars differ by a day, so a
fixture with exactly one day of margin flips and the job silently returns 0. Three
separate assertions in one spec were riding on <1 day of slack; all passed for
weeks and all failed inside the same five-hour window.
**Rule**: when a fixture must clear an N-day window, backdate by N + at least 2.
And put the job's payload in the assertion message — a bare `>= 1` failure does
not say which half of a two-window job came back empty.

## Verify against HEAD before assuming a failure is yours
**Pattern**: two specs failed right after a large change of mine. Both were
pre-existing latent flakes that had just entered their trigger window.
**Rule**: when a spec fails after a change, `git stash` and run it on HEAD before
diagnosing. It costs one command and it decides whether you are fixing your bug
or someone else's — and it stops you "fixing" working code.

## Check permission before capability, so the compliance gate is testable
**Pattern**: `sendSms` checked Twilio credentials BEFORE the TCPA consent gate.
In any environment without credentials — dev, CI, every test — it returned
`twilio_not_configured` and the consent gate was never reached. The gate was
correct but unreachable, so nothing could prove it worked.
**Rule**: evaluate "are we ALLOWED to do this?" before "CAN we do this?". It
makes the compliance decision observable without a live vendor, and it reports
the truer reason: a client who never opted in is blocked by consent, whatever the
vendor state.

## Read the enum before writing the value
**Pattern**: I wrote `status = 'granted'` into `consents` from memory. The enum is
requested / signed / declined / revoked. It cost two debug cycles because the
route's 500 surfaced as an opaque `internal_error` in the test.
**Rule**: for any enum-typed insert, query `enum_range` first. And assert the
response status on EVERY write in a test, even setup writes — an unasserted
setup call that 500s silently makes a later assertion fail for the wrong reason.

## "Only me" is inexpressible if two roles hold the wildcard
**Pattern**: Brian asked for a permission seeded to him alone. Both the ceo and
ed_coo roles hold `'*'`, so any ordinary permission key would have granted it to
Jackson too — silently, and the seed would have looked correct.
**Rule**: for narrow authority over money, use an EXPLICIT-ONLY permission the
wildcard does not satisfy (`EXPLICIT_ONLY_PERMISSIONS` in plugins/auth.ts). Then
test the premise, not just the outcome: assert the other wildcard holder really
has `'*'` AND still gets a 403. Keep the set small and financial.

## Derive the exception flag, don't let the caller assert it
**Pattern**: a deposit "override" set equal to the standard amount is not an
exception, but a caller-supplied flag would have marked it as one and sent A/R
chasing a normal engagement.
**Rule**: compute the classification by comparing to the source of truth
(standard vs charged), and store BOTH numbers. A flag alone answers "was this
unusual"; the pair answers "unusual compared to what", which is the actual question.

## Enforce "incomplete" rules with a build check, not a comment
**Pattern**: CLAUDE.md said a task-generating feature without an SOP hook is
incomplete. That is unenforceable prose until something fails.
**Rule**: for rules of the shape "X must always have Y", write a script that greps
for X and fails without Y, and wire it into `npm test` beside check:prices. Allow an
explicit opt-out WITH a required reason, so the rule is "decide in writing", not
"do the work now". Mine caught a genuine gap on its first run (f8821_send) and a
second the moment Hilo events added a task type — which is the whole return on it.

## RETURNING gives the NEW row, so read before you clear
**Pattern**: `UPDATE … SET seat_number = NULL … RETURNING seat_number` returned
NULL, so the freed seat was never handed to the waitlist. Silent: the cancellation
worked, the promotion just never happened.
**Rule**: when the OLD value drives the next step, SELECT it first (or use a CTE).
Any `RETURNING` of a column the same statement overwrites is a bug.

## Hold capacity with a constraint, not a count-then-insert
**Pattern**: two people registering for the last workshop seat is the normal case,
not an edge case. Counting rows and then inserting oversells under concurrency.
**Rule**: give each unit of capacity an identity (seat_number) with a partial
unique index, claim the lowest free one, and treat the unique violation as "lost
the race" — routing the loser to a waitlist. Then TEST it with concurrent requests;
a sequential test passes either implementation and proves nothing.

## Don't sign the machine's work with a person's name
**Pattern**: my first SOP seeder attributed 23 generated skeletons to Brian because
a CHECK required an approver on anything published. That would have put his name on
procedure he never wrote.
**Rule**: when a constraint pushes you toward a false attribution, the constraint is
wrong. Require the timestamp, leave the approver NULL, and surface "not yet reviewed
by a person" in the UI.

## Run the production build before deploying a UI change
**Pattern**: `/sops` worked all session in dev and then FAILED the deploy at
`next build` — a client component calling `useSearchParams()` must sit inside a
Suspense boundary or prerendering errors. Dev mode does not prerender, so nothing
locally could have caught it. The deploy aborted safely (production stayed on the
previous migration), but it cost a failed deploy.
**Rule**: any turn that adds or changes a Next route runs
`npm run build --workspace=@saos/internal` and `--workspace=@saos/portal` before
`scripts/deploy.sh`. Typecheck + tests + 390px screenshots do not cover the
production build; it is its own class of failure.

## Enum arrays come back from node-postgres as raw strings
**Pattern**: `service_lines service_line[]` selected plainly arrives as the string
`'{tax}'`, not an array — node-postgres has no parser for an array of a *custom*
enum type. Every `.filter()` on it threw, and packet assembly was broken for every
client. TypeScript said `ServiceLine[]` and believed it, because the row type is a
claim about the query, not a check of it.
**Rule**: cast enum arrays to `::text[]` in the SELECT (pg parses text[] natively).
More generally: a generic on `db.query<T>` is an assertion, not a validation — for
any column type beyond scalars, prove the shape with a test that touches the value,
not just the query.

## A template variable nobody fills is a document with `{{...}}` in it
**Pattern**: the v3 Master body ends with "Service Schedules attached at signing:
{{schedules_attached}}". Nothing filled it, so the first render threw — and if the
variable had had a default instead, a client would have signed a document with a
mustache in it.
**Rule**: when a template declares a variable, something must own filling it, and
that owner should derive it from data rather than accept it from a caller. Assert
`doesNotMatch(/\{\{/)` on anything a client will read or sign.

## When the world changes, invert the test — don't delete the assertion
**Pattern**: legal text landing broke three specs that used real legal templates as
placeholder fixtures ("the seeded consents are placeholders"). The tempting fix is
deleting the assertion; the honest fix is that those tests were about the GATE, not
about the launch state.
**Rule**: rewrite the test to create the condition it needs (flag a template on
purpose, assert both directions) so it keeps working the next time the state moves.
And when a suite asserts pristine seed state against a live dev database, say so
out loud — `packages/db`'s suite fails because Brian confirmed a price, which is a
test problem, not a data problem.

## A test suite outside `npm test` is a suite that does not exist
**Pattern**: `packages/db` names its script `test:db`, so `npm run test --workspaces`
skips it. It had been asserting a pre-v3 world for some time and nothing noticed.
**Rule**: the reportable number comes from root `npm test`; anything outside it must
be named as outside it in the report, every time, or it silently rots.

## Don't build a production bundle in a tree a dev server is about to use
**Pattern**: running `next build` and then `next dev` on the same `.next` left the
portal serving 500s (`build-manifest.json` unreadable), and Dropbox's file locks
meant `rm -rf .next` could not fully clear it either.
**Rule**: builds are for verification before deploy; clear `.next` (or accept the
locked `cache/` subdir and restart) before starting dev in the same workspace. If
the dev server returns Internal Server Error immediately after a build, suspect the
tree, not the code.

## A deploy that asserts local state over server state destroys secrets silently
**Pattern**: `deploy.sh` did `scp .env.production -> /opt/saos/.env`. Brian pasted the
Docuseal API token directly on the server; my next deploy overwrote the file and the
token became an empty string. The symptom was a 401 from a service that had worked
ten minutes earlier — and because nothing announced the overwrite, the first
diagnosis was "he must have installed it wrong". He rotated and reinstalled it twice
for a bug that was mine.
**Rule**: shipping config must MERGE, never overwrite: a blank in the shipped file
cannot beat a non-empty value on the server, while a non-blank local value still
wins so rotation works. Same shape as the price-book confirmation fix — machine
defaults must never overwrite a human's deliberate value. Guarded by
`scripts/check-env-merge.mjs` in root `npm test`.
**Corollary**: before telling a user their credential install "didn't take", check
whether your own tooling ate it. `.env.production` had exactly two blank keys —
`DOCUSEAL_API_TOKEN` and `STRIPE_WEBHOOK_SECRET` — so the Stripe secret was next.

## Check the signing artifact against the data model before anyone signs
**Pattern**: the packet model says "Master + only the schedules this client needs",
and the §7216 consents must be presented separately AFTER signature. The Docuseal
template Brian uploaded was one static PDF of the entire legal package: Master +
all five Schedules + both consent forms, one signature on page 2. Signing it would
have (a) had the client physically accept schedules the database says they never
accepted, and (b) captured §7216 consent bundled with the engagement document —
the exact conditioning the package's own instructions forbid.
**Rule**: when a document is assembled dynamically in code but signed as a fixed
vendor template, verify the vendor artifact's CONTENTS against the model before the
first signature. `GET /api/templates` answered it in one call, before any client
touched it — cheaper than discovering it from a signed PDF.
