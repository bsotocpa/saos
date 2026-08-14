# Price book v4 — deposits separated from service pricing

Brian's brief, 2026-08-14: *"the current sheet conflates deposits with service pricing,
which is why the 13 confirmations have stalled."* Ships as an effective-dated **v4** with
migration. He does all pricing confirmations in one sitting **on his phone — 390px
matters here more than anywhere.**

---

## What the current schema actually does (read from production, v3)

| fact | detail |
|---|---|
| Deposits are **their own price-book items** | `DEPOSIT_1040` $250, `DEPOSIT_BUSINESS_TAX` $300, both `service_line = 'deposit'` |
| A quote picks **one** deposit | `quotes.deposit_item_code` — a single FK-ish text code. Multi-line quotes cannot compose a deposit |
| Flat vs range is **implicit** | `minUnit = amount_cents ?? price_min_cents ?? 0`. Nothing declares intent; it is inferred from which column is populated |
| `unit` already exists and is a **different axis** | `price_unit` = the billing unit: `flat`, `per_hour`, `per_month`, `per_form`, `per_state`, `per_k1`, … 15 values in live use |
| Only **one** line carries a stored range | `IND_CPA_LETTER` $250–$500 (and it is one of the 13 flagged) |
| Base returns are flat + a **derived band** | `IND_BASE_*` carry flat amounts; the quote range comes from `pricing.estimate_band_percent` (15%) applied at total level |
| 13 lines await confirmation | unchanged; confirming is metadata, no version churn |
| 5 quotes exist | 2 reference `DEPOSIT_1040`, both **accepted** → price-locked, history must not be rewritten |

**This is the conflation, precisely:** a deposit is modelled as a *service you can sell*,
sitting in the same list and the same columns as real services. That is why the sheet
reads wrong and why confirming a price means deciding two unrelated things at once.

---

## Schema (migration 0050)

```
CREATE TYPE price_pricing_mode AS ENUM ('flat', 'range', 'hourly');

ALTER TABLE price_book_items
  ADD COLUMN pricing_mode  price_pricing_mode NOT NULL DEFAULT 'flat',
  ADD COLUMN deposit_cents integer;              -- nullable; most lines none
```

`deposit_cents`, not `deposit_amount` — every money column in this codebase is integer
cents with a `_cents` suffix (`amount_cents`, `price_min_cents`, `final_fee_cents`). A
bare `deposit_amount` would be the only column whose unit you have to guess.

**CHECK constraints make the mode mean something** rather than being a label that can
drift from the data — the same reason the schedule/consent rules are constraints and not
service-layer promises:

- `flat`   → `amount_cents NOT NULL`, `price_min_cents`/`price_max_cents` NULL
- `range`  → both min and max NOT NULL, `amount_cents` NULL, min ≤ max
- `hourly` → `amount_cents NOT NULL` AND `unit = 'per_hour'`
- `deposit_cents IS NULL OR deposit_cents >= 0`

Backfill is unambiguous against v3 data: no row has both `amount_cents` and a range, so
`amount_cents NOT NULL → flat`, min/max → `range`. One line becomes `range`, the rest
`flat`.

### `hourly` is built as an enum value, not as a mode — for now
No composer, packet, or letter work yet. The CHECK admits the value so the data can
never be malformed later; nothing constructs it.

**Contingent next step (Brian, 2026-08-14):** he corrected his own premise — *"'we don't
bill hourly today' was wrong — those three rate-card lines are real."* The three
`per_hour` lines go to his confirmation queue. **If he confirms them as hourly in his
review sitting, hourly mode gets built then, against those three lines.** That is a
follow-on task, not part of this one, and it is the only thing that would make
`pricing_mode = 'hourly'` live.

---

## Deposits

- Quote-level deposit = **sum of line `deposit_cents`**.
- **The deposit does NOT multiply with quantity** (Brian, 2026-08-14): *"One line = one
  work-start commitment regardless of units."* A line with `deposit_cents` $250 at
  qty 3 contributes $250, not $750. This is deliberately unlike price, which does scale,
  so the composer must not reuse the line-total path for it.
- `DEPOSIT_1040` and `DEPOSIT_BUSINESS_TAX` are **retired in v4** (`is_active = false`),
  not deleted — v3 stays intact and the two accepted quotes keep reading their locked
  version. Retiring rather than deleting is the same rule used for the superseded
  engagement letters.
- `quotes.deposit_item_code` remains **readable** for those two historical quotes.
  New quotes never write it. One forward path, one historical read — not two live
  settlement paths (the mistake #24 was about).
- `deposit_override_cents` and the `deposits.override` permission keep working, now
  against the summed standard. Treatment stays *derived* by comparing override to
  standard, so an override equal to the standard is still honestly recorded as
  `standard`.
- **Nothing changes about no-payment-at-booking.** Deposits are collected only through
  the quote flow. Cal.com carries no price/currency config and still won't.

---

## Admin → Pricing rebuild

- **Deposit and price as visibly separate columns**, mode shown per line.
- **390px is the primary target, not the fallback.** The current page is a `<table>`,
  which cannot work on a phone — it becomes a card per line: name, mode badge, price
  field, deposit field, ⚠ flag.
- `needs_confirmation` flags carried over; the ⚠ queue keeps one-click confirm.
- The version-staging form currently accepts **only** `amountCents`. It has to accept
  mode, min/max, and deposit, or a v4 line cannot be edited into a v5.

---

## Migration to v4 — flag, never guess

Brian: *"flag any line where deposit-vs-price is ambiguous rather than guessing; those
land in my confirmation queue with the 13."*

Two ambiguities exist in the current data, and neither is mine to resolve:

### A. Three lines are already priced per hour
`ACCT_CATCHUP_HOURLY` $75/hr · `IND_SPECIALIZED_HOURLY` $150/hr ·
`RES_BOOKS_RECONSTRUCTION` $75/hr — all `unit = 'per_hour'` with a flat amount.

**Resolved by Brian 2026-08-14**: the premise *"we don't bill hourly today"* was wrong —
these three rate-card lines are real. They migrate to `flat` + `per_hour` (behaviour
preserved exactly) and are **flagged to his confirmation queue** so he rules on them in
the same sitting. If he confirms them as hourly, hourly mode is built then, against
these three lines.

### B. Where do the retired deposit amounts land?
`DEPOSIT_1040` $250 and `DEPOSIT_BUSINESS_TAX` $300 have to become `deposit_cents` on
specific service lines. There are four `IND_BASE_*` returns and several business-tax
lines — which of them carry a deposit, and whether it is $250 each, is a pricing
decision. **Flagged to his queue**, one row per candidate line.

---

## Checklist

- [x] Migration 0050: enum, four columns, CHECK constraints, backfill mode from v3 data
- [x] `scripts/price-book-v4.mjs` creates v4 as a new effective-dated version (dry run by
      default). **Schema + seed was not enough**: the seed only ever writes v1 and the
      book in force is v3, so after migrating, the live admin page still showed "no
      deposit" on every line. Caught by opening the page, not by the tests — which all
      pass because a fresh test DB has v1 in force
- [x] Every line the script touches is flagged with a written note saying what the
      question is
- [x] Quote composition: deposit = sum of line deposits, pinned to the quote's locked
      version; override applies to the sum; treatment still derived
- [x] `resolveDeposit` reads the summed path forward, legacy `deposit_item_code` back
- [x] Admin → Pricing rebuilt: separate price/deposit columns, mode per line, cards at
      390px, queue grouped by question with bulk confirm, staging accepts deposit edits
- [x] Tests: 9 new (393/393 total) — mode CHECKs reject all four malformed shapes,
      summed deposit across a multi-line quote, deposit does not multiply with qty,
      override against the sum, version pinning, new versions carry both columns forward
- [x] Verified at 390px in a local browser against real v4 data: table hidden, cards
      shown, **no horizontal scroll**, inputs 341px wide, "Confirm all 4/3/8" groups
      present, bulk confirm took the queue 30 → 26 and cleared only the structure flag

## Two things that changed during the build

### `structure_needs_confirmation` is a SECOND flag, not the existing one
Flagging deposits with `needs_confirmation` marked every 1040 quote as having an
unconfirmed **price** — the golden pricing test caught it immediately and was right to.
A price question makes a quote provisional; "should this line carry a deposit" does not.
Two columns, one queue, one tap each.

### The deposit ITEMS stay active, and that is now a flagged question
Retiring `DEPOSIT_1040` / `DEPOSIT_BUSINESS_TAX` broke **Lane 1**: the New Client
Discovery booking flow invoices them directly — no quote, no lines to sum. That is a
second deposit path the brief does not mention. Brian's "deposits collected only through
the quote flow" reads as though it should not exist, but it is shipped, tested and
charging real money, so switching it off is his call. Both items stay active and carry a
structure flag asking him. **If he confirms both paths, a booking client would be asked
for a deposit twice** — that is in the note.
