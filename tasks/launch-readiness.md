# SAOS Launch Readiness — every gate between today and the first real client

Generated 2026-08-09 from the **live production database**, not from memory.
Counts here are queried, not estimated; where I state a number, the query is
named so you can re-run it.

**Definition of launched**: one real client receives a portal invitation, signs
a real engagement letter, and uploads a real document. Everything below either
blocks that or must be deliberately decided before it.

---

## 1. The four hard blockers

Nothing client-facing can happen until these clear. All four are yours — none
is a build task.

### 1.1 Legal text: 7 placeholder templates ⛔
`SELECT key FROM templates WHERE is_placeholder` → **7 rows**

| Template | What it blocks |
|---|---|
| `consent_7216_use` | §7216 consent — blocks referrals, upsell flags, any cross-entity use |
| `consent_7216_disclose` | §7216 disclosure — same gate, disclosure side |
| `engagement_letter_tax` | Every tax engagement past "Scheduled" |
| `engagement_letter_bookkeeping` | Every bookkeeping engagement |
| `engagement_letter_advisory` | Advisory / CFO engagements |
| `engagement_letter_coo` | COO-services engagements |
| `engagement_letter_entity` | Entity-services engagements |

The placeholder gate is enforced in code and refuses to send in **every**
environment — so this can't leak by accident, and it also can't be worked
around. Final text goes in Admin → Templates; clearing the flag is the
launch-gate action and is audited by name.

### 1.2 Late-fee disclosure flag ⛔ (dependent on 1.1)
`SELECT count(*) FROM templates WHERE has_late_fee_disclosure` → **0**

The seed added a disclosure block to the placeholder letter bodies, but your
existing template rows were deliberately left untouched, so today **no letter
carries the disclosure and no late fee can ever be assessed**. When you paste
final legal text that includes the block, set the flag on that template in the
same edit. Setting it on a body that lacks the block would be a false gate —
don't.

### 1.3 Price confirmations: 12 items ⛔
`SELECT item_code FROM price_book_items WHERE needs_confirmation AND version in force` → **12 rows**

You said 13; the live count is **12**. (It was 12 before M26.5, which added two
new ⚠ items and confirmed none — so the arithmetic that would give 13 or 14 is
double-counting. Here is the actual list.)

| Item | Conflict to resolve |
|---|---|
| `ACCT_SEMI_ANNUAL` | Service sheet $900 vs workbook $800 vs verbal $1,000 |
| `DEPOSIT_BUSINESS_TAX` | Observed $300 — one standard deposit, or per-service? |
| `ENTITY_ANNUAL_REPORT` | $130 current vs $60 older sheet |
| `ENTITY_FORMATION_EIN` | $500 current vs $250 older sheet |
| `IND_CPA_LETTER` | $250–500 range; overlaps `SPEC_TAX_PLANNING` |
| `SALES_TAX_ST1_FILING` | $50/filing vs the scope-ladder rung |
| `SCOPE_FULLMGMT_PAYROLL` | Spec gives $500 with no billing unit (seeded monthly) |
| `SCOPE_FULLMGMT_SALES_TAX` | $100 workbook vs $50/filing sheet |
| `SPEC_CPA_CONFIRMATION_LETTERS` | $500 each vs $150/hr |
| `SPEC_LOAN_DUE_DILIGENCE` | $500 each vs $150/hr |
| `SPEC_TAX_PLANNING` | $500 each vs $150/hr |
| `SPEC_FORECASTING_BUDGETING` | $500 each vs $150/hr |

Two more arrive on the next deploy (added by M26.5 today, not yet in
production): `RES_PENALTY_ABATEMENT` and `RES_INSTALLMENT_AGREEMENT`, both
seeded at the Specialized $500 rate. That will make the query return **14**.
Neither is needed for a first onboarding — they only bind when you sell
abatement or an installment agreement.

Confirming a price is a normal Admin → Pricing edit and creates a new
effective-dated version; existing engagements stay pinned to the version they
were signed under.

### 1.4 SES production access ⛔
`SMTP_HOST=email-smtp.us-east-2.amazonaws.com` — DKIM + MAIL FROM verified,
delivering. **Still in the AWS sandbox as far as I know**: the last status you
gave me was "production access requested." In sandbox, mail only reaches
verified addresses, so magic links to real clients silently fail.

**Action**: confirm the AWS support case is approved before any invitation
goes out. This is the one blocker I cannot verify from inside the system —
please check the SES console.

---

## 2. Vendor state (verified from the server today)

| Vendor | State | Gate |
|---|---|---|
| **Twilio** | ✅ Live. 708-300-0375 A2P-registered, inbound webhooks built, MMS attachment intake working, STOP handling live | None. 312-715-8599 ports post-launch as a Messaging Service config swap — the build is number-agnostic |
| **ClamAV** | ✅ Enabled in prod today, healthy, `PONG` from the API. Attachments really are scanned | None |
| **Amazon SES** | ⚠ Verified + delivering; sandbox status unconfirmed | See 1.4 |
| **Stripe** | ⚠ `STRIPE_MODE=stub` — fail-closed by design | Create the webhook endpoint on api.sotoaccounting.com, paste the `whsec_`, flip to `live`. Needed before you charge a deposit, not before onboarding |
| **Docuseal** | ⚠ `DOCUSEAL_MODE=http` (real), container up 4 weeks | First-boot admin setup + template upload. Needed for signatures = needed for launch |
| **KBA vendor** | ⛔ `KBA_MODE=sandbox` — no account chosen | Blocks remote 8879 only. Not needed for a first *onboarding*; blocks your first *e-filed return*. Wet-signature path works without it |
| **Cal.com** | ⚠ Container healthy | Event types + Zoom-only enforcement on discovery calls; needed for booking flows |
| **Uptime Kuma** | ⚠ Container healthy | Monitors need adding (one-time) |
| **B2 backups** | ✅ Nightly cron installed + verified, restore drill PASSED 15/15 | None |

---

## 3. Data migration

| Item | State |
|---|---|
| Contacts / businesses / grants | ✅ 862 / 617 / 54 imported and verified |
| Enrichment backfill | ✅ 611 gap tasks, now `not_started` |
| **Trello JSONs** | ⛔ **Not received.** `SELECT count(*) FROM tasks WHERE source_type='trello'` → **0**; boards → **0**. The importer is built, tested, and idempotent — it just has nothing to import. Drop the exports in `migration-data/` and I'll run it |
| **Dubsado retirement** | ⛔ Decision pending — see §5 |
| Portal invitations | ⛔ `portal_users` → **0**. Nobody has been invited. This is the launch trigger itself |

---

## 4. Automation arming order (all 8 are OFF in production right now)

Verified: `SELECT key, enabled FROM automations` → all `false`.

Arm them in this order — each step is safe once the one before it is proven,
and every job counts what it suppressed while off, so you can see what *would*
have fired before you arm it.

| # | Automation | Arm when | Why this order |
|---|---|---|---|
| 1 | `attachment_acks` | Immediately at first invite | A client who texts a document gets silence otherwise. Transactional reply, not outreach — lowest risk, highest rudeness-if-missing |
| 2 | `document_chase` | After the first few clients upload successfully | Proves your document requests read well before it repeats them |
| 3 | `escalation_ladder` | After document_chase behaves for ~1 week | The big one. Rungs stay frozen while off, so arming picks up each client's real clock instead of dumping everyone at D30 |
| 4 | `estimate_reminders` | Before the next quarterly estimate date | Per-client toggle still applies underneath |
| 5 | `annual_report_client_reminders` | Before the next annual-report T-30 window | Laura's T-60 staff reminder runs regardless |
| 6 | `extension_notices` | Before the first sweep window (T-10 from a deadline) | The internal decision list and at-risk flags already run |
| 7 | `ar_dunning` | After the first invoices go out | Invoices flip to overdue and Rene gets tasks while off — only the client chase waits |
| 8 | `late_fees` | **Only after 1.1 + 1.2** | Structurally impossible before the disclosure flag is set; arming it early does nothing |

---

## 5. Decisions only you can make

| Decision | Why it's blocking | My read |
|---|---|---|
| **Dubsado retirement trigger** | Never defined. Not a code gate — a "when do we stop dual-running" gate | Suggest: retire once (a) 25 migrated clients have logged into the portal, and (b) one full month-end close has run in SAOS. Both are queryable, so I can build the check and alert you when it's met |
| **First-cohort size** | Invitations are irreversible in practice | Suggest 5–10 friendly clients, not 300. The migrated-onboarding sequence is staged and waiting; nothing sends until you say so |
| **Portal-welcome copy** | Needs your voice, EN + ES | Template exists and is admin-editable |
| **KBA vendor** | $1–3/signature; blocks remote 8879 | Pick before tax season, not before launch |

---

## 6. What is NOT blocking (so you can ignore it)

- **M27 / M28** (quote builder UI, reports, announcements, SOP KB, Hilo events,
  wireframe conformance) — none gate a first onboarding.
- **Resolution lane / bundle builder** — shipped today, but only binds when you
  sell that work.
- **Stripe live mode** — blocks *charging*, not onboarding.
- **The 2 new ⚠ resolution prices** — only bind on abatement / IA sales.

---

## 7. Shortest path to first client

1. Paste final §7216 + tax engagement-letter text; clear those 2 placeholder
   flags (and set the late-fee flag if the letter carries the block).
2. Confirm SES production access in the AWS console.
3. Complete Docuseal first-boot + upload the letter template.
4. Confirm the 4–5 price items that a first tax engagement actually touches
   (the individual base rates are already confirmed — the 12 pending are mostly
   specialized/scope items).
5. Arm `attachment_acks`.
6. Invite ONE client. Watch it end to end.
7. Then arm automations 2–3 and widen the cohort.

Steps 1–4 are yours. Steps 5–7 I can drive the moment you say go.

**Everything else in this document can wait until after that first client
succeeds.**
