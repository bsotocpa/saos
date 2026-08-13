# Launch readiness — hard gates

Gates here are **blocking**. Each one exists because something is known to be wrong,
not because it might be. A gate is removed only by fixing the thing, never by deciding
it is probably fine.

---

## GATE 1 — TAX-ONLY QUOTING until finding #19 is fixed

**Ruling: Brian, 2026-08-13.** No non-tax quote (bookkeeping, formation, entity,
payroll) may be sent until #19 is fixed. Tax-only until then.

**Enforced in code**, not only here: `sendQuote()` refuses any quote whose price-book
lines are not individual/business tax with `409 non_tax_quote_gated`. A gate that lives
only in a document is a gate that gets forgotten at 11pm.

### Why (#19)

`acceptQuote()` hardcodes `serviceLine: 'tax'` when it creates the engagement. So every
accepted quote produces a **tax** engagement regardless of what was sold, and the
engagement's service line is what drives schedule assembly. A bookkeeping quote
therefore produces a Schedule A (individual tax) agreement.

### What the verification actually showed

Brian's standard: *"Seeded data is a claim; the rendered packet is the fact."* Applied to
the three newly-ruled price lines, quote → accept → packet → **rendered Master**:

| price line | mapping says | rendered packet attaches | control: correct engagement line |
|---|---|---|---|
| `setup_conversion` | C ✓ | **A ✗** | `bookkeeping` → C ✓ |
| `filings_1099_w2` | C ✓ | **A ✗** | `payroll` → C ✓ |
| `scope_ladder` | none ✓ | **A ✗** | n/a |

So the mapping data is right and the schedule → packet path is right. The broken link is
quote → engagement, which is #19. The claim verifies; the fact does not, and the fact is
what matters.

Worse than mis-filing: the third row means a quote containing only add-on lines still
produces a Schedule A. A client would be asked to sign an **individual tax** agreement
for a sales-tax filing.

### Fixing #19 needs a mapping that does not exist yet

`schedule_for_price_line` maps price line → **schedule code** (A–F). Assembly needs
price line → **engagement `service_line`** (`tax`, `bookkeeping`, `payroll`, …). Those
are different enums and the second mapping has never existed — that is why the hardcode
was there.

---

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

## GATE 3 — Payments are stubbed

`STRIPE_MODE=stub` in production, and stub mode refuses checkout there on purpose
(`503 stripe_not_configured`). No client can pay a deposit.

### Installing Stripe TEST keys — Brian does this part

**I do not handle payment credentials.** Stripe secret keys are financial credentials,
so I will not write them into `.env` or paste them anywhere, even when asked — the
Docuseal token earlier in this project is the cautionary tale. Everything around the
keys is prepared; the two secret values are yours to install.

Get them from the Stripe dashboard in **test mode** (the toggle top-right):

- **Developers → API keys** → *Secret key*, starts `sk_test_`
- **Developers → Webhooks** → add endpoint `https://api.sotoaccounting.com/webhooks/stripe`,
  send `checkout.session.completed` and `payment_intent.payment_failed`, then copy the
  *Signing secret*, starts `whsec_`

Then, on the server:

```bash
ssh -i ~/.ssh/saos_hetzner_ed25519 root@SERVER_IPV4-in-env-production
```

Edit `/opt/saos/.env` and set these three lines (replace the placeholders, keep the
quotes off):

```
STRIPE_MODE=live
STRIPE_SECRET_KEY=sk_test_REPLACE_ME
STRIPE_WEBHOOK_SECRET=whsec_REPLACE_ME
```

`STRIPE_MODE=live` with `sk_test_` keys is correct and intended: "live" selects the real
Stripe adapter, and the test keys point it at Stripe's test environment. Real cards are
not charged. Use `4242 4242 4242 4242`, any future expiry, any CVC.

Then restart the API:

```bash
cd /opt/saos && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d api
```

**Deploys will not wipe these.** `scripts/merge-env.sh` preserves server-set values and
`npm run check:env-merge` proves a blank in `.env.production` cannot overwrite a
server-set secret — that guard exists because a deploy destroyed the Docuseal token
twice.

**Tell me when they are in and I will verify** — `loadConfig()` already refuses to boot
in production with `STRIPE_MODE=live` and either value missing, so a typo fails loudly
at startup rather than at a client's checkout. I will confirm the adapter reports `live`,
run a test-card checkout end to end, and confirm the webhook signature verifies.

---

## Cleared gates

- **§7216 consent-screen isolation** — dedicated `/consent`, nav suppressed, duration
  stated, decline equally weighted. Rev. Proc. 2013-14. Verified in production.
- **Portal uploads are virus-scanned** (#14) — intake never refuses, filing fails
  closed, rescan job clears a scanner outage automatically. Backfill found no exposure.
- **Quote acceptance produces visible consequence** (#17) — task creation is
  unconditional, and a build check prevents the class from returning.
- **No task creation gated on an unfilled role** — `npm run check:role-tasks`.
