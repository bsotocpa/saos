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

## A watchdog nobody installed is a watchdog that does not exist
**Pattern**: ClamAV sat unhealthy for ~12 hours — 1470 failed health checks, wedged
mid-database-reload — and Brian learned about it because I happened to paste a
container listing into a report. Nothing watched container health at all. This is the
second instance of the same class: the 2026-08 drill found the backup cron had never
been installed either.
**Rule**: every watchdog is installed by `deploy.sh`, idempotently, so it cannot be
silently missing. And the alert has to reach a human surface (notification + task),
not a log line nobody reads.
**Corollary**: Docker health answers "does the container think it is fine". Also probe
what the APP needs — a container can be healthy and unreachable from the API, and that
failure is invisible to Docker.

## Don't give the app the Docker socket to watch itself
**Pattern**: the obvious way to monitor containers is mounting /var/run/docker.sock
into the API. That hands root-equivalent host control to the most internet-exposed
process on the box.
**Rule**: host-side cron reads Docker and POSTs a summary to a secret-authenticated
webhook; the API stores and alerts but never inspects. Same split as the backup cron.

## "Not silent" is not the same as "not fail-open"
**Pattern**: when clamd was unreachable, ingest recorded `scan_status = 'skipped'`
with the reason and quarantined the file — genuinely not silent. But filing refused
only `'infected'`, so an UNSCANNED document could still be filed into a client record
by anyone who did not read the status column.
**Rule**: for a safety gate, enumerate what is ALLOWED (`=== 'clean'`), never what is
forbidden. A denylist of one value passes everything new that ever gets added.

## Order refusals by what the user should do next
**Pattern**: my scan gate fired before the "assign a contact" check, so a staffer
triaging an unmatched attachment was told to get a CEO override when the actual next
step was assigning a contact.
**Rule**: cheap request validation first, safety gates after — except the hardest
block (infected), which precedes everything. The first error a user sees should name
the first thing they can fix.

## API-level verification proves capability, not reachability
**Pattern**: three findings in one evening were the same failure — the pipeline card
was not clickable, the packet card had no Review or Send button, and /clients/[id] had
no nav entry or list at all. In every case the backend was complete, tested, and
deployed; the UI affordance did not exist. My tests proved the endpoint worked, which
is not the same as proving anyone could reach it. Worse, in the packet case the UI
literally instructed Brian to do something the screen gave him no way to do.
**Rule** (Brian's, added to the UI milestone checklist): every entity surfaced on a
screen must have its promised actions clickable, verified by a BROWSER WALKTHROUGH —
open the page, click the thing, land somewhere. Route tests and `curl` do not count.
If a banner or empty state tells the user to take an action, the control for that
action must be in the same view.
**Corollary**: an endpoint that returns JSON is not reviewable by a human. "Give me
the document URL" needed a text/html route, not the JSON one the API already had.

## §7216 CONSENT-SCREEN ISOLATION — launch-gate tier
**Same class as no-hardcoded-prices and the placeholder gate: breaking it breaks
compliance, not layout.**

**Rule** (Rev. Proc. 2013-14, Brian's ruling 2026-08-11): for 1040-series clients, an
electronic §7216 consent must be presented on a screen whose content pertains SOLELY
to the consent. In this codebase that means:
- Consents live on `/consent`, never as a card on another page.
- The site nav is suppressed there (see shell.tsx) — it is other content.
- No checklist, no progress bar, no thank-you residue from the signature.
- The screen states the consent text, its DURATION, an affirmative action, and an
  equally-weighted decline. A decline styled as the lesser button is a nudge, and a
  §7216 consent may not be nudged.
- It renders only AFTER the signature confirmation is dismissed. Never in the same
  view as the signature.

**How it was found**: the consent used to render on `/sign` directly under the
"Signed — thank you" panel. Brian granted it SIX SECONDS after signing and did not
register it as a separate decision — he asked afterwards whether it had presented at
all. The row was valid and the ordering was legal; the presentation still let a
consent feel continuous with the engagement, which is exactly what the rule prevents.
Correct data is not the same as a valid consent.

**Corollary**: "it works and the audit row is right" does not settle a consent
question. Ask whether the person could tell they were being asked something separate.

## A column name recalled from memory is a 500 in production
**What happened**: I added `d.original_filename` to the portal Messages query. The
column is `documents.filename`. TypeScript could not catch it — the SQL is a string —
and every existing test predated the join, so nothing failed locally. The Messages
page would have 500'd for every client on load, not just clients with attachments,
because the broken column was in the list query. It was caught only because I wrote a
test that read the row back.
**Rule**: when writing raw SQL against a table I have not touched this session, read
the column list first (`information_schema.columns` or the migration), and make at
least one test SELECT the new column. A raw-SQL typo is untyped, so the test IS the
type check.
**Corollary**: a query added to a LIST endpoint fails for everyone, not just the users
of the new feature. Blast radius scales with how ordinary the endpoint is.

## Enforce "the two paths must be indistinguishable" with a differential test
**Pattern**: Brian's requirement for Messages attachments was that a file sent in chat
stamp IDENTICAL provenance and filing metadata to a direct portal upload — "no silent
fork in the pipeline." The weak version of that test asserts the fields I happened to
remember (category, contact, uploader). That passes while a fork exists in the fields
I forgot.
**Rule**: for a parity requirement, upload/create the same input BOTH ways and loop
over `Object.keys(row)` asserting equality on every column except identity and
timestamps — then separately assert that no discriminator column (`source`, `origin`,
`message_id`, `via`) exists on the table at all. The first half catches a fork in
values; the second half catches someone adding the ability to fork later.
**Proof it has teeth**: I mutated the route to hardcode `category: 'other'` and
confirmed the differential test failed, then reverted. A parity test I have not seen
fail is a parity test I am guessing about.
**Structure over promise**: both upload routes call the same `readUpload` +
`uploadDocument`; the attachment route passes the same actor shape. Parity is a shared
code path, not two code paths kept in agreement by review.

## A row delete is not an object delete — MinIO has no cascade
**What happened**: verifying `ON DELETE SET NULL` in production, I deleted a
`documents` row directly and the MinIO object stayed behind. I found the orphan and
removed it. The application does NOT hard-delete documents — it archives by status,
and `grep "DELETE FROM documents"` across the API returns nothing outside tests — so
this was an artifact of my verification, not a live leak.
**Rule for whoever adds a delete path**: deleting a `documents` row must delete
`minio_bucket`/`minio_key` too, and the object removal must be audited like every
other document access. Client documents outliving the record that authorises them is a
retention problem, not a housekeeping one.

## "Skipped" hid two different worlds, and the gate exposed it
**What happened**: adding "filing requires a clean scan" broke two existing tests, and
the reason mattered more than the tests. `scanBuffer()` returns `skipped` both when the
scanner is BROKEN and when the deployment has no scanner at all. Dev and test have no
`CLAMAV_HOST`, so a gate on `clean` meant no document could ever file locally — the
feature would have been permanently broken outside production.
**The wrong fixes**, both tempting: treat `skipped` as passing (a missing env var then
silently files every client document unscanned, with a compliance column claiming
otherwise), or make dev run a scanner (correct but heavy, and the first person without
one gets a mystery).
**Rule**: when one status covers an operational failure AND a deployment choice, split
it, then make the permissive branch UNREACHABLE in production by assertion —
`loadConfig()` refuses to boot without `CLAMAV_HOST`. Safety belongs in a startup
check that fails loudly, not in a runtime branch that hopes. Test the assertion
itself, so removing it fails the suite rather than quietly widening the gate.
**Corollary**: a test that breaks when you add a gate is telling you where the gate's
edge cases live. Both failures here were the same missing distinction.

## Ask who pays for the outage
**Pattern**: my instinct on "portal uploads are unscanned" was to refuse uploads when
the scanner is down — fail closed, obviously correct. Brian's ruling was better and
the reasoning generalises: refusing intake makes the CLIENT pay for our infrastructure
being broken, on the surface they use most, and they cannot fix it or even understand
it. Accept and store always; gate the internal consequence (filing) instead; retry
until it resolves. A wedged scanner then costs TIME, which we absorb, rather than
uploads, which they absorb.
**Rule**: for any fail-closed decision, name who bears the cost when the dependency
fails. If it is the client and they have no remedy, look for a gate further inside the
system that produces the same safety.

## A boolean cannot say "for thirteen hours"
**What happened**: the dependency probe ran every tick and alerted correctly, and
ClamAV still sat dead for 13 hours before anyone noticed — because nothing PERSISTED
the state. "Unreachable" was recomputed each tick and thrown away, so the duration was
only recoverable from dmesg after the fact.
**Rule**: for anything whose severity is a function of how long it has been true,
store the transition, not the reading. `since` updates only when the state changes;
`last_checked_at` moves every tick. Then the surface can say "13h 5m" instead of
"unreachable", which is the difference between a blip and an incident.
**And put the consequence next to it**: the dashboard names the client-facing effect
("4 uploads waiting to be filed — clients are still being chased for them"), because
that is what makes it urgent rather than merely red.

## Group by the key before reporting a count
**What happened**: I reported "3 recordings on a contact with soto_status = active" to
Brian. The query returned three rows each showing `is_test:false, status:active`; I read
the repetition as one contact and never grouped by `contact_id`. They were THREE
different real clients — Jackson Flores, Josean Irizarry, Joseph Basilone. Brian ruled
on the one name I gave him, so my error narrowed the scope of his own decision.
**Rule**: any statement of the form "N things on a X" must come from a query that
GROUPS BY X, not from eyeballing N rows that happen to share column values. If the
report names an entity, the query must have selected that entity's identity.
**How it surfaced**: the ops Documents page listed three distinct client names side by
side and the error was instantly obvious. Building the surface found the bug in my own
reporting — which is the argument for surfaces over queries: a list a human reads gets
audited by every human who reads it.

## Restoring a value by hand is not fixing anything
**What happened**: `STRIPE_MODE=stub` was a literal in `.env.production`, and the env
merge only protects BLANK entries, so every deploy silently switched live payments back
to stub. I restored it by hand three times — 2026-08-12, then twice on 2026-08-13 — and
each time wrote "durable fix pending" and moved on. The third time was my own deploy of
the fix for the payment bug, so I broke payments while shipping payments.
**Rule**: the second time I perform the same manual restoration, that IS the task. Not
after the current one. A fix I have described but not written does not exist, and
"pending" on a thing that silently disables client payments is a decision to keep
breaking it.
**The design rule underneath**: "non-blank local wins" is right for SECRETS (shipping a
rotated token should replace the old one) and exactly wrong for MODE switches, because
nobody ever intends "every deploy turns the feature back off". Secrets rotate; modes are
operational state that lives where the operator set them. Different rules, so
`check:env-merge` now fails the build if a runtime-mode key reappears as a literal.
**Verify a deploy fix by deploying**: I only believed this one after running a full
deploy and reading `STRIPE_MODE` back out of the running container — three times. A
merge script that passes its unit tests still has to survive the real deploy.

## The guard firing on my own comment is the guard working
**What happened**: `check:prices` failed my build on `$250` written inside an
explanatory comment. My first instinct was that the guard was over-broad.
**Rule**: when a build guard I wrote fires on my own code, the default is to change the
code, not the guard. A dollar figure in a comment goes stale the moment the price book
moves, so removing it was the correct fix and the guard was right. Weakening a guard to
make my own commit pass is how the guard stops meaning anything.

## A test that the code under test overwrites proves nothing
**What happened**: to test that placeholder action items no longer become tasks, I
seeded a bad action item into `meeting_summaries` and re-ran the pipeline. It passed —
and it was vacuous. Re-processing regenerates the summary from the summarizer, so my
seeded row was overwritten before the filter ever saw it. The test asserted a property
the stub's own output already satisfied.
**Rule**: before believing a test, ask what the code does to my fixture BEFORE the
assertion. If the path under test rewrites the state I set up, I am testing the fixture,
not the code. The fix was an injectable summarizer — control the INPUT, not the
intermediate state.
**And then sabotage it**: I only knew the rewritten test was real because removing the
filter made it fail. Every "prove it" claim in this build has come from breaking the
fix and watching the specific test go red — a passing test on its own has never been
evidence of anything.

## Sabotage with a value the system accepts
**What happened**: to prove the meeting-recovery test was live I changed a status
literal to 'SABOTAGE'. Three tests failed instead of one — the string is not a valid
`meeting_status`, so the whole query threw and took unrelated cases with it. The result
looked like strong evidence and was actually noise.
**Rule**: sabotage must be the OLD BEHAVIOUR, not a crash. Replace the new branch with
what the code used to do and confirm exactly the new test fails and the old ones still
pass. A blast radius wider than the fix means the experiment was not controlled.

## Schema plus seed is not a data migration
**What happened**: I added `deposit_cents` in a migration and set the deposits in the
price-book seed, ran 393 passing tests, and opened the admin page — every line said "no
deposit". The seed only ever writes v1; the book in force was v3. Tests all passed
because a fresh test database has v1 in force, so the seed and the live book are the same
row set there and only there.
**Rule**: when a table is versioned, ask "which version does the seed write, and which
one does production read?" before believing a seeded value shipped. If they differ, the
change needs a script that creates the next version — and that script, not the seed, is
the deliverable.
**How it surfaced**: by opening the page as Brian would, on the data he actually has.
The test suite could not have caught this, because the fixture makes the two versions
identical. A green suite is evidence about the code, not about production's data.

## Ask what the flag already means before reusing it
**What happened**: I flagged twelve lines with `needs_confirmation` so Brian could rule
on their deposits. The golden pricing test went red: that flag means the PRICE is
unsettled, so every 1040 quote started reporting itself as provisional over a $200 base
return nobody had questioned.
**Rule**: before reusing an existing flag for a new question, find out what reads it. A
column with one meaning and two writers ends up with neither. Two columns feeding one
queue cost nothing; one column meaning two things silently changes behaviour somewhere
that never mentioned the feature.

## A guard can be right about the rule and wrong about the question
**What happened**: the deposit-override guard tested `deposit_item_code IS NULL` to mean
"this quote has no deposit". That was the same question until v4 moved deposits onto the
service lines — after which every normal quote had a real deposit and no item code, so
the guard refused every override with "add the deposit item first", naming a thing that
no longer existed. The RULE it protected (an override adjusts an amount, it never invents
one) was still exactly right.
**Rule**: when a model changes, grep for the PROXIES for the thing that moved, not just
its column. `deposit_item_code` was standing in for "has a deposit", and a proxy survives
a refactor looking healthy while quietly answering a different question. The fix is to
ask the real question — call the resolver — not to patch the proxy.
**Same shape, same day**: two tests failed on stale PREMISES rather than stale
assertions. `IND_BASE_SINGLE` gained a deposit, so "an override cannot invent a deposit
where there is none" was no longer testing its rule — the setup had quietly stopped
matching the scenario. A test can rot from underneath without its assertion changing.

## The seed will not fix a row that already exists
**What happened**: I retired `booking.deposit_items` by editing the settings seed. The
deploy reported "1 of 33 settings inserted (existing keys left untouched)" — and the live
row kept its old map and old description. The code no longer read it, so behaviour was
right and Admin → Settings was lying.
**Rule**: settings and templates seed with ON CONFLICT DO NOTHING on purpose, so a value
Brian tuned is never stomped. That means editing a seed changes NOTHING that already
exists. Retiring live data takes a script — the same lesson as "schema plus seed is not a
data migration", one table over.

## Carrying a value across means checking it still makes sense there
**What happened**: the v4 script moved DEPOSIT_1040's $250 onto the individual base
returns, which are priced $150–$200. So v4 — live for a day — asked a single filer to
prepay $250 for a $150 engagement and be owed $100 back before any work started. I
carried the number faithfully and never asked whether a deposit could be larger than the
thing it is a deposit for. Brian's pricing sitting caught it as a reprice, not as a bug.
**Rule**: when moving a value from one model to another, write down the invariants it
now sits inside and check each one. "Deposit ≤ price" is obvious once stated and
invisible while you are thinking about where the number goes.
**And scope the guard to where it means something**: the first version of the constraint
would have flagged ACCT_CATCHUP_HOURLY ($75/hour, $200 work-start deposit) as broken. A
per-hour line has no total until it is quoted, so the comparison only applies to
`unit = 'flat'`. A guard that fires on correct data teaches people to disable guards.

## The seed is data too, and it breaks the same way
**What happened**: I added the deposit-ceiling constraint, and the whole suite hung —
because the SEED carried the same $250-on-a-$150-line defect, so every fresh test
database failed to seed. I had fixed the symptom in production and left the source
producing it.
**Rule**: after adding a constraint, run the seed before running the suite. A seed
violation surfaces as a slow, confusing test hang rather than a clear failure, and the
scratch-database harness answers in thirty seconds what the suite takes ten minutes to
half-say.

## Stop putting backticks and $ inside shell-quoted node -e
**What happened**: three times in one session. A `node -e "..."` containing backticked
identifiers had them executed as shell commands, so the file I wrote had every
identifier replaced by empty output and one replaced by `npm help`'s error text. Another
lost the `$` from `$${params.length}`, producing `deposit_cents = 6` instead of a bind
placeholder and a 500 from the version endpoint. I have a lesson about exactly this and
kept doing it because `node -e` feels faster than opening the file.
**Rule**: content containing backticks, `$`, or `${...}` goes through Write/Edit, or a
`.mjs` file executed by path. Never through a shell-quoted `-e`. It is not faster: each
of these cost a debugging round trip, and one of them shipped a broken query into a test
run I then had to diagnose.

## A hanging test suite is usually the database, not the code
**What happened**: twice the full suite blew past a ten-minute timeout with no output.
The first time the seed violated a constraint I had just added; the second time Docker
Desktop had stopped and Postgres was simply gone. Both looked identical from outside —
silence — and neither was a slow test.
**Rule**: when the suite hangs rather than fails, check the database before reading any
code: is it up, and does the seed still apply cleanly against a scratch database? That
answers in thirty seconds what the suite takes ten minutes to not say. npm buffers
output, so a backgrounded run shows nothing at all until it finishes.

## RETURNING sees the row AFTER the update
**What happened**: `UPDATE invoices SET applied = applied + LEAST($2, total - applied)
... RETURNING LEAST($2, total - applied)` reported 0 every time. RETURNING evaluates
against the POST-update row, where the remaining balance is already zero — so the credit
was applied and then reported as not applied, and the caller skipped it. Money silently
vanished from an invoice that was otherwise correct.
**Rule**: never compute a returned delta from columns the same statement just changed.
Capture the pre-state in a CTE (`WITH before AS (SELECT ... FOR UPDATE)`) and return from
that. The wrong version reads as obviously correct, which is why it needs a test that
asserts the AMOUNT rather than just that a row was touched.

## Sabotage the whole path, not one branch of it
**What happened**: to prove the #19 tests were live I replaced `LINE_MAP[x] ?? null` with
`'tax'` — and one test still passed, because the bookkeeping path returns from an earlier
branch and never reaches that line. I nearly read the pass as "that test is weak".
**Rule**: when a sabotage leaves a test green, first ask whether the sabotage reached the
code that test exercises. Put it at the function's entry, where every caller goes
through it, rather than at the first line that looks load-bearing.

## Amend a translated document in both languages or neither
**What happened**: amending Master §2's English deposit clause, the script warned that a
Spanish body existed. It was approved and live — Spanish-speaking clients read it, not an
English fallback. Shipping the English alone would have left them reading a clause about
a collection path the firm had retired, and because the governing-language clause makes
English control, that is a comprehension failure rather than a legal one: the client is
misinformed and the paperwork is technically fine, which is the worse combination.
**Rule**: before amending any client-facing document, check whether a translation is live
(`needs_es_review = false`). If it is, the change lands in both languages in the same
edit, and the translated wording is named explicitly in the report as the part that was
not signed off verbatim.

## "Backfill from existing events" includes events SAOS never saw
**What happened**: backfilling the #42 contact lifecycle, I derived every contact's state
from evidence this system can see — a signed Master, an open engagement, an accepted
quote. For the 426 clients imported from Dubsado all three are absent, because their
Masters and their history are in the old system. So they landed on `lead`. That is the
letter of the rule and the inverse of its purpose: #42 exists BECAUSE a paying client
displaying as a lead misleads triage, and I then did exactly that to 426 clients at once.
The information was already in the row — before my migration those 426 were the only
contacts with `soto_status = 'active'` while the 436 from Zoho were `lead`, because the
import had encoded the distinction correctly. My recompute discarded it.
**Rule**: when a backfill derives state from events, ask what happened BEFORE this system
existed. Migration provenance is evidence — `source`, the legacy status, a `client_since`
date are all facts about the relationship, and a recompute that only counts events SAOS
generated will confidently overwrite them with a wrong answer. If the pre-existing value
and the derived value disagree at scale, the derivation is missing an input, not the data.

## A backstop that hides a symptom disables the check for it
**What happened**: I added `body { overflow-x: clip }` to the ops app, commented as "the
backstop", to stop horizontal scrolling. `clip` removes the scrollbar without removing the
overflow — content past the viewport is cut off instead. Every 390px verification I ran
asked whether `scrollWidth > clientWidth`, which under `clip` is permanently false. So I
added the rule that defeated the check, then reported the check as evidence. Brian found
the overflow on a real iPhone. Two further gaps surfaced while proving it: I took a
measurement from a page that was 500ing with one CSS rule loaded and read "no offenders"
as a pass, and I had been treating a 390px Chromium viewport as a device.
**Rule**: never add a rule whose effect is to make a failure undetectable. Prefer the
symptom visible and the cause fixed. Before trusting any browser measurement, assert its
preconditions — the page rendered, the stylesheet loaded, the rule under test is present —
because "no problems found" from a broken page is indistinguishable from a pass. And a
viewport resize is not a device: say which engine was checked, and say what was not.

## A sabotage restore is verified by diff, never assumed from the copy succeeding (2026-08-16)

Backing up four files before a #44 sabotage used `$(basename $f)` for the backup name.
`apps/api/src/modules/tasks/service.ts` and `apps/api/src/modules/engagements/service.ts`
share a basename, so the second backup silently overwrote the first — and the restore
copied the ENGAGEMENTS service into the TASKS service file.

Caught only because a grep for the ladder clause came back empty. Nothing about the `cp`
failed; every command exited 0.

**Rule:** after restoring from a sabotage, prove it with `diff` or `git diff --stat` before
running anything. A restore that reports success is not evidence the right bytes landed.
When backing up more than one file, use paths as names, not basenames — or use
`git stash`/`git checkout`, which cannot collide.

Related: the sabotage itself was clean (four edits, four failing tests, no crashes). The
failure was in the scaffolding around it, which is exactly where it is easiest not to look.

## When a fix's own failure mode is the bug it fixes, pick a different fix (2026-08-16)

#48's design note said part two was "thread a transaction client through
`createEngagement` / `createInvoice` / `createTask` / `writeAudit`." Counting the call sites
first changed the answer: **792** `app.db.query` calls, most of them in helpers several
levels below acceptance.

The failure mode of a missed thread-through is that one statement runs outside the
transaction, commits alone, and survives the rollback — **a silent partial write, which is
exactly the bug #48 exists to remove.** A fix that fails the way the bug fails is not a fix;
it is the same defect wearing a plan.

AsyncLocalStorage inverts it: the transaction is ambient, so participation is the default
and the mechanism has no per-call-site step to forget. Zero of the 792 sites changed.

**Rule:** before choosing a mechanism, ask what happens when someone applies it
incompletely. If incomplete application reproduces the original bug silently, the mechanism
is wrong regardless of how obvious it looks. Prefer the design where the correct behaviour
is what you get by doing nothing.

Corollary, from the same piece of work: **a sabotage that HANGS is a finding, not a botched
sabotage.** Removing the re-entrancy check did not produce a wrong answer — it deadlocked
the suite, because a nested transaction blocks in Postgres on a row the outer holds while
the outer blocks in JavaScript awaiting the inner, and Postgres cannot see that cycle. I had
described re-entrancy as convenience. The comment now says what the sabotage proved.
Related: [[verify-a-sabotage-restore-by-diff]]

## A rollback assertion passes trivially when nothing was ever written (2026-08-17)

The production drill for #48's newly-wrapped paths asserted "the contact did not survive the
rollback", "nor the quote header", "nor its line item", "nor the packet" — **four PASSes on a
transaction that had died at its first statement.** The insert violated
`contacts_test_has_note`, so those rows never existed, and "they are gone" was true for the
wrong reason.

The only thing that caught it was a fifth check that happened to fail: the error message was
not the one the drill threw on purpose.

**Rule for any rollback/absence test:** assert the rows EXISTED first, inside the
transaction, then assert they are gone. An absence check with no matching presence check
proves nothing — it passes hardest when the setup is broken. And when a test throws
deliberately, assert on the message: a different error means a different code path ran.

Same family as the earlier miss where a post-commit test guarded on
`if (!depositInvoiceId) return` and passed by asserting nothing, and as the 390px overflow
measurement taken from a page that was 500ing. Related: [[reject-a-mechanism-whose-incomplete-application-recreates-the-bug]]

## A guard that checks the shape of a bug misses the rule behind it (2026-08-17)

`check-role-guarded-tasks.mjs` was written after finding #17, where a task and its alert
both sat inside `if (rene)` for a role nobody held. The guard fails the build when
`createTask` appears inside an `if (x)` whose `x` came from `firstActiveByRole`.

It has passed cleanly ever since — and the same defect was sitting in the tax pipeline the
whole time. `recordEfileResult` calls `createTask` UNCONDITIONALLY, so the guard was happy,
but the owner came from `firstActiveByRole('tax_preparer')` — the resolver with no CEO
fallback — for a role nobody holds. The task was created unassigned and the alert, gated on
`if (owner)`, never fired. A statutory perfection clock started and nobody was told.

The guard encoded the SHAPE #17 happened to take (a wrapping `if`) rather than the RULE it
taught (resolve owners with the resolver that falls back). ~20 more call sites have the
same shape.

**Rule:** when writing a guard after a bug, write down the rule in one sentence first, then
check whether the guard tests that sentence or the incident. "createTask is not inside an
if" is an incident. "A task's owner is resolved with a resolver that falls back" is the rule.
If the guard cannot fail on a fresh instance of the rule being broken, it is a regression
test wearing a guard's clothes.

Related: [[an-absence-assertion-needs-a-matching-presence-assertion]] — same family, a check
that cannot fail.

## A codemod must refuse what it cannot see (2026-08-17)

Sweeping 23 call sites for the owner-resolution rule, I wrote a script to hoist
`createTask` out of `if (owner)` blocks. It introduced two bugs, and the shapes are worth
keeping apart because only one of them is about code:

1. **Scope.** It moved a statement that referenced a `const` declared INSIDE the block it was
   moved out of. Brace matching cannot see scope, so the hoisted call referenced a variable
   that no longer existed at that point. Fixed by making the script collect every declaration
   inside the block, check whether the statement mentions any of them, and **throw with the
   offending name** rather than proceed. One site then had to be done by hand.

2. **Intent.** In `events/service.ts` the condition was `if (jackson && unlinked > 0)` — an
   owner gate AND a business condition, indistinguishable to a regex. The script dropped both,
   so an event nobody attended would have produced a follow-up task reading "0 attendees".
   No amount of parsing fixes this one: the script cannot know which conjunct is the rule and
   which is the reason.

**Rule:** a codemod may only perform transformations whose preconditions it can verify. Where
it cannot, it must fail loudly on that site and leave it for a human — a script that edits 12
files and is right about 10 is worse than one that edits 10 and names the other 2, because
nobody re-reads the 10.

Corollary, and this is the tell: **I caught both only by reading the diff.** The typecheck
passed on the second one and the guard went green on both. Run the sweep, then read every
line of it.

## $' in a replacement string means "everything after the match" (2026-08-17)

A generator script rewriting the role guard produced a file that ended mid-statement, with the
rest of a function simply gone. The cause: `s.replace(old, next)` where `next` contained
`\\s*$'` — and in a **replacement string** `$'` is a special pattern meaning "the portion of
the input after the match". So are `$&`, `$\``, and `$1`, had they appeared.

The regex was correct. The string containing it was destroyed by the substitution mechanism.

**Rule:** when replacing with text not authored character-by-character for that call — anything
containing regex source, currency, or a `$` at all — pass a **replacer function**:
`s.replace(old, () => next)`. A function's return value is used literally, with no pattern
expansion. Cheap, total, and it removes a whole class of silent corruption.

Caught only because `node` refused to parse the result. It would have been far worse in a data
file, where nothing checks syntax. Related: [[a-codemod-must-refuse-what-it-cannot-verify]] —
same session, same shape: the tooling was confidently wrong and an external check noticed.

## Routing through the front door is how you find out what the side door skipped (2026-08-17)

Eight `INSERT INTO tasks` statements bypassed `createTask()`. The obvious cost was the one
Brian named: no owner rule. Converting them surfaced two more that nobody had counted.

**All eight task types were missing from the SOP registry.** `check-task-sop-hooks.mjs` reads
task types emitted through `createTask()`, so it had never seen them — eight unmade decisions,
invisible for exactly as long as the side door existed. The guard was not broken; it was
looking at a door nothing came through.

**And converting them broke two tests, correctly.** `meetings/pipeline` used the meeting id as
`source_id` for every action item, which was harmless only because a raw insert does not dedupe.
`createTask()` does — so through the front door, a meeting producing five commitments would
have recorded one. The bug was latent in the raw version and became live on conversion.

**Rule:** when a code path bypasses a shared entry point, do not enumerate what the entry point
does and check those things individually. Route the path through it and let the failures tell
you. The checks you would have listed are the ones you already knew about; the ones that matter
are the ones the wrapper does that you had forgotten it does.

Corollary: a build guard that reads "everything emitted through X" is silently scoped to
callers of X. That is not a bug in the guard, but it means **adding a bypass shrinks every
guard downstream of it at once** — which is the real argument for one door, over and above
tidiness. Related: [[the-role-guard-tested-17s-shape-not-17s-rule]]
