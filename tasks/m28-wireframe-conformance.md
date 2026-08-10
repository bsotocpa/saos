# M28 — Wireframe conformance pass

Every step in `docs/SAOS_Wireframes.html` (v4.2, 24 steps across three personas)
checked against what is actually built and deployed. Verdicts are from reading the
routes and the API surface, not from memory.

**Verdict key**
- ✅ **Conforms** — the screen exists and does what the wireframe panel promises.
- ⚠️ **Partial** — the capability exists but not where the persona expects it, or
  the surface is thinner than the panel.
- ⛔ **Gap** — the persona cannot complete this step.
- ➖ **Not ours** — the wireframe panel is an external system or a marketing page.

---

## Persona 1 — What a customer experiences (8 steps)

| # | Wireframe step | Verdict | Where it lives / what's missing |
|---|---|---|---|
| 1 | Discover & book (two-lane, EN/ES, "starting at") | ➖ / ⚠️ | The public marketing site is not SAOS. The booking engine IS ours (Cal.com two-lane, deposit at booking, Zoom-only enforcement, unmapped-event tasks) and works — but a client's entry point is a Cal.com page, not a SAOS screen. Nothing to build; noting it so the seam is explicit. |
| 2 | Pick lane (virtual/in-office, individual/business) | ✅ **CLOSED this pass** | `/intake/[key]` in the portal renders the definition — screens, conditional fields, every field type, save-as-you-go. Was: API complete and tested, nothing rendering it. |
| 3 | Deposit to schedule (Stripe, credits to final invoice) | ⚠️ | Deposit logic is complete — booking deposits, quote deposits, credit-to-final-invoice, and now the override/waiver. Checkout happens through Stripe (stub mode until you flip it). No SAOS-hosted deposit step page, because Stripe Checkout is the page. |
| 4 | Questionnaire (adaptive, 6 of 10, §7216 + SMS consent) | ✅ **CLOSED this pass** | Same renderer as step 2. Definition v2 adds bilingual question text as DATA (v1 had none), the TCPA disclosure shows at the point of consent, and demographics are never required. |
| 5 | Upload docs (replaces Dropbox) | ✅ | `/documents` — upload, encrypted storage, request/needed states, portal-only rule enforced. |
| 6 | Sign 8879 (KBA then sign) | ✅ | `/sign` — envelope statuses, KBA-before-Docuseal gate, method recorded per 8879. |
| 7 | Recap & recurring (recap, to-dos, estimates, cadence) | ✅ **CLOSED this pass** | Recaps now post to the client’s portal thread (`/messages`) on approval, alongside the existing to-dos, estimate due and invoices on `/`. |
| 8 | If the IRS writes (plain-language notice status) | ✅ **CLOSED this pass** | Portal `/notices`, EN/ES. Internal stages collapse to three client-meaningful states; handler, service tier and resolution notes are withheld. |

## Persona 2 — What you see as owner (9 steps)

| # | Wireframe step | Verdict | Where it lives / what's missing |
|---|---|---|---|
| 1 | Command dashboard (active, need-you-today, extended, at-risk) | ✅ | `/` Executive — owner rollup, revenue, health bands, deadlines incl. AG990-IL, operational flows, pipeline, Dubsado readiness. |
| 2 | Referral queue (§7216-gated both directions) | ✅ | `/hilo` → Referral queues, with the disclosure trail enforced by a DB CHECK. |
| 3 | Approve session recaps ("your voice, before it sends") | ✅ **CLOSED this pass** | `/approvals` — one tap approves and sends; CHECKs make an unapproved send impossible. Automation #11, ships OFF. |
| 4 | Price book & gates (versioned, effective-dated) | ✅ | `/admin/pricing` — versioned, needs-confirmation flags, price-lock. |
| 5 | Team & access (scoped lanes) | ✅ | `/admin/staff` — roles, permissions, attest independence, intern read-only. |
| 6 | Compliance monitor (IL SOS, annual reports, placeholders) | ⚠️ | Every piece runs as a job with tasks and alerts (SOS recheck, T-60 annual reports, the placeholder send-gate). There is no single "compliance monitor" screen; the signals arrive as tasks and Executive counters. Defensible, but not the wireframe's one-glance panel. |
| 7 | AR & rescue (dunning ladder, work pause, stalled) | ⚠️ | Fully built and gated (3 attempts / 5 days, Rene call task, 30-day pause, letter-gated late fees, Day-60 stalled rescue). Visible as A/R aging in `/reports` and counters on Executive; no dedicated AR cockpit. |
| 8 | Vouchering & books close | ⚠️ | Both loops work (status-only vouchering with T-7 reminders; close with the calendar cross-check). Surfaced via tasks and Executive counters; `/hilo` shows pro-bono and funder metrics. No combined screen. |
| 9 | One task system + quotes | ✅ | `/tasks` (+ boards, dependencies, ladder) and `/pipeline` (quote → engagement + deposit, zero re-entry). |

## Persona 3 — What a tax preparer works from (7 steps)

| # | Wireframe step | Verdict | Where it lives / what's missing |
|---|---|---|---|
| 1 | My queue (assigned returns, deadline-sorted, red when late) | ✅ **CLOSED this pass** | `/queue` — deadline-first, rejects pinned above everything, scoped to the preparer, at-risk from the shared extension setting. |
| 2 | Client packet ("everything in one place") | ✅ **CLOSED this pass** | `/clients/[id]` — gates first (§7216, engagement letter), then contact, businesses, documents (audited list), quotes, and this client's returns. |
| 3 | Prepare in ATX | ➖ | Deliberately external, per the wireframe. Nothing to build. |
| 4 | Upload final return (+ true-up quote) | ✅ | `/upload-return` — category set, client notification, true-up. |
| 5 | Send for 8879 (KBA envelope, live status, 48h chase) | ⚠️ | The signature engine, KBA gate, wet/remote method and entity-group bundling all exist; the preparer triggers it from `/upload-return`. No live status board of their own. |
| 6 | File & log estimate | ⚠️ | Pipeline stages, e-file acceptance and the estimate tracker exist server-side. Estimate logging has no preparer screen. |
| 7 | Rejects & notices (re-queue with clock, notices as tickets) | ⚠️ | Fully built — `rejected` stage, perfection clocks (5 cal / 10 bus), owned fix tasks, notice tickets with the 48h ladder. Reaches the preparer as tasks rather than as the wireframe's queue panel. |

---

## Summary

Before this pass: **8 conform · 9 partial · 5 gaps · 2 not ours**.
After closing ALL FIVE gaps: **13 conform · 9 partial · 0 gaps · 2 not ours**.

**Brian ruled on the nine partials (2026-08-09): do not build dedicated cockpits.**
Signals-as-tasks is the design, per the one-task-system rule; a screen gets added
only if real use shows a gap. That closes the conformance question — the nine
partials are now decisions, not debt.

### The five gaps, in the order they block someone

1. ✅ **CLOSED — Client packet** (preparer step 2). `/clients/[id]` in ops. Leads
   with the two gates that decide whether work can be delivered (§7216 consent,
   signed engagement letter), then contact, businesses with IL SOS state,
   documents, quotes, and this client's returns. Returns and documents are both
   scoped to the one client — the returns list gained a `contactId` filter and the
   document list is a NEW endpoint that writes an audit row, because CLAUDE.md
   counts listing client documents as an access.
2. ✅ **CLOSED — Preparer queue** (preparer step 1). `/queue` + `GET /my-queue`.
   Deadline-first with **rejects pinned to the top**, because the perfection-period
   clock is shorter than any filing deadline and disappears in a plain deadline
   sort. Scoped: a preparer passing another preparer's id gets their OWN queue
   back, not an error. At-risk reads the SAME `extension.at_risk_no_docs_by`
   setting as the extension board, so the two screens cannot disagree about
   "late".
3. ✅ **CLOSED — Client notice view** (customer step 8). `/notices` in the portal,
   EN/ES. Internal stages collapse to three client-meaningful states, and the
   handler, service tier, escalation rung and resolution notes are all withheld —
   asserted by a test that greps the response body for each.
4. ✅ **CLOSED — Session recaps + approval** (owner step 3, customer step 7).
   Migration 0036 finished the shape an early scaffold had left behind (the recap
   columns existed on `meeting_summaries`; nothing ever wrote them) and made the
   gate STRUCTURAL: CHECKs mean no code path — including a direct UPDATE — can
   produce a recap that reached a client without a named approver, a send
   timestamp, or copy in both languages. `/approvals` is the one-tap screen.
   Drafted from what the session actually produced: decisions → what we covered,
   client-owned items plus client-visible tasks → their action items, staff items →
   ours, a real booking → next session (never invented). Editing an approved recap
   WITHDRAWS the approval, so your name never stays on text you have not re-read.
   Registered as automation #11, ships OFF, and the UI states the send is disarmed
   BEFORE the tap so approving never silently does nothing.
5. ✅ **CLOSED — Public intake + questionnaire** (customer steps 2 and 4).
   `/intake/[key]` renders the definition: screens, conditional fields,
   conditionally-required fields, every field type, save-as-you-go with the resume
   token, per-field server validation, and the language answer switching the whole
   form. The definition had NO field labels (v1 was structure only, because nothing
   rendered it), so v2 adds bilingual question text AS DATA — Brian edits wording
   without a deploy. The TCPA disclosure renders at the point of consent, and
   demographic questions are never required and say why they are asked. Legal text
   is in attorney review; pasting it into Admin → Templates is now the only
   remaining step.

### On the nine partials

These are mostly the same trade: the capability is real and enforced server-side,
but the wireframe drew a dedicated cockpit and the signal instead arrives as a
task, an alert, or a dashboard counter. That is not automatically wrong — CLAUDE.md
requires every work item to BE a task, and a second surface listing the same work
is how two sources of truth start. Worth your call per panel rather than mine:
building an AR cockpit and a compliance monitor that merely re-list existing tasks
would add screens without adding capability.

The partials I would NOT leave alone are inside the gaps above (the recap on the
client's home page, and the preparer's own view of signature status once the queue
exists).
