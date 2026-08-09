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
