# SAOS Launch Readiness — every gate between today and the first real client

Updated 2026-08-10 (legal package v3 **DEPLOYED** — blockers 1.1 and 1.2 CLEARED
in production). Generated from the **live production database**, not from memory.
Counts here are queried, not estimated; where I state a number, the query is
named so you can re-run it.

**Definition of launched**: one real client receives a portal invitation, signs
the Master Engagement Agreement, and uploads a real document. Everything below
either blocks that or must be deliberately decided before it.

---

## The short version

**One thing is on the critical path, and it is a two-minute paste: the Docuseal
API token.**

Everything legal is live in production. Docuseal's own first-boot is done. SAOS
reaches the Docuseal container (HTTP 200) but its API returns **401 Not
authenticated** because `DOCUSEAL_API_TOKEN` is empty — so no envelope can be
created yet.

| Gate | State |
|---|---|
| Legal text (Master + Schedules A–E + both §7216 consents) | ✅ **CLEARED in production** — 0 active placeholders |
| Late-fee disclosure flag | ✅ **CLEARED** — on `engagement_master`, verified against the price book |
| Migration 0038 + legal v3 seed | ✅ **DEPLOYED 2026-08-10** — 38 migrations, health ok, portal + ops 200 |
| SES production access | ✅ 50k/day, us-east-2 |
| Docuseal first-boot | ✅ done — admin created, template uploaded with signature/date fields |
| **Docuseal API token in SAOS** | ⛔ **empty.** Settings → API → paste into `/opt/saos/.env`, restart `api`. Yours: it is a credential |
| Price confirmations | ⚠ 13 remain — **none touched by a 1040 + Schedule C** (verified against the live price book) |
| Rehearsal test client | ✅ created, flagged, invisible to measurement (active count still 426) |
| Invite client #1 | ⛔ the trigger itself — `portal_users` → **0** |

---

## 1. The hard blockers

### 1.1 Legal text ✅ CLEARED IN PRODUCTION 2026-08-10

`SELECT count(*) FROM templates WHERE is_placeholder AND is_active` → **0**
`SELECT count(*) FROM pgmigrations` → **38**

All 8 v3 templates live (`engagement_master`, `schedule_a_individual_tax` …
`schedule_e_entity`, both consents), all 5 old letters retired with a reason, all
5 schedules mapped to their service lines.

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

### 1.2 Late-fee disclosure flag ✅ CLEARED IN PRODUCTION

`SELECT key FROM templates WHERE has_late_fee_disclosure AND is_active` →
**`engagement_master`**

Before flipping it I checked the actual numbers against the price book rather
than trusting the heading: Master §3 says **1.5% per month (18% APR) after 30
days**, and the `LATE_FEE_MONTHLY` price-book metadata says
`{"grace_days": 30, "monthly_rate_percent": 1.5}`. They match, so the flag is
true. Had they disagreed I would have left it false and asked — a flag set on
text that says something different is a false gate, which is worse than no gate.

Consequence: `late_fees` is now *armable* — structurally possible for the first
time. It is still seeded OFF and stays off until you arm it.

### 1.3 Price confirmations: 13 remain ⚠ (not a blocker for client #1)

`SELECT item_code FROM price_book_items WHERE needs_confirmation AND version in force`
→ **13 rows** (live production, post-deploy). `ACCT_SEMI_ANNUAL` is settled at your
$1,000 ruling.

**A landmine was found and defused before this deploy**: the price-book seed
assigned `needs_confirmation = EXCLUDED.needs_confirmation` on every re-seed. Since
production runs the seed on every deploy and has only v1, any price you confirmed in
Admin → Pricing would have had its ⚠ badge silently restored on the next deploy —
your decision reverted, with nothing in the trail to say so. Fixed before deploying,
and pinned by a test that confirms a price, re-seeds, and asserts it stays confirmed.
Verified live: the count held at 13 across the deploy instead of bouncing to 14.

Verified against the live price book — **a 1040 + Schedule C quote touches none of
these**: `IND_BASE_MFJ` $200 ✅, `IND_BASE_SINGLE` $150 ✅, `IND_SCH_C` $180/form ✅,
`DEPOSIT_1040` $250 ✅. `DEPOSIT_BUSINESS_TAX` $300 is still ⚠ but only binds for a
business client.

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
| **Docuseal** | ⚠ First-boot ✅ done; container reachable from SAOS (200); API **401** | ⛔ **`DOCUSEAL_API_TOKEN` is empty in `/opt/saos/.env`.** Settings → API → paste → restart `api`. Yours: a credential behind your admin login |
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
| Test clients | ✅ `contacts WHERE is_test` → **1** — the rehearsal client, `brian3712+rehearsal@gmail.com` |
| Engagement packets | `engagement_packets` → **0**, `schedule_acceptances` → **0**. Nothing papered yet |

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
| ~~**Deploy 0038 + legal v3**~~ | ✅ **DEPLOYED 2026-08-10** | 38 migrations, 0 active placeholders, late-fee flag on the Master, 13 price confirmations preserved |
| **First-cohort size** | Invitations are irreversible in practice | 5–10 friendly clients, not 300. The migrated-onboarding sequence is staged and sends nothing until you say so |
| **Attest Schedule F** | Schedules A–E don't cover CPA review/audit work | ✅ You are requesting it from the attorney. Assembly refuses attest by name until then, as agreed — nothing can go out wrong meanwhile |
| **Your own lead record** | Not blocking | `brian3712@gmail.com` sits in the CRM as a real migrated lead (1 task, 1 business link). I left it alone and used a `+rehearsal` alias instead. Archive, merge, or leave it |
| **KBA vendor** | $1–3/signature; blocks remote 8879 | Before tax season, not before launch |

---

## 8. Shortest path to client #1

1. ~~Deploy 0038 + legal v3 seed~~ ✅ **done 2026-08-10**.
2. ~~Docuseal first-boot~~ ✅ **done** — admin created, template uploaded.
3. **Paste the Docuseal API token** into `/opt/saos/.env` and restart `api`.
   ⛔ Yours, ~2 minutes. This is the only thing blocking a signature.
4. **Rehearsal** against the flagged test client. Split by attribution, not by
   preference: I drive the system-actor steps and verify every result; you click
   the four things the schema records under your name (quote build, quote send,
   $0 deposit override, recap approval) and play the client from your inbox.
   Full click list in `tasks/first-client-runbook.md`.
5. **Fix whatever the rehearsal exposes.** That is what it is for. My bet on the
   most likely surprise: whether the Docuseal envelope actually carries the Master
   *and* the schedule, or only the single template you uploaded.
6. **Invite client #1**, watch it end to end, then arm automations 2–3 and widen.

**Step 3 is the one thing standing between you and a signature.** Everything else
is either done or waiting on it.

### Why some rehearsal steps are yours

Production has exactly one staff account — yours. Every staff-attributed write
stamps `created_by_staff_id` plus an audit row with that identity. For me to build
the quote or apply the $0 deposit override, I would have to act as you: your name
on decisions you did not make, and `deposits.override` — which you deliberately
scoped to yourself alone — reduced to decoration. So those clicks are yours, and I
verify what the database recorded immediately after each one.

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

### Test story

Root `npm test`: **285/285**. `packages/db` (`npm run test:db`): **12/12**, up from
9/10 — the `ACCT_SEMI_ANNUAL` assertion was not deleted, it moved: the item leaves
the "still flagged" list and gains a test asserting it is seeded at your ruled
$1,000, unflagged, with no leftover conflict note. So a future edit quietly moving
it back to a sheet value now fails. Two more tests were added there: one pinning
the late-fee flag to exactly one active template, one proving a re-seed cannot
un-confirm a price.

Still true and still worth saying every time: `test:db` runs against the live dev
database and is **not** part of root `npm test`, so root remains the reportable
number.
