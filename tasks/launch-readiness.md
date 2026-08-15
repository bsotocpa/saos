# Launch readiness — hard gates

Gates here are **blocking**. Each one exists because something is known to be wrong,
not because it might be. A gate is removed only by fixing the thing, never by deciding
it is probably fine.

---

## GATE 1 — CLEARED 2026-08-15 (finding #19 fixed)

**Was:** no non-tax quote (bookkeeping, formation, entity, payroll) could be SENT,
because `acceptQuote()` hardcoded `serviceLine: 'tax'` — accepting a bookkeeping quote
would have produced a Schedule A, an individual-tax agreement for work that is not
individual tax.

**Fixed.** Acceptance now derives the engagement line from the price book
(`engagement-lines.ts`) and creates **one engagement per distinct service line on the
quote** — Brian's ruling 2026-08-15, matching how schedules already work: a packet
attaches Schedule A *and* Schedule C, so the agreements behind them are two agreements.

Titles are service-line distinct too ("Tax — 2025 individual return", "Entity services —
Entity formation with EIN"), which closes the RC2 finding: a client with two engagements
read "2 active engagements (tax, tax)" with nothing to tell them apart.

`recurring_accounting` maps **per item**, because that one price line genuinely covers
three engagement lines — Schedule C holds bookkeeping, payroll and sales tax together and
only the item says which. `SCOPE_FULLMGMT_PAYROLL` → payroll; `SCOPE_FULLMGMT_SALES_TAX`
and `SALES_TAX_ST1_FILING` → sales_tax; everything else in the line → bookkeeping.

**The gate was deleted, not left dormant.** `assertTaxOnlyUntil19` is gone; a gate that
no longer gates is a comment pretending to be a control. Its successor,
`assertEveryLineCreatesWork`, guards the failure that remains: a priced line mapping to
no engagement line would be silently dropped, so the client would agree to work that
produces no agreement and no schedule. Still refused at SEND, where a staff member can
fix it before the client is asked to decide anything.

**Verified:** removing the mapping (returning `'tax'` unconditionally, the old behaviour)
fails all three #19 tests and nothing else. Root npm test 405/405.

### Noted while fixing it — v1 and production disagree about two items

GATE 2's reclassification landed in a **new version** and deliberately left v1 alone, so
`SCOPE_FULLMGMT_PAYROLL` is `scope_ladder` in v1 and `recurring_accounting` in v5. That
is versioning working as intended — v1 is history — but it means a **from-scratch seed**
(tests, a brand-new environment) starts with the pre-GATE-2 classifications and only
reaches the corrected state by running `scripts/reclassify-price-lines.mjs`. A restore
from backup is unaffected: it restores every version as it stood.

## ATTORNEY FOLLOW-UP — Master v-next carries two amendments

Brian, 2026-08-15: one email, both items. Neither ships before attorney sign-off, and
neither is urgent — exposure on the first is nil while we control the behaviour.

1. **§2 booking-deposit language.** "Where a deposit is collected **at booking or
   onboarding** …" still authorises a path that no longer exists: the Lane 1 booking
   deposit was retired 2026-08-14 and deposits now exist only on accepted quotes. The
   clause is over-broad rather than false. Narrow it to acceptance.
2. **Governing-language third sentence.** The attorney's draft required all
   communications in English; it was deliberately omitted when the clause shipped
   (2026-08-13) because it contradicts bilingual operations. Deletion still pending his
   written confirmation.


## GATE 2 — CLEARED 2026-08-13 (price book v2)

Reclassified as a new effective-dated version per Brian's ruling — v1 closed 2026-08-13,
v2 opened the same day, 84 items and 13 needs_confirmation flags carried forward, no
price changed. v1 rows are intact, so every historical quote still reads under the book
it was written against.

  SCOPE_REVIEW_AUDIT       scope_ladder     -> attest              (F)
  SALES_TAX_ST1_FILING     scope_ladder     -> recurring_accounting (C)
  SCOPE_FULLMGMT_PAYROLL   scope_ladder     -> recurring_accounting (C)
  SCOPE_FULLMGMT_SALES_TAX scope_ladder     -> recurring_accounting (C)
  SCOPE_REG_SETUP          scope_ladder     -> recurring_accounting (C)
  SCORP_CONVERSION_2553    setup_conversion -> entity_services      (E)

Verified by rendered packet: attest quote implies F; the independence gate refuses attest
for a client with active Soto bookkeeping and yields only to a recorded override;
previewPacket refuses without a complete AU-C 210 / AR-C 90 Addendum; with the Addendum
complete the rendered Master names Schedule F.

scope_ladder lost its no-schedule ruling — only SCOPE_ADMIN_TRAINING remains there and it
is a product, not a tier modifier. STILL OPEN: which schedule governs training work.
The seed reports it loudly as unmapped-with-live-items, and GATE 1 blocks quoting it.


---

## GATE 3 — CLEARED 2026-08-13 (Stripe test keys installed)

Installed by Brian via scripts/install-stripe-test.sh. Verified in production:

  · adapter reports mode 'live' — the real Stripe path, not the stub
  · a 4242 card CHARGED in test mode (confirmed PaymentIntent, livemode=false)
  · a correctly signed webhook is accepted, in-process AND over HTTPS through Caddy
  · a forged signature is rejected, and rejected AS a signature failure

Deposits can now be paid with 4242 4242 4242 4242, any future expiry, any CVC.

### Installing Stripe TEST keys — one command, one value

**I do not handle payment credentials.** So the installer asks YOU for the key and never
shows it to me: it is read silently, never echoed, never written to shell history, and
passed to curl through stdin so it cannot be seen in `ps`. Only a masked form is printed.

Get the key from the Stripe dashboard with the TEST MODE toggle on:
Developers → API keys → Secret key (starts `sk_test_`). That is the ONLY value you need
— the webhook signing secret is created and captured by the script from Stripe's own
API response, because Stripe reveals it once, at creation.

```bash
ssh -i ~/.ssh/saos_hetzner_ed25519 root@SERVER_IPV4-in-env-production -t 'bash /opt/saos/scripts/install-stripe-test.sh'
```

It then: validates the key and REFUSES a live one outright; confirms Stripe reports
livemode=false; deletes and recreates the webhook endpoint so a fresh signing secret can
be captured; backs up and writes `.env`; restarts the API; and verifies

  · the adapter our code uses reports mode `live`, not stub
  · a real 4242 charge succeeds in test mode (a confirmed PaymentIntent, not a simulation)
  · a correctly signed webhook is ACCEPTED and a forged signature is REJECTED

then prints PASS/FAIL. On failure your `.env` backup is at `/opt/saos/.env.bak.*` and
`STRIPE_MODE=stub` restores the previous behaviour.

Tested before handing it over: empty input, a live key, and a well-formed but invalid
test key all refuse cleanly and leave `.env` byte-identical; the `.env` writer preserves
existing secrets, replaces in place without duplicating, and handles & = verbatim.

---

## Cleared gates

- **§7216 consent-screen isolation** — dedicated `/consent`, nav suppressed, duration
  stated, decline equally weighted. Rev. Proc. 2013-14. Verified in production.
- **Portal uploads are virus-scanned** (#14) — intake never refuses, filing fails
  closed, rescan job clears a scanner outage automatically. Backfill found no exposure.
- **Quote acceptance produces visible consequence** (#17) — task creation is
  unconditional, and a build check prevents the class from returning.
- **No task creation gated on an unfilled role** — `npm run check:role-tasks`.
