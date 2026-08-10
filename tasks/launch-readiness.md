# SAOS Launch Readiness — every gate between today and the first real client

Updated 2026-08-10 (legal package v3 FINAL implemented — blocker 1.1 + 1.2 clear
on deploy). Generated from the **live production database**, not from memory.
Counts here are queried, not estimated; where I state a number, the query is
named so you can re-run it.

**Definition of launched**: one real client receives a portal invitation, signs
the Master Engagement Agreement, and uploads a real document. Everything below
either blocks that or must be deliberately decided before it.

---

## The short version

**One thing is on the critical path, and it is yours: Docuseal first-boot.**

Everything legal is written, loaded, and tested. It ships to production the
moment you approve the deploy. After that, the only gate left between you and
client #1 is a signature path — a Master Agreement with nowhere to sign is a PDF.

| Gate | State |
|---|---|
| Legal text (Master + Schedules A–E + both §7216 consents) | ✅ **CLEARED** — final text loaded, 0 active placeholders, verified |
| Late-fee disclosure flag | ✅ **CLEARED** — lives on the Master, flag set, text verified against the price book |
| SES production access | ✅ Cleared 2026-08-09 — 50k/day, us-east-2 |
| Deploy of migration 0038 + legal v3 seed | ⏳ **awaiting your approval** — 5 minutes, clears the two gates above in prod |
| Docuseal first-boot | ⛔ **yours, in progress** — admin password + Master/Schedules template upload |
| Price confirmations | ⚠ 13 of 14 remain — **1 done**. Only ~2 touch a first individual tax engagement |
| Invite client #1 | ⛔ the trigger itself — `portal_users` → **0** |

---

## 1. The hard blockers

### 1.1 Legal text ✅ CLEARED (in code; deploys on approval)

`SELECT key FROM templates WHERE is_placeholder AND is_active` → **0 rows**
(locally, migration 0038 + `legal_v3` seed applied and verified)

Production still reads **7** because 0038 is not deployed yet:
`SELECT count(*) FROM pgmigrations` → **37** (0038 pending).

What changed structurally — this is not five letters with new words in them:

| Before (v1–v2) | After (v3 FINAL) |
|---|---|
| 5 separate engagement letters, one per service line | **1 Master Engagement Agreement** + **Schedules A–E** |
| A new letter for every added service | One signature covers every schedule attached at signing; later services are accepted **per-schedule in the portal**, no re-execution |
| Late-fee disclosure hoped-for in each letter | Disclosure lives in Master §3 (1.5%/month after 30 days), flag set on the Master alone |

The schedules and who gets them:

| Schedule | Covers | Attached when |
|---|---|---|
| **A** | Individual income tax preparation | A 1040-family return is on file (or tax with no return type yet) |
| **B** | Business & nonprofit tax preparation | A business/nonprofit return type is on file (1065, 1120-S, 1120, 990, 1041, AG990-IL…) |
| **C** | Bookkeeping, payroll, sales tax | Any of those three service lines |
| **D** | Advisory, COO, nonprofit CFO, specialized CPA | Any of those four |
| **E** | Entity services | Entity line |

The A/B split derives from the **return type**, not from the service line — so a
business-only client is never made to sign the individual schedule, and an owner
with both gets both. Attest (CPA review/audit) has **no v3 schedule**: packet
assembly *refuses by name* rather than filing attest work under Advisory terms.
That is a real gap for your attorney, not something the build should paper over.

The five old letters are **retired, not deleted** (`is_active = false` with a
recorded reason) — they are the terms some historical engagement was signed
under, and that record matters.

The placeholder gate is unchanged and still enforced in code in every
environment. It now protects the Master.

### 1.2 Late-fee disclosure flag ✅ CLEARED

`SELECT key FROM templates WHERE has_late_fee_disclosure AND is_active` →
**`engagement_master`** (locally; production reads 0 until deploy)

Before flipping it I checked the actual numbers against the price book rather
than trusting the heading: Master §3 says **1.5% per month (18% APR) after 30
days**, and the `LATE_FEE_MONTHLY` price-book metadata says
`{"grace_days": 30, "monthly_rate_percent": 1.5}`. They match, so the flag is
true. Had they disagreed I would have left it false and asked — a flag set on
text that says something different is a false gate, which is worse than no gate.

Consequence: `late_fees` is now *armable* — structurally possible for the first
time. It is still seeded OFF and stays off until you arm it.

### 1.3 Price confirmations: 13 of 14 remain ⚠ (not a blocker for client #1)

`SELECT item_code FROM price_book_items WHERE needs_confirmation AND version in force`
→ **13 rows** (live production, 2026-08-10). `ACCT_SEMI_ANNUAL` is confirmed — 1 down.

| Item | Touches a first individual tax engagement? |
|---|---|
| `DEPOSIT_BUSINESS_TAX` | Only if client #1 is a business |
| `IND_CPA_LETTER` | Only if they ask for a CPA letter |
| `ENTITY_ANNUAL_REPORT`, `ENTITY_FORMATION_EIN` | No — entity work |
| `SALES_TAX_ST1_FILING`, `SCOPE_FULLMGMT_PAYROLL`, `SCOPE_FULLMGMT_SALES_TAX` | No — scope/management ladder |
| `SPEC_*` (4 items) | No — specialized services |
| `RES_*` (2 items) | No — resolution lane |

The individual base rates are already confirmed, so **a straightforward 1040
onboarding needs none of these**. Confirm them as you sell the work.

### 1.4 SES production access ✅ CLEARED 2026-08-09

50,000/day, us-east-2, DKIM + MAIL FROM verified, out of the sandbox. What
matters at this quota is reputation, not volume — suppression lists and
unsubscribe handling are enforced at send time, and every client-acting
automation except `attachment_acks` is still off.

---

## 2. Vendor state (verified from the server today)

| Vendor | State | Gate |
|---|---|---|
| **Amazon SES** | ✅ Production, 50k/day | None |
| **Twilio** | ✅ Live. 708-300-0375 A2P-registered, MMS intake + STOP handling working | None. The 312 number ports later as a Messaging Service config swap |
| **ClamAV** | ✅ Healthy in prod, attachments really are scanned | None |
| **B2 backups** | ✅ Nightly cron + restore drill PASSED 15/15 | None |
| **Docuseal** | ⚠ `DOCUSEAL_MODE=http` (real), container up | ⛔ **First-boot admin setup + upload the Master/Schedules template.** This is the critical path. Yours — it means setting a password, so it is not mine to do |
| **Stripe** | ⚠ `STRIPE_MODE=stub` — fail-closed by design | Webhook endpoint + `whsec_` + flip to live. Blocks *charging*, not onboarding — and the rehearsal deliberately uses a **$0 deposit override** so a Stripe problem can never be confused with a legal-text problem |
| **KBA vendor** | ⛔ `KBA_MODE=sandbox` | Blocks remote 8879 only — your first *e-filed return*, not your first onboarding. Wet signature works today |
| **Cal.com** | ⚠ Container healthy | Event types + Zoom-only enforcement on discovery calls |
| **Uptime Kuma** | ⚠ Container healthy | Monitors need adding (one-time) |

---

## 3. Data migration

| Item | State |
|---|---|
| Contacts / businesses / grants | ✅ 862 / 617 / 54 imported and verified; **426 active clients** |
| Enrichment backfill | ✅ 611 gap tasks queued |
| **Trello JSONs** | ⛔ Not received. `tasks WHERE source_type='trello'` → **0**. Importer is built, tested, idempotent — drop the exports in `migration-data/` and I'll run it |
| **Dubsado retirement** | ✅ Trigger decided + built (25 migrated logins AND one completed close); reads 0/25 and 0/1 today |
| Portal invitations | ⛔ `portal_users` → **0**. Nobody has been invited. This is the launch trigger |
| Signature envelopes | `signature_envelopes` → **0**. Nothing has ever been sent for signature |
| Test clients | `contacts WHERE is_test` → **0**. The rehearsal client does not exist yet |

---

## 4. Automations — 1 of 11 armed

`SELECT key, enabled FROM automations` (live, 2026-08-10):

| # | Automation | State | Arm when |
|---|---|---|---|
| 1 | `attachment_acks` | ✅ **ARMED** 2026-08-09 | Done — a client who texts a document gets an acknowledgement instead of silence |
| 2 | `document_chase` | off | After the first few clients upload successfully |
| 3 | `escalation_ladder` | off | ~1 week after document_chase behaves. Rungs stay frozen while off, so arming picks up each client's real clock instead of dumping everyone at D30 |
| 4 | `estimate_reminders` | off | Before the next quarterly estimate date |
| 5 | `annual_report_client_reminders` | off | Before the next annual-report T-30 window |
| 6 | `extension_notices` | off | Before the first sweep window (T-10) |
| 7 | `ar_dunning` | off | After the first invoices go out |
| 8 | `late_fees` | off | Now *possible* (1.2 cleared) — arm only when you actually want fees assessed |
| 9 | `session_recaps` | off | After you've approved a few recaps by hand |
| 10 | `review_requests` | off | After a client has had a genuinely good outcome |
| 11 | `event_reminders` | off | Before the first Hilo event with registrations |

Every job counts what it suppressed while off, so you can see what *would* have
fired before you arm it.

---

## 5. Spanish — English controls

v3 states the English text controls and Spanish translations follow. That is now
enforced rather than promised:

- Every v3 template ships with **no Spanish body** and `needs_es_review = true`.
- A Spanish-language client receives the **English** text, and the render path
  logs that it fell back. Sending a translation you have not read would be worse
  than sending the text that governs.
- `GET /admin/templates/es-queue` lists what is waiting for you. Approving is a
  separate deliberate act, and **editing an approved translation re-queues it** —
  an approval belongs to the text that was read, not to the row.

8 items are queued: the Master, Schedules A–E, and both §7216 consents.

---

## 6. §7216 — presented on v3's terms

| Consent | Who sees it | When |
|---|---|---|
| **USE** | Every client | At onboarding, **after** the Master signature, framed as a benefit ("want us to look for savings you have not asked about?") |
| **DISCLOSE** | Hilo-bridge clients only | At onboarding, or at an actual referral moment |

Three rules the code enforces:

1. **Never before the Master signature.** A consent presented alongside the
   document a client must sign to be served is the conditioning §7216 prohibits.
   Both the presentation and the capture path refuse.
2. **DISCLOSE is not offered to everyone.** Its recipient is Hilo NFP. Asking a
   client with no Hilo relationship to authorize a pointless disclosure — on a
   form that says "not a condition of any service" — is a bad look and worse law.
3. **Declining is a recorded answer**, so it is not asked again at the next step.
   And a decline never overwrites a consent already signed.

Neither consent ever conditions service. Both are revocable.

---

## 7. Decisions only you can make

| Decision | Why it's blocking | My read |
|---|---|---|
| **Deploy 0038 + legal v3** | Production still has 7 placeholders until it lands | Ship it. It is additive: new tables, new templates, five old letters retired. Nothing in flight depends on the old letters — `signature_envelopes` → 0 |
| **First-cohort size** | Invitations are irreversible in practice | 5–10 friendly clients, not 300. The migrated-onboarding sequence is staged and sends nothing until you say so |
| **Attest schedule** | Schedules A–E don't cover CPA review/audit work | Ask your attorney for a Schedule F. Not urgent — assembly refuses attest by name, so nothing can go out wrong in the meantime |
| **KBA vendor** | $1–3/signature; blocks remote 8879 | Before tax season, not before launch |

---

## 8. Shortest path to client #1

1. **Approve the deploy** of migration 0038 + the legal v3 seed. → gates 1.1 and
   1.2 read CLEARED in production. (5 minutes, mine to run.)
2. **Docuseal first-boot** — admin password, then upload the Master + Schedules
   template. Yours. This is the last real blocker.
3. **Dress rehearsal** against the flagged test client (`brian3712@gmail.com`,
   $0 deposit override): quote → deposit → intake → document upload → recap
   approval. Mine to drive; you play the client from your inbox.
4. **Fix whatever the rehearsal exposes.** That is what it is for.
5. **Invite client #1.** Watch it end to end.
6. Then arm automations 2–3 and widen the cohort.

Steps 1 and 3–6 I can drive. **Step 2 is the one thing only you can do**, and
everything after it is waiting on it.

---

## 9. What is NOT blocking

- **M27 / M28** (reports, announcements, SOP KB, Hilo events, recaps, wireframe
  conformance) — shipped, none gate a first onboarding.
- **Stripe live mode** — blocks charging, not onboarding. The rehearsal is
  deliberately a $0 override so the two failures stay distinguishable.
- **The 13 pending prices** — none are touched by a straightforward 1040.
- **Trello import** — waiting on files, blocks nothing client-facing.
- **KBA** — blocks the first *e-file*, not the first *client*.

---

### Known gap in the test story (disclosed, not hidden)

`packages/db` has its own suite (`npm run test:db`) that is **not** part of root
`npm test`, because it asserts pristine *seed* state against the live dev
database. It currently reports 9/10: the one failure is
`ACCT_SEMI_ANNUAL should be flagged needs_confirmation` — which fails precisely
*because you confirmed that price*. The test is asserting a fact that your work
made false. Nothing is broken; the suite needs a fresh-database harness like the
API suite has, and I have not done that rather than quietly delete the
assertion. Root `npm test` remains the reportable number: **285/285**.
