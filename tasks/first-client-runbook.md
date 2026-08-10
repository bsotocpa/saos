# First-client runbook

Two documents in one, deliberately:

- **Part A — the dress rehearsal.** Run this against a flagged TEST client. It is
  where we find the surprises.
- **Part B — the real invite.** The click-by-click for the day final legal text
  lands. Every step here is one Part A has already proven.

Part B is written to be *short*. If the day of the real invite involves discovery,
Part A was not finished.

---

## Where things actually stand (verified in production 2026-08-09)

| | State |
|---|---|
| Migrations | 37 |
| Automations armed | **1 of 11** — `attachment_acks` only |
| SES | Production access, 50k/day, us-east-2 |
| Stripe | `STRIPE_MODE=stub` — fail-closed |
| Docuseal | Container up 4+ weeks, **first-boot not done** |
| KBA vendor | `KBA_MODE=sandbox` — blocks remote 8879 only |
| Placeholder templates | **7** — blocks every client-facing send |
| Late-fee disclosure flag | 0 templates — no late fee can be assessed |
| Price confirmations | 13 open (Brian working these now) |
| Portal invitations sent | 0 |

**The rehearsal needs none of those blockers cleared.** That is the point: it
exercises every path that is *not* waiting on legal text, so the day the text
lands there is nothing left to discover.

---

## Test-client safety (built for this, 2026-08-09)

`contacts.is_test` with a required `test_note`. The rule:

> **Excluded from measurement. Visible in operations.**

- **Excluded from:** every report (client counts, revenue, A/R aging, session
  utilization, pipeline conversion), the Executive dashboard (health bands,
  revenue, A/R), health scoring, Hilo funder metrics, the Dubsado retirement
  count — and **every broadcast audience, unconditionally**, so a rehearsal
  client can never receive a real announcement.
- **Still visible in:** contact search, the client packet (which shows a TEST
  CLIENT banner), the preparer queue, the deadline board, tasks, documents,
  quotes, and every send path the rehearsal needs.

Proven by a test that flips the flag on one client touching all of those surfaces
and asserts **every number moves by exactly one**. A test also builds the widest
possible broadcast and confirms the test client gets not even a suppression row —
it is not in the audience at all.

---

# Part A — the dress rehearsal

### A0. What I need from you before I can start

1. **Your personal email address** for the test client. I have not created the
   record, because using `BRIAN@sotoaccounting.com` would be the firm address and
   a verified SES identity — which would prove less than a real external inbox
   does, now that SES is out of the sandbox. Tell me the address and I create the
   flagged record immediately.
2. **Docuseal first-boot** — steps A1 below. This is yours because it means
   setting an admin password, and I do not create accounts or enter credentials.
3. **A decision on the deposit path** — A4 below. Two options, both fine.

Everything else in Part A I can drive.

### A1. Docuseal first-boot — YOURS (~10 min)

1. Open `https://sign.sotoaccounting.com`.
2. Create the admin account. Put the password straight into Vaultwarden.
3. Upload one template: the tax engagement letter (the placeholder is fine for
   the rehearsal — see the watermark note in A5).
4. Add the signature and date fields; name the role `client`.
5. Tell me it is done. I will confirm SAOS can reach it and that
   `DOCUSEAL_MODE=http` is talking to a real instance rather than erroring.

**Rehearsal question this answers:** does an envelope actually reach a real inbox
and come back signed, or does something in the Caddy/Docuseal path break?

### A2. Create the flagged test client — MINE (~1 min)

Once I have the email, I create:
- Contact: `Rehearsal Client`, your personal email, `is_test = true`, note
  explaining what it is, `soto_status = 'lead'`, language EN.
- Nothing else. The rest of the rehearsal creates its own records, which is the
  test.

**Verify with me:** open `/clients/<id>` and confirm the TEST CLIENT banner shows.

### A3. Quote → the client link — MINE, you receive it (~5 min)

1. I build a quote in `/pipeline` from the price book: a 1040 + Schedule C, with
   `DEPOSIT_1040` attached.
2. I send it. **You get a real email** at your personal address with the proposal
   link.
3. You open it on your phone. Check: is the range readable, does the optional
   line make sense, does the Spanish toggle read correctly?

**Rehearsal questions:** does SES deliver to an ordinary inbox (not spam)? Does
the proposal read like something you would send a client?

### A4. Deposit — YOUR DECISION, then MINE (~5 min)

Two paths. Pick one:

- **Option A — Stripe test mode.** You put test keys in `.env.production` and set
  `STRIPE_MODE=test`. Proves the real checkout flow. Requires you to handle keys;
  I will not.
- **Option B — $0 override.** I use the `deposits.override` permission (yours
  alone) to waive the deposit with a reason. Proves the override path, the audit
  trail, and the `deposit_treatment` stamp — but not Stripe.

**My recommendation: Option B for the rehearsal, and leave Stripe for its own
separate test before you charge anyone.** Reason: Stripe live mode blocks
*charging*, not onboarding, so it is not on the critical path to invite #1. Doing
both at once muddies which thing broke.

Either way I accept the quote from the client side and we watch: engagement
created, deposit treatment stamped, Rene's onboarding task raised, pipeline moved
to `deposit_paid` or `onboarding`.

### A5. Intake + questionnaire — MINE to send, YOURS to fill (~10 min)

1. I send you the intake link (`/intake/soto_intake`).
2. **You fill it in as a client would**, on your phone, in Spanish for at least
   one screen.

**⚠ The placeholder watermark.** The §7216 consent text in the intake is still
placeholder. The system already refuses to *send* any placeholder-flagged
template — that gate is in code and fires in every environment. But the intake
*collects* consent, so for the rehearsal I will add a visible banner to the
consent screen reading **"REHEARSAL — this consent text is not final and is not
legally effective."** in both languages, so there is zero chance a rehearsal
consent is ever mistaken for a real one.

I will build that banner as part of the rehearsal (it keys off the template's
`is_placeholder` flag, so it disappears by itself the day you paste final text —
nothing to remember to remove).

**Rehearsal questions:** do the questions read well? Is anything asked that you
would not ask? Does the conditional logic skip what it should?

### A6. Document upload — YOURS (~5 min)

1. From the portal, upload two files (anything — a photo of a receipt is ideal,
   it is what clients actually do).
2. Then **email one to the intake address, and text one** to 708-300-0375.

**What should happen:** the emailed/texted files are accepted, scanned by ClamAV,
quarantined on your client thread, and you get the warm auto-reply pointing at the
portal — because `attachment_acks` is now armed. Then I file them from the unified
inbox with the confirm tap.

**Rehearsal questions:** does ClamAV actually scan (not "skipped")? Does the
auto-reply read right? Does the confirm-tap flow feel like one action?

### A7. A session recap — MINE to draft, YOURS to approve (~5 min)

1. I create a session record for the test client with a summary and action items
   (a real Zoom recording is optional; the recap drafts from the summary).
2. I draft the recap.
3. **You open `/approvals`** and read both language drafts.
4. Arm `session_recaps` in Admin → Automations, then tap **Approve & send**.
5. Check your inbox and the portal thread.

**Rehearsal questions:** is the four-section recap the right shape? Does the
Spanish need work? Is one tap actually enough, or do you want to edit every time?

### A8. The preparer view — MINE (~3 min)

I create a tax engagement for the test client assigned to Ana-Maria, and we look
at `/queue` and `/clients/<id>` as she would. Confirms the packet leads with the
gates and that the queue sorts the way a preparer needs.

### A9. Tear-down decision — YOURS

Keep the test client (flagged forever, harmless, useful for future rehearsals) or
archive it. **My recommendation: keep it.** It costs nothing, it is excluded from
everything measured, and the next time we change the onboarding flow you will want
it. Archiving also works — nothing depends on it.

---

# Part B — the real invite

**B1 and B2 below are already done** — legal package v3 FINAL landed 2026-08-10.
This section now starts at B3. Expect ~15 minutes, not 30.

### B1. ~~Paste the legal text~~ ✅ DONE 2026-08-10

Superseded by v3. There is no longer a list of seven templates to paste, because
there are no longer five engagement letters:

| What v3 loaded | State |
|---|---|
| `engagement_master` — Master Engagement Agreement | ✅ final, late-fee disclosure flag set |
| Schedules A–E (`schedule_a` … `schedule_e`) | ✅ final, mapped to service lines |
| `consent_7216_use`, `consent_7216_disclose` | ✅ final text replaced the placeholders |
| The five old `engagement_letter_*` | retired with a recorded reason (kept for the record) |

The late-fee flag was set only after checking Master §3 (1.5%/month after 30
days) against the `LATE_FEE_MONTHLY` price-book metadata. **The old warning still
stands for any future edit**: never set that flag on a body that lacks the
disclosure block — a false gate is worse than no gate.

What is NOT done, and is not blocking: the Spanish translations. Every v3
template is queued in Admin → Templates ("awaiting your approval"), and Spanish
clients receive the controlling English text until you approve each one.

### B2. ~~Confirm the rehearsal watermark is gone~~ ✅ DONE

`/intake/soto_intake` no longer shows the REHEARSAL banner — it keyed off the
placeholder flag, and the flag is cleared. Worth one glance to confirm after the
deploy; if the banner is there, a flag was missed.

### B3. Upload the Master + Schedules to Docuseal (~5 min) ⛔ YOURS

This is the last real blocker. One template, not five: the Master Agreement plus
the schedules the client's services require. The system tells you which schedules
belong in the packet (`POST /contacts/:id/packet/preview`, shown in the client
packet UI) — you do not have to work it out.

The Master carries one variable, `{{schedules_attached}}`, which the system fills
with the attached schedule list. That sentence is what defines the scope of the
single signature, so leave the field in place.

### B4. Create the real client (~2 min)

`/pipeline` → New quote → search or create the contact. **Leave `is_test` false** —
it defaults false, so this is "do nothing", but confirm the packet shows no TEST
banner before you send anything.

### B5. Quote → send (~3 min)

Build from the price book. Attach the deposit. Send.

*If any line shows ⚠ awaiting confirmation, that price is still unconfirmed — stop
and confirm it in Admin → Pricing first.*

### B6. Let the client drive (~their time)

They accept, fill the intake, upload documents. `attachment_acks` is armed, so a
texted document gets the warm reply automatically.

### B7. Watch these five things

1. `/` Executive → "Needs you today" should show the onboarding task.
2. `/clients/<id>` → the two gates should both go green (§7216, engagement letter).
3. `/queue` → the return appears for whoever you assigned.
4. Their portal → `/messages`, `/documents`, `/notices` all populated correctly.
5. **Their portal `/sign`** → after the Master signature, the §7216 USE consent
   appears benefit-framed with Yes / No thank you. It must NOT appear before the
   signature, and the Hilo DISCLOSE consent must NOT appear at all unless client
   #1 has a Hilo relationship. Both are optional; neither blocks anything.

### B8. Arm the next automations — only after #1 succeeds

In this order, one at a time, per the launch-readiness arming order:

1. `document_chase` — after the first few clients upload successfully
2. `escalation_ladder` — about a week after `document_chase` behaves
3. everything else per `tasks/launch-readiness.md`

`late_fees` is now *armable* — the Master carries the disclosure and the flag is
set. That means arming it will actually assess fees, so arm it when you want fees
assessed, not as housekeeping.

---

## What is NOT on the critical path for invite #1

Worth naming so it does not feel like it is:

- **Stripe live mode** — blocks charging a deposit, not onboarding.
- **KBA vendor** — blocks the *remote* 8879 only. Wet signature works. Not needed
  until the first e-filed return.
- **Schedules B–E** — loaded and live, but only attached if client #1 buys those
  service lines. A tax client #1 needs the Master + Schedule A + the §7216 pair.
- **Spanish translations** — queued for your approval; English controls, so a
  Spanish-speaking client #1 is served correctly today.
- **A Schedule F for attest** — Schedules A–E do not cover CPA review/audit work.
  Packet assembly refuses attest by name, so nothing can go out wrong; ask your
  attorney when convenient.
- **Trello import** — the importer is built and idempotent; it just has nothing to
  import until the JSONs land.
- **10 of 11 automations** — deliberately off.

---

## Answered (2026-08-10)

1. **Test client email** → `brian3712@gmail.com`.
2. **Deposit path** → **$0 override** using `deposits.override` (CEO-only), so a
   Stripe failure can never be mistaken for a legal-text failure. Stripe live is a
   separate later test.
3. **After the rehearsal** → keep the test client. It is excluded from every
   measured number and visible in every operational surface, which is exactly what
   you want the next time the onboarding flow changes.
4. **Docuseal first-boot** → yours (it means setting an admin password). In
   progress.
