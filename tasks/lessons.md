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

## Sabotage one claim at a time, or the later assertions go unproven (2026-08-17)

Retiring the PLLC checklist column made two claims: the checklist now READS from the task, and
the old WRITE path is refused. I sabotaged both at once and the run reported one failure —
"the six conversion steps, composed from the task" — which looked like a pass for the sabotage.

It was not. The read assertion sits ABOVE the write assertion in the same test, so breaking the
read aborted the test before the write assertion ever ran. The second sabotage was never
exercised. Had the write refusal been broken in the real code, that run would have looked
identical.

**Rule:** one sabotage per run when the claims live in the same test. Two sabotages in one test
prove the FIRST assertion that fails and say nothing about anything after it — and "the right
test failed" is exactly the signal that makes you stop looking.

Re-run with only the write refusal broken, it failed on
`/lives on the task now/` — which is the proof the combined run could not give.

Related: [[an-absence-assertion-needs-a-matching-presence-assertion]] and
[[a-codemod-must-refuse-what-it-cannot-verify]] — the same family. A check that reports what
you expected to see is not the same as a check that verified it.

## A truncating parser reports missing content, which looks exactly like the thing it hunts (2026-08-17)

`check-sop-task-alignment.mjs` compares an SOP's `### N. <step>` sections against the task
checklist they explain. Its first run reported four of six sections missing — which is precisely
the drift it was written to catch, so the output was completely believable.

The sections were there. The parser took the next backtick as the end of the SOP body, and the
SOP cross-references another SOP slug in code ticks, so it had read a third of the file.

Two things worth keeping:

1. **A parser bug in a guard is indistinguishable from a real finding**, because both say "the
   thing you are looking for is not there". Before believing a new guard's first failure, check
   that it can SEE what it is checking — print the count it parsed, not just the mismatches.
2. **Fix the parser, not the input.** The obvious escape was to drop the code ticks from the SOP
   so the parse succeeded. That would have left a guard that silently under-reads any body
   containing an escape, and a cross-reference removed for the tool's convenience.

The guard now prints how many steps it compared (`1 pairing(s), 6 steps`) so an under-read shows
up as a suspiciously small number rather than a clean pass. Related:
[[an-absence-assertion-needs-a-matching-presence-assertion]] — the same failure mode, one level
up: absence is only evidence if you know the thing could have been found.

## A seeder that never overwrites means a text fix needs a migration (2026-08-17)

Brian ruled that a rule's REASON must live in the SOP text — "so the rule survives the person
who knew why". I edited the seed. That would have been the whole job, except the SOP seeder is
`ON CONFLICT (slug) DO NOTHING`, deliberately, so that Brian's edits always beat a re-seed.

Which means an edited seed reaches only databases that do not exist yet. Production would have
kept the text that shipped an hour earlier, and a reason that reaches only fresh databases
survives nothing.

**Rule:** when changing seed content for a table whose seeder is insert-only, ask what happens
to the rows that already exist. If the answer is "nothing", the change needs a migration to
land, and that migration needs a predicate that respects whatever the DO NOTHING was protecting.
Here that predicate is `version = 1`: editing a published SOP bumps the version, so version 1
means nobody has touched it and updating cannot overwrite anyone's work.

Two details worth copying:

· **The migration reports which branch it took.** A migration whose only job is to change text
  can no-op perfectly silently. It now warns whether it applied, was left alone because the page
  was hand-edited, or found nothing to update.
· **Its `down` is empty on purpose.** The old text hedged a tax rule and omitted telling a
  client. Restoring that on rollback would put a worse procedure in front of the person doing the
  work. Rolling back a schema should not roll back the firm's rules.

Related: [[retire-dont-edit]] — the same family of question. What already exists is the part a
content change forgets.

## A drill that reports zero is not the same as a drill that ran (2026-08-17)

The production drill for Laura's annual-report task called `runEntityComplianceJob` and reported
`the job reminded staff (0)` — which reads as a real finding: the job did not create the task.

It had not run at all. The job is date-guarded on `audit_log` per calendar date, the daily runner
had already used today, so it returned `{ skipped: true, staffReminders: 0 }` immediately. The
drill was measuring a job that declined to execute.

Worse, in the same run: `ok(observed.task?.assigned_staff_id !== null, 'assigned to a real
person')` **PASSED**, because `observed.task` was `undefined`, and `undefined !== null` is true.
A check reported success on a task that did not exist.

**Two rules, both about the same mistake:**

1. **When exercising a guarded or idempotent job, assert it ACTUALLY RAN** — `skipped === false` —
   before believing any count it returns. A date-guarded job is designed to no-op, so "it did
   nothing" is its normal behaviour and cannot be read as evidence about anything else.
2. **Never assert `!== null` on an optional-chained field.** `x?.y !== null` is true whenever
   `x` is missing. Assert the type and the shape: `typeof x?.y === 'string' && x.y.length > 0`.

Related: [[an-absence-assertion-needs-a-matching-presence-assertion]] and
[[sabotage-one-claim-at-a-time-within-a-test]] — the third time this session that a check reported
what I expected rather than what it verified. The pattern is always the same: the assertion was
technically true about something other than the thing being tested.

## A stop-point only works if the person spots the condition (2026-08-17)

I drafted four stop-points for Laura's SOPs as "if X, stop and bring it to Brian". Two of them —
a state whose annual-report rule we have not researched, and a stored due date disagreeing with
the derivation — depend on her NOTICING X while working a task that otherwise looks routine.

Both are conditions the system already has everything it needs to detect. So it detects them:
those tasks arrive titled **NEEDS A RULING**, assigned to Brian, with both dates or the state
named in the description. The SOP still explains the reasoning, because she needs to understand
what she is being handed — but she is not the detector.

**Rule:** when writing a procedure step that begins "if you notice…", ask whether the system can
notice instead. A stop-point the system enforces is a control; one the reader must remember is a
hope. Keep the prose either way — the person still needs to know WHY it stopped — but move the
detection.

The tell that this one mattered: the two conditions are invisible by construction. Illinois is
derived from the researched rule and every other state from a plain fallback, and **both come
out looking like a confident date**; a legitimate admin override and a typo are likewise
indistinguishable in the row. Asking someone to spot a difference the data does not express is
asking them to fail.

Related: [[the-role-guard-tested-17s-shape-not-17s-rule]] — same family. Encode the rule in the
mechanism, not in whoever reads it next.

## Production verification means looking at production's DATA, not just its schema (2026-08-17)

Florida shipped: statute cites read from the primary source, the uniform-deadline shape encoded,
mid-year derivation tested, migration verified byte-identical, deployed. Every check I had
defined passed. Then I looked at the actual book:

    IL 603 | FL 8 | CO 3 | AR 1 | AZ 1 | IN 1 | TX 1 | WI 1
    entity_compliance: 0 rows

Two things fell out that no amount of re-reading the diff would have surfaced.

**First, the Florida work had no formation dates to work with.** Not one of the eight Florida
businesses has a formation date recorded anywhere. Under the code as shipped, enrolling any of
them produced a compliance row with a NULL due date — and a null due date is *invisible, not
pending*: the status sweep filters `WHERE annual_report_due_date IS NOT NULL`, and both reminder
loops load by exact due date. The row sits in the compliance list looking tracked, with a blank
date, and no reminder is ever coming.

**Second, the fix was already sitting in the shape.** Florida is uniform-deadline — 1 May is
1 May — so it needs no formation date at all. Illinois genuinely does, because there the
formation date *is* the deadline. Modelling the rule as a shape rather than a date is what made
that distinction expressible: `candidate` returns null when a rule needs a formation date it
hasn't got, and a real date when it doesn't need one. The T-60 cross-check had the same bug from
the other side — it hard-coded `derived = null` whenever the formation date was missing, throwing
away a check Florida could always have made. A FL row storing 2027-03-15 would have gone to Laura
as routine work with a wrong date on it.

**Rule:** after deploying, query the production data the feature reads. Not "did the migration
apply" — *what is actually in the columns the code depends on*. A feature can be correct,
tested, deployed, and inert, and the schema will not tell you.

Corollary, and the reason this belongs with the others: the null due date is the same failure
family as the role that did not exist and the NOT NULL notification — **absence with no record of
absence**. So the missing date is now work: enrolment with no derivable date creates a "Find the
formation date" task through `createTask`, under its own `annual_report_setup` source type,
because sharing `annual_report` would have made this task swallow the real filing task later via
the (source_type, source_id) dedupe.

Related: [[a-stop-point-only-works-if-the-person-spots-the-condition]] and
[[an-absence-assertion-needs-a-matching-presence-assertion]].

## A compliance guard firing on a comment is the guard working (2026-08-17)

`check-no-hardcoded-prices` failed the build on a code comment explaining *why* a Florida
deadline is not negotiable — the comment contained Florida's late-fee figure as a dollar
literal. The tempting fix is an exemption for comments.

Don't. The rule is "a price appearing as a literal in application code is a build failure", and
carving a comments exception into a compliance guard to keep one sentence is trading a control
for a nicety. The figure was spelled out in words instead, with a pointer to the SOP that carries
the exact quote and the Sunbiz cite. The reasoning survived; the guard stayed absolute.

**Rule:** when a hard-rule guard fires on something that feels like a false positive, change the
code, not the guard — unless the guard is testing the wrong rule, which is a different repair.

## "What's the enrolment path?" is a question to answer by reading every writer (2026-08-17)

Brian asked whether `entity_compliance` fills from the Trello import or from a backfill. The
tempting answer is the plausible one — it sounds like it should ride the import, the import
exists, businesses came from it.

Reading every writer gave a different answer: **there is no enrolment path.** One API route, no
UI in front of it, neither importer touches the table, no seeder, no backfill. The module has an
open door nobody can reach.

Two things made the answer useful rather than just correct, and both came from looking one layer
past the question:

- **`businesses` has no `formation_date` column at all.** So "just write a backfill" is not
  available for Illinois — 603 of 619 — because in Illinois the formation date IS the deadline.
  Florida's 8 could be enrolled today; that difference is the uniform-vs-anniversary shape again.
- **329 of 619 businesses have no `entity_type`.** Enrolling everything would manufacture annual
  report obligations for sole proprietors. Who is in scope is a business question, not a
  technical one.

**Rule:** when asked how data gets somewhere, grep every writer of that table and say which ones
exist — then check whether the obvious fix is even possible with the columns that exist. "There
is no path" is a complete answer; "there is no path, and here is what the path would need"
is a useful one. Do not offer to build it in the same breath — say what it would cost and let
Brian sequence it.

Related: [[production-verification-means-looking-at-productions-data]]. Same failure family,
one level up: that one was a feature that ran on nothing, this is a module fed by nothing.

## A rule with a numeric trigger cannot cite a frozen number (2026-08-17)

Brian's standing rule: research a state's annual-report rule when its entity count crosses ~5, or
when the escalations annoy him. He asked that each escalated task be "itself the business case",
so the task now names the state's entity count and the threshold.

The count is **queried at run time**. Writing `CO: 3` as a literal would have been simpler, would
have read identically in review, and would have kept saying "3 entities, below threshold" for as
long as the comment survived — while the book grew past five with nothing reporting that the
trigger had fired. The rule would have gone stale silently, which is the exact failure the rule
was written to avoid.

**Rule:** if a rule's trigger is a number about the world, the code that reports on that rule
must measure the world. A constant that duplicates a measurable fact is a second source of truth
with no update path. The test asserts the count *changes with the data* (five inserted rows flip
the verdict), not merely that a number appears.

## Two spellings of one gap is a divergence nothing reports (2026-08-17)

`enrichment_queue.missing_fields` carried `business:entity_type` (304 open rows, written by the
July import) and `entity_type` (1 row, written by `computeEnrichmentGaps` whenever a contact
happened to be edited). Same column, same meaning, two vocabularies, and the split grew slowly
with edits rather than appearing at once.

Nothing crashed, and nothing would have. A filter on either name simply returns part of the book
and reports a confident count — and the first filter anyone wrote was the entity-type
classification pass, whose entire job is counting exactly that.

**Rule:** when two code paths write the same column, check that they write the same *values*, not
just the same type. An enum-like text column with no CHECK constraint accepts both spellings
forever. The fix picked the more informative form (`business:` says the gap is about a business,
not the person) and migrated the strays; a CHECK would have caught it on day one.

Related: [[a-rule-with-a-numeric-trigger-cannot-cite-a-frozen-number]] — both are one fact with
two representations drifting apart.

## The sabotage passed, so the TEST was wrong (2026-08-17)

Sabotaging the classify pass's `ORDER BY` down to plain `b.name` did not fail the ordering test.
The fixtures were named "Synthetic Enrollable FL LLC" and "Synthetic Lead FL LLC", and alphabetical
order already put them in the asserted order. The test agreed with the bug.

Renaming them to "Synthetic **Zulu** Enrollable" and "Synthetic **Alpha** Lead" makes alphabetical
order FIGHT the assertion, so only the scope-first ordering can satisfy it. Same sabotage now
fails it.

**Rule:** a sabotage that passes is a finding about the test, never a licence to move on. And when
a test asserts an ORDER, choose fixture values whose natural order is the opposite of the one
being asserted — otherwise the test cannot distinguish the rule from the default.

This is the fourth time this session that a check reported what I expected rather than what it
verified, and the first one caught by the sabotage step itself rather than by luck. That is the
step earning its keep.

Related: [[an-absence-assertion-needs-a-matching-presence-assertion]].

## The spec's enumeration is a boundary, not a starting point (2026-08-17)

I built the classify pass as an eighth entry in the Reports & KPIs registry. Three tests failed on
"seven reports per the spec", and the instinct was to invert them — the count changed, so update
the count.

Wrong instinct. v4.6 line 624 enumerates the module as seven named owner-facing analytics, and an
operational worklist is not one of them. The tests were not stale; they were doing their job. The
pass moved to `GET /entity-compliance/unclassified`, beside the enrolment it unblocks and behind
the same `entity.manage` permission — a better home on every axis, arrived at by being told no.

**Rule:** before inverting a test that cites the spec, go read that line of the spec. A stale
premise and a correct boundary look identical from the failure message. "The spec wins" is in
CLAUDE.md precisely for the moment when following it is inconvenient.

## The scraper was blocked, not broken — and I will not route around it (2026-08-18)

(2) was "extend the ILSOS parse to pull formation dates." Before writing a line of parsing I tried
to fetch the page. It never arrived.

  from a residential IP ... HTTP 403, the Secretary of State's own block page, naming a
                            Reference ID and Client IP and saying to email webmaster@ilsos.gov
  from the Hetzner box .... nothing. TCP connects, HTTP hangs.
  efile.sunbiz.org ........ flat 403 to the same box

That is a WAF with a posture toward datacentre egress, not an outage and not a parsing problem.
No amount of better selectors fixes it.

**The line I did not cross:** rotating user-agents, proxying through residential IPs, or otherwise
defeating the block. That is bot-detection evasion against a state agency, and a CPA firm doing it
to its own Secretary of State is a compliance exposure, not a clever workaround. The block page
names the legitimate route — ask to be allowlisted.

**Rule:** when an integration with an external site fails, establish WHETHER IT IS A BLOCK before
treating it as a bug. And if it is a block, the fix is a conversation with the operator, never a
disguise. Write the finding into the code as a comment at the call site, because the next person
to read `liveChecker()` will otherwise assume it works.

What it exposed, which is the larger point: `SOS_MODE=live` has been set in production the whole
time, and there are ZERO `sos.checked` audit rows and 0 of 619 businesses with
`il_sos_checked_at`. A monitor that has never once monitored, failing into a `catch` that logs a
warning nobody reads.

Related: [[production-verification-means-looking-at-productions-data]].

## "checked: 0" meant three different things (2026-08-18)

`runSosRecheckJob` returned `{ skipped: false, checked: 0 }` for: nobody was due, everybody was
due and every lookup failed, and the candidate query matched nothing because its filter was wrong.
Production was in the third — the filter said `soto_status = 'active'` and no business in this
book has an active primary contact — and the run record looked identical to a clean day.

The fix is not a better name. It is reporting the DENOMINATOR: `candidates` (what the filter
found), `checked`, `failed`. A filter matching nothing is now visible as `candidates: 0`, which is
the only number that could ever have exposed it.

**Rule:** a job that reports only its successes cannot distinguish "nothing to do" from "I did
nothing". Always record what the job's own selection returned, not just what it accomplished — and
log the difference, because zero-of-zero and zero-of-fifty are different incidents.

Related: [[an-absence-assertion-needs-a-matching-presence-assertion]] — same shape, in a job
instead of a test.

## Provenance is a constraint, not a column (2026-08-18)

`businesses.formation_date` derives a statutory deadline: in Illinois the formation date IS the
annual-report due date. A date somebody half-remembered on a call and a date read off the state's
register produce identical rows and identical-looking deadlines.

So the date cannot be stored alone. `formation_date`, `formation_date_source` and
`formation_date_recorded_at` are all-or-nothing at the DATABASE level, and the source vocabulary is
CHECK-constrained to four values — a route that forgets is refused, not trusted. Same shape as
`entity_compliance_override_is_complete`.

Two judgement calls worth keeping:

- **`client_stated` is allowed.** Banning the weakest source produces no better data — it leaves
  the column null and the entity untracked. A tracked entity with a date labelled unverified beats
  an untracked one.
- **Enrolment writes `staff_verified`, never `sos_register`.** A date typed into a form did not
  come from the register, and labelling it so would be a lie that later reads as evidence. The
  sabotage that changes that one string fails a test by name.

**Rule:** when a field's trustworthiness varies by where it came from, the origin is part of the
value. Store them together or the field is unreadable six months later — and enforce it in the
schema, because the code path that skips it will be the one written in a hurry.

## A pipe swallowed the exit code, so "exit 0" meant grep succeeded (2026-08-22)

I ran the suite as `npm test 2>&1 | grep -E "..."` in the background. The task notification said
**exit code 0**, and the grep output showed four green guard lines. Both were true. The suite had
six failures.

`$?` after a pipeline is the LAST command's status. `grep` found matches, so it exited 0, and the
suite's own non-zero result was discarded at the pipe. The filter I chose also happened to put the
guard successes first, so the visible output read like a pass.

Two habits from this:

- **Never read a background run's exit code through a pipe.** Run the command unpiped and echo
  `$?` explicitly (`npm test 2>&1; echo "SUITE_EXIT=$?"`), then grep the captured FILE afterwards.
  The file keeps everything; the pipe throws away the one thing being asked for.
- **Grep for the failure marker, not just the success marker.** `grep -c "^✖ "` returning 0 is a
  real absence check; a screenful of ✓ is not.

The underlying cause was environmental — Docker Desktop had restarted mid-run (`Up 12 seconds`
when I looked), so the DB was unreachable. That is the second time this session Docker has taken
the suite down, and both times the failure looked like a code problem until I checked the
containers. **Check `docker ps` uptime before diagnosing a broad, fast-failing suite.**

Fifth instance this session of a check reporting something other than what it verified, and the
first where the faulty check was my own shell rather than the code's. Same rule as always: make
the check measure the thing.

Related: [[the-sabotage-passed-so-the-test-was-wrong]] and
[[checked-0-meant-three-different-things]].

## "We were refused" is not a fact about the client (2026-09-06)

The ILSOS scraper returned `not_found` on any failure — a 403, a timeout, a parse miss. But
`not_found` in `il_sos_state` does not mean "we could not look". It means **the Secretary of State
has no record of this company**, which is a serious finding about a client's entity, the kind that
starts a conversation with a bank.

For a month, every WAF refusal was one successful-looking parse away from writing that.

**Rule:** when an external source can refuse you, the refusal needs its own representation, and it
must never share one with a substantive finding. Ask of every status value: *is this about them,
or about us?* `meetings.status = 'failed'` is about us and is fine. `not_found` is about them.
Mixing the two is how a system states things it does not know.

The fix was not a new enum value. Once the fetch was gone there was nothing left that could be
refused — a person either reads the register or does not finish the task, and an unfinished task
is not a claim about anybody.

## Removing beats disabling, and a guard beats a comment (2026-09-06)

Brian: "not disabled, removed from every code path." The scraper that came out was not
reckless-looking code — it had a timeout, an adapter interface, a stub for tests, and a careful
comment about best-effort parsing. It looked like something a sensible person wrote, which is
exactly why it survived a month of never working.

A `SOS_MODE=stub` flag would have left that shape in the tree for the next person to find and
re-arm, and the comment explaining why not would have been three scrolls above the code.

So `scripts/check-no-sos-scraping.mjs` fails the build if any code fetches a Secretary-of-State
host, and it lists thirteen registry hosts rather than the one we tripped over — the next person's
state will not be Illinois.

**Rule:** when a capability is retired for a NON-technical reason (a licence, a term of use, a
regulator), delete it and encode the prohibition. A disabled feature is a decision someone can
reverse without knowing why it was made; a failing build hands them the reason.

## The rewrite is when you find what the old code was hiding (2026-09-06)

Rewriting the adverse-result path surfaced something unrelated to ILSOS: the `sos_fix_steps`
client email had **no `isAutomationEnabled()` gate and no row in the automations table**. By
CLAUDE.md's own words that is a build failure, and it had been sitting in the tree for weeks.

It reached nobody only because the lookup that triggers it never once succeeded. Two defects
cancelling out is not the same as no defect — remove one and the other ships.

**Rule:** when a feature has never actually run, treat everything downstream of it as unverified,
not as working. And note what is missing: there is no build guard for "client sends are gated",
which is why this one slipped past seven other guards. That is the next guard to write.

## Verify a negative with a second tool before reporting it (2026-09-06)

Three times today I nearly reported something as broken that was fine:

- `getent hosts portal.sotoaccounting.com` returned nothing on Git Bash for Windows, where getent
  does not do DNS. `Resolve-DnsName` showed all eight records present and correct. I was one
  sentence away from telling Brian his DNS was undone.
- Before that I probed eight hostnames I had **guessed** (`app`, `files`, `pay`) rather than read
  out of the Caddyfile. All eight "failed", and none of them existed to begin with.
- And the ILSOS "hang" was a Node `fetch` quirk, not the site — `curl` from the same box answered
  in 0.18s.

**Rule:** a negative result from a single probe is a hypothesis. Confirm it with a different tool,
or against the config that defines the thing, before it becomes a finding. Absence of evidence
from a tool that cannot produce evidence is not evidence of absence.

Related: [[a-pipe-swallowed-the-exit-code]] — same family, one layer out: the check was incapable
of reporting the thing I was reading it for.

## A rule with no guard is a convention, and conventions hold until someone's model differs (2026-09-06)

`sos_fix_steps` — a bilingual client email — shipped with no `isAutomationEnabled()` check and no
row in the automations table. CLAUDE.md calls that a build failure in as many words. Seven guards
ran on every commit and none looked for it.

The convention had held everywhere else, and the reason it broke here is worth keeping: the email
was written as part of a *lookup* feature, so it read as a consequence of the lookup rather than
as an automation in its own right. Nobody skipped a step they knew about. **A convention survives
until someone's mental model of the feature differs from the one the convention was written for**
— which is the whole argument for encoding it.

**Rule:** when CLAUDE.md says "X is a build failure", check that something actually fails the
build. If the enforcement is "we always remember", it is a convention wearing a rule's clothes.

## Prove a guard against the real defect, from git, not against a reconstruction (2026-09-06)

Brian asked for confirmation that the new guard would have caught the thing it was written for.
The weak version of that answer is "yes, because it looks for ungated sends". The version worth
giving checks out the pre-fix file — `git show 461b7a0:apps/api/src/modules/entity/sos.ts` — runs
the guard against it, and pastes what came out:

    modules/entity/sos.ts:runSosCheck   (line 176)

File, function, line. Then restore, verified by `cmp`.

**Rule:** a guard's proof is the original defect, retrieved from history. A hand-written imitation
of the bug proves the guard catches imitations — and it is exactly as easy to write one the guard
happens to catch as one it does not.

## Writing this guard took four wrong detectors, and each was silently wrong (2026-09-06)

The check itself was ten minutes. Making it say *where* the problem is took four attempts, and
every failure was quiet — the guard ran, exited, and reported confident nonsense:

1. **Backward brace-walk** → every route file reported `(top level)`. Seven real sites, no useful
   location.
2. **Regex string-blanking** → template literals cross-paired with quotes and swallowed real code.
   Replaced with a single left-to-right scanner.
3. **Name and `{` required on one line** → missed every multi-line signature, which in this
   codebase is every important function.
4. **`const NAME = (`** → matched `const text = (es ? a : b)` and attributed a broadcast SMS to a
   "function" called `text`. Tightened to require an actual arrow or `function`.
5. **Contiguous same-owner run** → a nested callback between the gate and the send broke the run,
   so `runDocumentChaseJob` was reported ungated when it checks its gate twenty-six lines above.

Not one of these announced itself. Each produced a plausible-looking report, and only reading the
named files showed the names were wrong.

**Rule:** a static-analysis guard needs its OWN verification pass — open the files it names and
confirm the finding is real, and open a few it passed and confirm they should have passed. A guard
is a program that makes claims about other programs; it deserves the same suspicion as any other
check that reports what you hoped to hear.

Related: [[the-sabotage-passed-so-the-test-was-wrong]].

## I matched on the warning label and reported the thing it warns about (2026-09-06)

I told Brian the headline blocker for client #1 was five engagement letters flagged PLACEHOLDER.
It was wrong, and he acted on it — he came back asking me to draft five schedules and send them to
his attorney.

The query I used was `body_en ILIKE '%PLACEHOLDER%'`. The gate reads `templates.is_placeholder`, a
column. The five templates I found contain the word because **their body IS the warning text** —
"⚠ PLACEHOLDER TEMPLATE — NOT FOR CLIENT USE." I searched for a string, found a sign saying "do
not use this", and reported that the thing was in use and blocking.

Worse, they were not even in the path: `templateKeyFor('engagement_letter')` returns
`'engagement_master'` and ignores its service-line argument. Five inactive, unreferenced rows from
a superseded design, and I made them the top of a launch-readiness report.

**Rule:** when a system has a FLAG for a condition, query the flag. Text that mentions the
condition is not the condition — it is usually documentation OF it, which means matching on text
finds the warnings rather than the problems. And before reporting something as blocking, follow
the path: what does the code actually load at the moment the block would happen?

The cost was not the wrong sentence. It was Brian preparing to spend his attorney's time
re-reviewing text his attorney had already reviewed, which is what a confidently wrong status
report buys.

## When the premise of a task is false, stopping IS the work (2026-09-06)

The instruction was concrete: draft five schedules, mark them DRAFT, package them for counsel.
Every schedule already existed — attorney-reviewed, live, assembling in production for every
service line, including the COO case Brian expected to have no source at all (Schedule D covers
advisory, coo, nonprofit_cfo and specialized_cpa).

Drafting them anyway would have been worse than useless. It would have put my invented text
beside reviewed text in one package, and the failure mode is somebody later pasting the wrong one
in — the same "two representations of one fact, drifting" defect already in this file twice.

**Rule:** verify the premise before executing a well-specified task, especially one you caused by
an earlier report. A clear instruction is not evidence that the thing it asks for is needed. And
when the premise is false, the deliverable is the proof — not a partial version of the work.

The proof had to be end-to-end: not "the column says false" but the real `previewPacket` running
in production, for all seven service lines, inside a rolled-back transaction.

## The suite had no timeout, so a dead database wedged it for four hours (2026-09-06)

Two background tasks ran 3h+ and never exited. Diagnosis, from process state rather than guessing:

  PID 16664  node --test-isolation=process --test-timeout=0 … test\document-scans.spec.ts
             State: LISTEN

`document-scans.spec.ts` starts a fake ClamAV TCP server in `before()`, then builds the app.
Docker Desktop died mid-run at 02:07; the listener was already up, the DB call after it threw,
and `after()` — which closes both — never ran. A listening socket keeps a Node process alive
forever, and **`--test-timeout=0`** meant nothing would ever kill it. The parent `node --test`
waited for the worker, `npm test` waited for the parent, and the log stopped mid-file at 15KB.

Fixed with `--test-timeout=300000 --test-force-exit`:

- the timeout makes a wedged test FAIL, loudly, with a name
- force-exit makes a leaked handle stop being an infinite wait

**Rule:** any test suite that opens sockets needs both a per-test timeout and a forced exit. A
hook that leaks a handle is not exotic — it is what every `before()` does when the thing after the
listener throws. Without them, an infrastructure blip becomes a process that outlives the session
that started it.

Related: [[a-pipe-swallowed-the-exit-code]] — same suite, adjacent lesson: it also could not tell
me it had failed.

## My own safety guard fired, and it was right to even though the condition was wrong (2026-09-06)

Migration 0079 deletes five superseded templates and refuses if any signature envelope references
them — "they are the terms somebody signed under". It refused immediately on a developer machine:
two rows.

Both were demo-seed **drafts**, `status = 'draft'`, never sent, never completed. Nobody signed
anything. The guard was too broad: it treated a queued document as an executed agreement.

The refusal was still the right behaviour. It stopped a destructive migration and made me go and
look at exactly two rows, which took a minute and produced a better rule — **refuse on executed
envelopes (past draft), repoint remaining drafts.** Had it been permissive I would have deleted
without ever knowing the rows existed.

**Rule:** write the destructive-migration guard tight enough to fire, and expect the first firing
to teach you the real condition. A guard that never fires has told you nothing about whether it
works. And when it fires, the question is "is the CONDITION right", not "how do I get past this".

## The codebase already knew, in a passing test (2026-09-06)

While inverting a stale assertion I read the three lines above it:

    assert.deepEqual(activePlaceholders.rows.map((r) => r.key), [],
      'no ACTIVE template is still a placeholder — that is the launch gate');
    // … every piece of client-facing legal copy is final and sendable.

That test had been passing continuously — including on the morning I told Brian five engagement
letters were flagged PLACEHOLDER and blocking client #1. A test in the repository was asserting
the exact opposite of my headline finding, in the file named `master-schedules.spec.ts`, and I
never opened it.

**Rule:** before reporting a system-level status, check whether a test already asserts something
about it. A green test is a claim the codebase is making continuously; contradicting one should
require explaining why the test is wrong. I had grepped the database and never asked what the
suite believed.

## I handed Brian a bash command and he runs PowerShell (2026-09-08)

The Stripe installer command I gave him was:

    ssh -i ~/.ssh/saos_hetzner_ed25519 "root@$(sed -n 's/^SERVER_IPV4=//p' .env.production)" -t '…'

He pasted it into PowerShell, which has no `sed` and does not do `$(…)` command substitution the
same way. The host resolved to an empty string and ssh reported **"connect to host port 22:
Connection refused"** — which reads exactly like the server being down. He could reasonably have
spent an hour on the server before suspecting the command.

The idiom came from this repo's own docs, and it was MINE: on 2026-08-22 I replaced a hard-coded
IP in `first-client-runbook.md` and `launch-readiness.md` with that bash form, in files whose only
reader runs PowerShell. I fixed one leak and introduced another.

**Rule:** a command handed to a person is written for THEIR shell, not the one I happen to be
thinking in. My environment notes say PowerShell is primary; the Bash tool being available to me
says nothing about what is on their clipboard. When a doc holds a command for a human, name the
shell in the fence — ```powershell — and set the variable once at the top rather than repeating a
substitution that has to be right in two languages.

Worth noticing the shape of the failure: the wrong command did not error as a bad command. It
produced a *plausible infrastructure symptom*. Shell mismatches degrade into lies about the
system.

## The `String.replace` dollar trap, for the second time in one project (2026-09-08)

Inserting a PowerShell snippet into a markdown file with

    text.replace(anchor, header + rest)

silently destroyed the file from the insertion point on. The snippet contains `'^SERVER_IPV4=(.+)$'`
— and in a replacement STRING, `$'` means "everything after the match". So the tail of the file was
substituted into the middle of my snippet and the real tail was dropped. 311 lines became a stump,
and nothing errored.

This is already in this file, from 2026-08-17, when the same trap ate the middle of a guard script.
I hit it again because the payload changed shape — last time a backtick, this time a dollar — and I
had filed the lesson under the payload rather than the mechanism.

**Rule:** never pass a computed string as the replacement argument. Always
`replace(anchor, () => text)`. A replacer function receives the text verbatim and has no special
sequences at all. There is no case where the string form is worth the risk, so make it
unconditional rather than something to remember when the content looks dangerous — the content
looked harmless both times.

## The installer refused Brian for a reason that was mine, not his (2026-09-08)

The live Stripe installer stopped at check 2:

    FAIL  charges_enabled is NOT true — Stripe has the key but this account cannot take a payment
          usually onboarding or verification is incomplete; check the Stripe dashboard home page

It called `GET /v1/accounts` — PLURAL — which is the Connect endpoint that LISTS connected
accounts. For an ordinary account that returns `{"object":"list","data":[]}`: no
`charges_enabled` field anywhere in it. The grep for `"charges_enabled": true` then failed for
every Stripe account in existence, and the message sent Brian to go and fix onboarding that may
be perfectly complete. `GET /v1/account` — singular — is the one that returns his own account.

Two things went wrong and the second is the one worth keeping:

1. The wrong endpoint. Verified afterwards against the test key: plural returns the empty list,
   singular returns the account with the field present. The Node verifier was already right —
   `stripe.accounts.retrieve()` with no id calls the singular URL — so only the bash pre-check
   was broken.
2. **The check could not tell "false" from "absent".** `grep -q '"charges_enabled": true'`
   fails identically when the field says false and when the field is not there. So a broken
   script and a broken account produced the same FAIL with the same advice. The fix is a
   three-way check: field missing → "this is a SCRIPT or API problem, not your account"; field
   false → "this is a real answer from Stripe about your live account"; field true → pass.

The guard-before-write design did its job: nothing was written, the key never reached disk, and
the worst outcome was a wrong sentence. But "the script fails closed" is not the same as "the
script tells the truth about why".

**Rule:** any check that greps for `"field": value` must first assert the field EXISTS in the
response, and give the two failures different messages. Absence is a fact about the request;
false is a fact about the thing. Same lesson as the audit rows, the SOS `not_found`, and the
`checked: 0` job record — a failure representation that means two things means neither.

## Deploy ships HEAD, not the working tree (2026-09-08)

Fixed the installer, ran `bash scripts/deploy.sh`, grepped the box: the old script was still
there. `deploy.sh` ships with `git archive HEAD` — tracked, COMMITTED files. An uncommitted edit
does not deploy, and the deploy reports success because it did exactly what it does.

Every previous deploy this month happened to follow a commit, so the dependency was never
exercised and I had it wrong in my head as "ships the working tree".

**Rule:** commit before deploy, always — and after any deploy, verify the change on the box by
grepping for the changed line, not by reading the deploy's exit code. The deploy succeeding tells
you the shipping worked; only the box tells you what was shipped.

## An error that tells you to do something the screen cannot do is a dead end, not a message (2026-09-09)

Brian, trying to send a rehearsal quote, got:

    This client already has an active Schedule A … Send again with intent "additional_work" …
    or "replaces_existing" … The answer is recorded on the quote.

The guard behind it is RIGHT — the client had a signed Schedule A from 13 August, and a second
individual-tax quote genuinely needs the sender to say whether it adds work or replaces the
agreement. The API message is right FOR AN API CALLER: it names the parameter. But the pipeline
builder had no control for that parameter. The instruction was addressed to someone who was not in
the room.

He tried three times in two minutes. Each attempt CREATED the quote before the send was refused,
and the builder only remembered the draft on the save path — so all three drafts were orphaned in
the pipeline with the builder showing an empty composer and a red sentence. From his side: a
workflow that errors on step two, unhelpfully, three times. From the code's side: a correct guard,
a message written for the wrong reader, and a state variable set on one branch of two.

Fixed in the UI only; the API needed nothing. `api()` already attached the error CODE to the
thrown Error, so the builder now catches `schedule_already_covered` specifically, keeps the
refused quote as the draft, and renders the two answers as two buttons — plus "not now, keep it as
a draft". The first sentence of the API message (which names the schedule) is kept; the sentence
that gave an impossible instruction is replaced by the controls that make it possible.

**Rules:**

- **A refusal that has correct next actions must render them.** If the API asks a question, the
  UI shows the choices, not the transcript of the question. Grep every `setError((err as
  Error).message)` and ask: does this message ever contain an instruction? If so, which control
  carries it out?
- **Anything created before a failure is state the failure handler must keep.** `createdId`
  hoisted above the `try` is one line; three orphaned drafts is what its absence costs.
- **A guard's own test passing tells you nothing about whether a human can pass the guard.**
  "declaring the intent lets it through, and the answer is RECORDED" was green throughout. It
  tested the API. Nobody had tried the button, because there was no button.

Brian's reaction — "this doesn't give me confidence in the workflow" — was the correct one, and
the finding is that the workflow was fine and the *conversation* with it was broken.

## 2026-09-09 — Walk the flow you sent him into, not the diff you made

Brian, building the first real quote: the deposit dropdown offered only "— no deposit —" over a
quote carrying a real deposit. "Are you reviewing your work? Can you be more thorough when
you're building and testing." Second instruction-the-screen-can't-follow in one night (the
coverage 409 was the first).

**What happened.** Price book v4 (2026-08-14) retired the one-deposit-item model for per-line
`deposit_cents`; the server (`summedLineDeposits`) followed, the builder did not — it kept a
`<select>` over `service_line === 'deposit'`, empty forever after. Every test passed the whole
time, because no test looked at what the builder *offered*; they looked at what the server
*resolved*. Nine weeks nobody built a quote, so nobody saw it.

**Then, fixing it, the same mistake almost again.** I fixed the builder, wrote the test, ran the
suite, and was about to deploy. Instead I logged into the local builder as a synthetic staffer
and clicked through exactly what Brian would do: pick lines, pick a client, send, open the
client link. The builder said $550. The API said 55000. The client's proposal said **nothing** —
"Nothing is charged until you accept", accept, and only *then* "your deposit invoice is on its
way." My own new builder copy ("exactly as the client will see it on the proposal") was false
until I fixed the portal too. A code review of the diff would never have found that; the diff
was correct. Only the walk found it.

**The rule.** When a fix responds to "this screen didn't work," verification is *walking the
screen* — as the user, in a browser, on a build, through to the next screen and the one after
that. Typecheck, tests, and sabotage prove the code; they do not prove the workflow. Both are
required; the second one is the one I skip when tired. A model retirement (v4 here) is a
standing trigger to grep the UIs for the retired concept, not just the server.

**Also:** `check:prices` caught dollar figures in my own comments — the guard does its job even
on prose. Keep comments free of literal amounts; say "a real deposit," not the number.

## 2026-09-09 — The latency of a promise is part of the promise

Brian accepted the rehearsal quote and read "Your deposit invoice is on its way by email."
Three minutes later: "nothing triggered after this. again another roadblock?" It was not
broken. The outbox drain ran only inside the 15-minute scheduler tick; my deploy had
restarted the API at 02:29:51, so the tick fired at 02:44:51, and he accepted at 02:45:02 —
eleven seconds after it. The email was fifteen minutes away. From where he sat, nothing had
happened, and the screen had told him something would.

**Two rules, and the second is the one I would have missed:**

1. *Copy that promises timing must be backed by a mechanism that meets it.* "On its way" over
   a 15-minute interval is a lie one time in fifteen. The fix is a rule, not a nudge for this
   caller: the outbox gets a 60-second fast lane (same pattern as the push sweep), so every
   effect anyone enqueues — now or in a module that does not exist yet — leaves within a
   minute. The constant is frozen by a test; the copy now says "within a few minutes" and
   means it.

2. *A deploy resets every interval's phase.* Four deploys tonight moved the tick four times.
   Anything scheduled on a long interval is, right after a deploy, at a random point in that
   interval — and the person testing right after a deploy is exactly the person who hits the
   worst case. Short intervals for anything a client waits on; long intervals only for work
   nobody is watching.

**Diagnostic order that worked:** before saying anything — the row (pending, 0 attempts, due
now), the drainer (who calls it, on what interval), the env (`JOBS_ENABLED` defaults true;
health_refresh at boot proves the scheduler is alive), history (a deposit invoice was sent
and paid on 08-13, so SMTP and the path work). Then the answer was arithmetic. The wrong move
would have been to say "it will arrive in 15 minutes" and stop: true, and still a defect.
