# Next overnight — plan only (2026-09-09). Nothing here is built.

## The gap this closes
Every walk failure this week was a rendering failure the suite could not see: "ended
2026-08-16T00:00:00.000Z", "Due 2026-09-30" on the pay page, "started Sep 9 · ended Sep 8",
void metadata colliding with "sent <date>" at 390px. The API suite (609 tests) proves what the
server says; the static guards (check:date-rendering, check:css-classes, check:flash-once) read
the source; the browser walk is a person. The missing layer is the RENDERED page, asserted by a
machine, on a phone-sized viewport, before deploy.

## What gets built
A Playwright harness, `apps/e2e`, that boots the real API against a fresh test database (the
same `createTestConfig` the specs use), the real Ops app and the real portal, and walks ONE
page per run with assertions on what a person would read.

**Runs from the root suite** (`npm test` → `npm run test:e2e` after the workspace tests), red
blocks deploy like everything else. Local only at first — the box has no browser and none is
added; the harness runs on the laptop where deploy.sh runs.

**Fixtures come from the routes, never SQL.** A helper seeds a synthetic client through
createQuote → sendQuote → acceptQuote → the stub Stripe adapter marking the deposit paid → a
void through the void route → a refund through the webhook — so the rendered page shows every
state the walk has ever failed on: sent, paid, void, refunded, partially refunded, disputed.

**The staff login is minted the way the specs do it** (makeStaff with a known TOTP secret; the
harness generates the code) — no staff account is created anywhere real.

## The first page: Ops → client page, at 390 × 844 and 1280 × 800
Assertions, each one a walk failure that happened:
1. No text on the page matches `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}` (the ISO-T leak).
2. No text starts with ⚠ (an instant handed to formatDate).
3. Every date pair reads in order: for each engagement row, "started" ≤ "ended" as dates.
4. `document.documentElement.scrollWidth === 390` at the phone size — nothing overflows.
5. The void invoice row shows the badge, then reason · actor · date, then "sent <date>",
   each on its own line at 390px and on one line at 1280px; the actor is a name with no "@".
6. The send log opens and every row wraps (no `li` wider than the viewport).
7. The Withdraw control on an engagement that holds a paid deposit shows the server's
   refusal and the transfer/refund choice (item 7a) — asserted through the dialog text.
8. A screenshot per viewport is saved to the run artifacts, so the morning report can attach
   what the machine saw instead of what I say it saw.

## The second and third pages (after the first is green three nights running)
- Portal → Invoices as the client, EN and ES: void reads Cancelled / Anulada, sorts last, has
  no Pay button; the pay page shows "Due <formatted date>", never a raw date.
- Portal → Proposal: the tax year line, the deposit line, the acceptance flow.

## What it costs
- Playwright + Chromium on the laptop (~300 MB), one new workspace, ~2 minutes per run.
- Nothing on the box. No new vendor. No client data — synthetic fixtures only.

## Decisions for Brian before it is built
1. Root suite or separate command? (Plan: root suite, so red blocks deploy. A 2-minute cost.)
2. Keep screenshots in the repo (small PNGs under tasks/walks/<date>/) or only in the
   scratchpad? (Plan: repo, so the morning report links to them.)
3. Which page is first? (Plan: the Ops client page — every walk failure so far was there.)
