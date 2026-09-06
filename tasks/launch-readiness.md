# Launch readiness — hard gates

Gates here are **blocking**. Each one exists because something is known to be wrong,
not because it might be. A gate is removed only by fixing the thing, never by deciding
it is probably fine.

---

## OPEN GATES — snapshot 2026-09-06

Measured against production, not remembered. Ownership is stated because most of what is
left is not code.

### ⛔ BLOCKING CLIENT #1

**G-A. Five engagement letters still say PLACEHOLDER.** — **BRIAN**

    engagement_letter_tax          engagement_letter_bookkeeping
    engagement_letter_advisory     engagement_letter_coo
    engagement_letter_entity

The placeholder gate is enforced in code and must never be removed, so **no engagement letter
can be sent to a production client today**. That stops the flow at the step right after a quote
is accepted. §7216 consent is already real — these five are the only templates left.

This is legal copy, not software. Nothing I can do moves it.

**G-B. Stripe is running on TEST keys.** — **BRIAN**

`STRIPE_MODE=live` means the real adapter rather than the stub, but the secret is `sk_test_`.
A 4242 card charges; a client's real card cannot. Deposits and invoices are both affected.

`scripts/install-stripe-test.sh` deliberately REFUSES a live key, so switching over needs a
companion installer with the same safety properties (never echoes the key, never writes it to
history, verifies before and after). **Mine to write, once you say go** — and worth doing
deliberately rather than by editing `.env` on the box.

### ⚠ BLOCKING SOME PATHS, NOT ALL

**G-C. KBA is in sandbox; no vendor, no key.** — **BRIAN** (account) then **ME** (wiring)

`KBA_MODE=sandbox`, `KBA_VENDOR` and `KBA_API_KEY` empty. Per CLAUDE.md the remote 8879 path
requires the KBA step before the Docuseal envelope, so **remote e-file signature is unavailable**.
In-person wet signature is a documented, compliant alternative and is unaffected — so this blocks
a remote-signing client, not every client.

**G-D. One staff account exists: yours.** — **BRIAN**

No Laura, Rene, Ana-Maria, Jackson or Marian. Every role-routed task resolves through the CEO
fallback and lands on you — which is the fallback working, not a bug, but it means the queue is
one person's. This is also what gates **(3c) Laura's entity page**: she is the operator, and it
ships when she can log in.

**G-E. Twilio has credentials but no sending number.** — **BRIAN**

`TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are set, `TWILIO_FROM` is empty. No SMS can send.
Affects the D7 nudge rung and any text-based flow. Client #1 can be served entirely without SMS.

### ✅ CLEARED, verified in production today

- **DNS** — all eight hostnames (api, book, ntfy, ops, portal, sign, status, vault) resolve to the
  box; `portal`, `api/health` and `ops` all answer **200** over HTTPS from outside. The ⛔ in
  todo.md asking you to create these is stale; they exist.
- **Email** — SES SMTP configured and **125 messages actually sent**. Not theoretical.
- **Backups** — nightly restic → B2 at 02:15, last snapshot succeeded, four buckets covered.
- **Price book** — 84 items on the active version, **0** flagged `needs_confirmation`.
- **Client-acting automations** — 11 of 13 disarmed, which is the designed state. You arm them as
  clients arrive.

---

## Not gates — worth knowing

- **`entity_compliance` holds 0 rows.** The annual-report module tracks nothing yet, by sequence
  rather than by defect: enrolment now happens automatically on entity work, and the four
  Florida businesses need entity types typed before they enrol. Not blocking client #1.
- **No guard enforces "every client-facing send is gated."** The ungated `sos_fix_steps` email
  found on 2026-09-06 got past seven guards because none of them looks for that class. Next
  guard to write.

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

## ATTORNEY FOLLOW-UP — both items GREEN-LIT 2026-08-15

Brian sent one email covering both; the attorney signed off on both. Sign-off on file
with Brian.

### 1. Governing-language third sentence — CLOSED

The attorney's draft carried a third sentence requiring all communications to be
conducted in English. It was deliberately omitted when the clause shipped on 2026-08-13
because it contradicts bilingual operations — all Soto client copy ships in English AND
Spanish — and the template version note recorded the deletion as pending his written
confirmation.

**That confirmation is in hand. The sentence stays out permanently.**

No document text changed, because the sentence was never included. What changed is the
record: the note on `engagement_master` v2 now carries the confirmation, appended
rather than replacing the pending text so both the conditional decision and its
resolution survive. The version was NOT bumped — nothing moved in the agreement itself.

### 2. §2 booking-deposit language — CLOSED, shipped as Master v3

Brian confirmed the wording 2026-08-15 (the sign-off was to the change; he is forwarding
the final sentence to the attorney for the file). Shipped by
`scripts/amend-master-v-next.mjs`.

> Where a deposit is collected **when you accept a quote**, all completed work is
> reconciled against your deposit at invoicing: overpayments are credited to your account
> and any remaining balance is billed.

One phrase, asserted before and after — the script refuses unless it finds the old wording
exactly once, and refuses to report success unless the body differs by exactly that
substitution. No other sentence in §2 moved.

**The Spanish body was amended with it.** It is approved and live, so Spanish-speaking
clients read it rather than falling back to English; amending only the English would have
left them reading a clause about a collection path the firm retired, and the
governing-language clause makes English control — so the divergence would have been a
comprehension failure rather than a legal one, which is worse in the way that matters to a
client. "al momento de reservar o de incorporarse" became "al aceptar una
cotización", using vocabulary already in that paragraph.

**Spanish phrasing approved by Brian 2026-08-15** — "al aceptar una cotización" confirmed
correct and consistent with the paragraph's vocabulary. Both the EN and ES final §2 go to
the attorney's file verbatim in the FYI, so counsel holds the exact text of both
renderings rather than the English plus a description of the Spanish.

**Already-signed clients are unaffected.** The rendered HTML of a signed packet is stored
in `saos-signed-docs` at signature time, so what a client signed is a preserved artifact
rather than a re-render of whatever the template says today. Two signed packets, both
intact.

The reconciliation this clause promises is implemented as of finding #26 — the papers and
the system now say the same thing, in both directions.

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
ssh -i ~/.ssh/saos_hetzner_ed25519 "root@$(sed -n 's/^SERVER_IPV4=//p' .env.production)" -t 'bash /opt/saos/scripts/install-stripe-test.sh'
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
