# SAOS Launch Readiness — every gate between today and the first real client

Updated 2026-08-09 (SES production access confirmed — blocker 1.4 cleared).
Generated from the **live production database**, not from memory.
Counts here are queried, not estimated; where I state a number, the query is
named so you can re-run it.

**Definition of launched**: one real client receives a portal invitation, signs
a real engagement letter, and uploads a real document. Everything below either
blocks that or must be deliberately decided before it.

---

## 1. The three hard blockers

Nothing client-facing can happen until these clear. All three are yours — none
is a build task. (Was four; SES cleared 2026-08-09.)

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

### 1.3 Price confirmations: 14 items ⛔
`SELECT item_code FROM price_book_items WHERE needs_confirmation AND version in force` → **14 rows** (live, post-M26.5 deploy)

The 12 below are the ones a normal engagement can touch. The two resolution
items added by M26.5 are now in production, making the query return 14 — they
are listed separately after the table because they only bind if you sell that
work.

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

Plus two now live from M26.5: `RES_PENALTY_ABATEMENT` and
`RES_INSTALLMENT_AGREEMENT`, both seeded at the Specialized rate. Neither is
needed for a first onboarding — they only bind when you sell abatement or an
installment agreement.

Confirming a price is a normal Admin → Pricing edit and creates a new
effective-dated version; existing engagements stay pinned to the version they
were signed under.

### 1.4 SES production access ✅ CLEARED 2026-08-09
`SMTP_HOST=email-smtp.us-east-2.amazonaws.com` — DKIM + MAIL FROM verified,
delivering, and **out of the sandbox: 50,000/day quota, us-east-2, healthy**
(confirmed by Brian in the AWS console). Magic links, quote links, and
invitations can now reach unverified real addresses.

Worth knowing rather than worrying about: 50k/day is ~117× the whole migrated
book, so volume is not a constraint. What matters at this quota is *reputation*
— bounces and complaints. The suppression lists and unsubscribe handling are
already built and enforced at send time, and every client-acting automation is
still OFF, so the first sends will be ones you trigger by hand.

---

## 2. Vendor state (verified from the server today)

| Vendor | State | Gate |
|---|---|---|
| **Twilio** | ✅ Live. 708-300-0375 A2P-registered, inbound webhooks built, MMS attachment intake working, STOP handling live | None. 312-715-8599 ports post-launch as a Messaging Service config swap — the build is number-agnostic |
| **ClamAV** | ✅ Enabled in prod today, healthy, `PONG` from the API. Attachments really are scanned | None |
| **Amazon SES** | ✅ Production access granted 2026-08-09 — 50k/day, us-east-2, DKIM + MAIL FROM verified | None |
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
| ~~**Dubsado retirement trigger**~~ | ✅ **DECIDED + BUILT 2026-08-09** | 25 migrated portal logins AND one completed month-end close. Live in production, date-guarded, alerts exactly once; readiness reads `0/25` and `0/1` on the Executive dashboard today |
| **First-cohort size** | Invitations are irreversible in practice | Suggest 5–10 friendly clients, not 300. The migrated-onboarding sequence is staged and waiting; nothing sends until you say so |
| **Portal-welcome copy** | Needs your voice, EN + ES | Template exists and is admin-editable |
| **KBA vendor** | $1–3/signature; blocks remote 8879 | Pick before tax season, not before launch |

---

## 6. What is NOT blocking (so you can ignore it)

- **M27 / M28** (reports, announcements, SOP KB, Hilo events, wireframe
  conformance) — none gate a first onboarding.
- **Resolution lane / bundle builder / quote builder** — all shipped and live,
  but each only binds when you actually sell or send something.
- **Stripe live mode** — blocks *charging*, not onboarding. Note: the quote
  builder's deposit checkout produces a real invoice today; collecting on it
  needs Stripe live.
- **The 2 ⚠ resolution prices** — only bind on abatement / IA sales.

---

## 7. Shortest path to first client

1. Paste final §7216 + tax engagement-letter text; clear those 2 placeholder
   flags (and set the late-fee flag if the letter carries the block).
2. ~~Confirm SES production access~~ ✅ done 2026-08-09.
3. Complete Docuseal first-boot + upload the letter template.
4. Confirm the 4–5 price items that a first tax engagement actually touches
   (the individual base rates are already confirmed — the 14 pending are mostly
   specialized/scope items).
5. Arm `attachment_acks`.
6. Invite ONE client. Watch it end to end.
7. Then arm automations 2–3 and widen the cohort.

Steps 1, 3, and 4 are yours. Steps 5–7 I can drive the moment you say go.

**Now that SES is out of the sandbox, step 1 is the single thing standing
between you and a real client**: the engagement letter and §7216 text. Docuseal
first-boot (3) is close behind it, since a letter with no signature path is just
a PDF.

**Everything else in this document can wait until after that first client
succeeds.**
