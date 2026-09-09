# First-client runbook

Two documents in one, deliberately:

- **Part A — the dress rehearsal.** Run this against a flagged TEST client. It is
  where we find the surprises.
- **Part B — the real invite.** The click-by-click for the day final legal text
  lands. Every step here is one Part A has already proven.

Part B is written to be *short*. If the day of the real invite involves discovery,
Part A was not finished.

---

## Where things actually stand (verified in production 2026-08-10, post-deploy)

| | State |
|---|---|
| Migrations | **38** — 0038 deployed |
| Legal text | ✅ **0 active placeholders**. Master + Schedules A–E + both §7216 consents live |
| Late-fee disclosure flag | ✅ on `engagement_master` |
| Automations armed | **1 of 11** — `attachment_acks` only |
| SES | Production access, 50k/day, us-east-2 |
| Docuseal | First-boot ✅ done. **API token not yet in SAOS `.env`** → `GET /api/templates` returns 401 |
| Stripe | `STRIPE_MODE=stub` — fail-closed. Rehearsal deliberately avoids it |
| KBA vendor | `KBA_MODE=sandbox` — blocks remote 8879 only |
| Price confirmations | 13 open — **none touched by a 1040 + Schedule C** (verified) |
| Rehearsal test client | ✅ created, `is_test = true` |
| Portal invitations sent | 0 |

**One blocker remains for the signature step**: the Docuseal API token. Everything
else in the rehearsal is unblocked.

## Who clicks what, and why it is not all me

The runbook originally marked the quote and deposit steps "MINE". That was written
before `deposits.override` existed as a CEO-only permission, and it is wrong for a
reason worth keeping:

**Production has exactly one staff account — Brian's.** Every staff-attributed
write stamps `created_by_staff_id` and an audit row with that identity. For me to
build the quote or apply the $0 override, I would have to act as Brian — which
would put his name on decisions he did not make, and would hollow out the very
control he asked for when he scoped `deposits.override` to himself alone.

So the split is:

| | Who | Why |
|---|---|---|
| Test client, verification, diagnosis, tear-down | me | legitimately system actions; audited as `system` |
| Quote build, quote send, deposit override, recap approval | **Brian** | the schema attributes these to a named person, and that person is him |
| Playing the client (intake, upload, signing) | **Brian** | it is his inbox |
| Docuseal token, Stripe keys, passwords | **Brian** | credentials are never mine |

I verify after every step and report what the database actually recorded.

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

### A0. ✅ Answered

1. **Test client email** → `brian3712@gmail.com`, via the `+rehearsal` alias (see A2).
2. **Docuseal first-boot** → done 2026-08-10. One step remains: A1b below.
3. **Deposit path** → $0 override.

### A1. Docuseal first-boot — ✅ DONE 2026-08-10

Admin created, template uploaded with signature and date fields.

### A1b. Paste the Docuseal API token into SAOS — YOURS (~2 min) ⛔

**This is the only thing blocking the signature step.** Diagnosed precisely:

| Check | Result |
|---|---|
| SAOS → Docuseal network | ✅ `GET http://docuseal:3000/` → **200** |
| SAOS → Docuseal API auth | ⛔ `GET /api/templates` → **401 `{"error":"Not authenticated"}"` |
| `DOCUSEAL_API_TOKEN` as the app sees it | **empty (length 0)** |

So the container is up and reachable and the app is in real `http` mode — it just
has no credential. In Docuseal: **Settings → API**, copy the token. Then on the
server:

```powershell
ssh -i ~/.ssh/saos_hetzner_ed25519 "root@$saos"
```

(`$saos` is set by the one-liner in tasks/launch-readiness.md → **Connecting to the server**.
The bash `$(sed …)` form fails silently in PowerShell and looks like the server is refusing you.)

Edit `/opt/saos/.env`, set `DOCUSEAL_API_TOKEN=<the token>`, then:

```bash
cd /opt/saos && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d api
```

Tell me when it is in and I will re-run the same three checks plus list the
template you uploaded and confirm its fields, before anything is sent.

I am not doing this one because the token is a credential behind your admin login.

**Rehearsal question this answers:** does an envelope actually reach a real inbox
and come back signed, or does something in the Caddy/Docuseal path break?

### A2. Flagged test client — ✅ DONE 2026-08-10 (mine)

`Rehearsal Client` · `brian3712+rehearsal@gmail.com` · `is_test = true` ·
id `788f2add-3305-4cd7-ad13-841c96513d7c`

**Why the `+rehearsal` alias and not the bare address:** `brian3712@gmail.com`
already exists in production as a real migrated record — *Brian Soto, lead*, with
a task and a business link attached. Flagging that record `is_test` would pull a
genuine record out of every measured number and hang rehearsal invoices off it.
The alias delivers to the same inbox and leaves that record untouched.

Verified: production `is_test` count = 1, active client count still **426** — the
rehearsal client is invisible to measurement exactly as designed.

*Separate small decision for you, not blocking:* your own personal lead record
(`brian3712@gmail.com`) is sitting in the CRM as a lead. Archive it, merge it, or
leave it — your call.

### A3. Quote → the client link — YOURS to click, ~2 min (I pre-flighted it)

Pre-flight against the live price book (v5, in force since 2026-08-16), read-only,
re-checked 2026-09-09 so there are no surprises:

| Line | Price | Deposit carried | Confirmed? |
|---|---|---|---|
| `IND_BASE_MFJ` | $250.00 | $200.00 | ✅ |
| `IND_BASE_SINGLE` | $200.00 | $200.00 | ✅ |
| `IND_SCH_C` | $180.00 / form | none | ✅ |

So an MFJ + Schedule C quote asks the client for a **$200.00 deposit** — the MFJ
line's — and the builder will show exactly that.

**A 1040 + Schedule C quote touches zero unconfirmed prices** — so none of your 13
open confirmations block client #1.

**The deposit is not a line you attach.** Since price book v4 (2026-08-14) each
item carries its own deposit; the quote's deposit is the sum, and the builder shows
it read-only under **"Deposit the client will be asked for"** as you add lines. The
figure there is what the proposal shows the client and what acceptance invoices —
one number, three places. (The old `DEPOSIT_1040` / `DEPOSIT_BUSINESS_TAX` items
are retired; a dropdown that offered only "— no deposit —" was their ghost, fixed
2026-09-09.)

The clicks: `/pipeline` → **New quote** → search `Rehearsal Client` → add
`IND_BASE_MFJ` + `IND_SCH_C` → read the deposit line → **Create and send**.

*If the client already has an accepted quote on the same schedule, the send stops
and asks whether this **adds to** or **replaces** the existing agreement. Pick one
— the answer is stored on the quote. For the rehearsal, "adds to" is right.*

**You then get a real email** at your personal inbox with the proposal link. Open
it on your phone: is the total readable, does the optional line make sense, does
the Spanish toggle read correctly?

**Rehearsal questions:** does SES deliver to an ordinary Gmail inbox (not spam)?
Does the proposal read like something you would actually send?

### A4. Deposit — YOUR DECISION, then MINE (~5 min)

Two paths. Pick one:

- **Option A — Stripe test mode.** You put test keys in `.env.production` and set
  `STRIPE_MODE=test`. Proves the real checkout flow. Requires you to handle keys;
  I will not.
- **Option B — $0 override.** ✅ **CHOSEN.** Stripe live stays a separate later
  test so a payment failure can never be confused with a legal-text failure.

**This one is yours to click, and by design.** `deposits.override` is
explicit-only — the `'*'` wildcard does not confer it, precisely so that "Brian
only" is expressible. If I applied the override using your identity, the audit row
would name you for a decision you did not make, and the control would be
decorative. In `/pipeline`: **Save as draft**, then on the "Draft saved" panel use
**Reduce deposit…** or **Waive deposit…** — an inline form (amount, reason of 10+
characters, **Apply**). The panel then shows the deposit *as the server holds it*, the
send button reads "Send to client — deposit $X (reduced from $Y)", and the sent
confirmation repeats it. If you do not see the reduced figure on the send button, it
did not take — the error is in the panel, next to the button.

*(2026-09-09: the previous control was two browser prompts whose errors rendered at the
top of the page. Brian reduced a deposit to a small amount, the reason was too short or
the prompt was cancelled, the panel kept saying what he had entered, and the client was
invoiced the standard amount. Nothing about a deposit on this screen is the builder's
memory any more; it is all read back from the API.)*

The reason string matters — it is stored and it is what AR reporting reads later.
Something like `Dress rehearsal — no payment collected` is honest and useful.

Then **you accept the quote from the client side** (the link in your inbox) and I
verify: engagement created, `deposit_treatment` stamped as waived, onboarding task
raised, pipeline moved to `onboarding`, and the override row carrying amount,
approver, reason, and timestamp.

### A4b. The payment leg — as it actually runs (proven 2026-09-09 02:57 UTC)

What happens after **Accept**, in order, with the clock that governs each step:

1. **Acceptance commits** — engagement(s), the deposit invoice (draft), the "Start
   onboarding" task, and an outbox row saying "email this invoice", all in one
   transaction. The screen says the invoice arrives "within a few minutes."
2. **The outbox fast lane** performs it within **60 seconds** (`OUTBOX_SWEEP_MS`, frozen
   by a test). Until 2026-09-09 this ran only on the 15-minute tick — the rehearsal
   acceptance landed eleven seconds after a tick and waited the full quarter hour.
3. **The email** is `invoice_sent`: "Invoice SA-2026-NNNN — $X" with a link to
   `portal/invoices?invoice=<id>`. The invoice flips to `sent` only when the message
   actually went.
4. **The link needs a portal session.** Signed out, it lands on `/login` (the query is
   dropped) — request the magic link, sign in, click **Invoices**, the deposit is there.
   The rehearsal contact already has portal access; **a brand-new lead does not** —
   see the open question below.
5. **Pay** → Stripe Checkout (live keys since tonight) → webhook or the every-tick
   reconcile settles it → the deposit becomes a credit on the invoice that follows
   (`deposit-credit.ts`).

**Open question for Brian (not blocking the rehearsal):** `ensurePortalUser` is called
by intake and by staff, never by acceptance. A genuinely new lead who accepts a quote gets
a deposit-invoice email whose link leads to a sign-in they cannot complete until staff run
onboarding. The spec says a quote converts to a deposit checkout "without re-entry." My
recommendation: acceptance ensures the portal user inside its transaction (a sent quote
always has an email), so the invoice link works the moment it arrives. It changes one
door — the portal account would exist before the onboarding task is worked — so it is
your call, not mine.

### A5. Intake + questionnaire — MINE to send, YOURS to fill (~10 min)

1. I send you the intake link (`/intake/soto_intake`).
2. **You fill it in as a client would**, on your phone, in Spanish for at least
   one screen.

**The placeholder watermark is now GONE, and that is correct.** It keyed off
`is_placeholder`, and the v3 text is final — so the intake you fill will carry the
real §7216 language, not a watermarked draft. Two consequences worth naming:

- Nothing about the rehearsal is legally ambiguous any more: the consent you give
  as the test client is a real consent, on a record flagged `is_test`, which is
  yours. That is fine, and it is more faithful to what client #1 will see.
- The banner mechanism still works and is still tested — flag a consent template
  and it returns. It is the protection for any future round of legal review.

**Note on ordering (new in v3):** the §7216 consents are no longer part of the
intake screens. They are presented in the portal **after** the Master signature,
because a consent handed over alongside the document you must sign to be served is
the conditioning §7216 prohibits. So A5 tests the intake questions; the consents
appear at A5b once the Master is signed.

### A5b. §7216 consents in the portal — YOURS to answer (~2 min, after signing)

Open the portal → **Sign**. After the Master signature you should see exactly one
offer: the **USE** consent, benefit-framed ("Want us to look for savings you have
not asked about?"), with *Yes, you have my permission* / *No, thank you*.

What must be true, and what I will verify in the database straight after:

- The **DISCLOSE** consent must **not** appear — the rehearsal client has no Hilo
  relationship, so there is nothing that disclosure would serve.
- Nothing should have been offered *before* the signature.
- Whichever you answer is recorded with the policy version you read
  (`v3-t<n>`), method `portal_checkbox`, and a decline is never re-asked.

Try answering **No** on purpose if you want to see the decline path — it will not
revoke anything and it will not ask again.

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

### A6b. The Master packet — YOURS to send and sign (~5 min, needs A1b)

Once the Docuseal token is in:

1. `/clients/<id>` → the packet panel shows which schedules the system resolved.
   For a tax client with no return type on file yet, that is **Schedule A** alone.
2. Send the packet. One envelope: Master + Schedule A.
3. **Sign it from your inbox** as the client.

What I verify immediately after: `engagement_packets` goes to `signed`, one
`schedule_acceptances` row for A with `via = 'master_signature'` pointing at that
packet, `contacts.engagement_letter_status = 'signed'`, and
`late_fee_disclosure_signed_at` stamped — because the Master carries the
disclosure. Then the §7216 USE consent should appear in the portal (A5b).

**Rehearsal question:** does the packet PDF actually contain the Master *and* the
schedule, with the attached-schedule sentence filled in — or does Docuseal send
only the one template you uploaded? This is the single most likely surprise in the
whole rehearsal, and it is why the signature step exists.

### A7. A session recap — MINE to draft, YOURS to approve (~5 min)

1. I create a session record for the test client with a summary and action items
   (a real Zoom recording is optional; the recap drafts from the summary).
2. I draft the recap. *(Drafting is `meetings.read`, so this one genuinely is mine
   — but if the draft has to be attributed to you, you will see it and can say so.)*
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

Build from the price book. The deposit sums itself from the lines — read it under
"Deposit the client will be asked for" before you send; that is the figure the
client sees on the proposal and is invoiced for at acceptance. Send.

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
