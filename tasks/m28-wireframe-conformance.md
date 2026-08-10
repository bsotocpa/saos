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
| 2 | Pick lane (virtual/in-office, individual/business) | ⛔ **GAP — still open** | `/public/forms/:key` + `/start` + `/submit` are built and tested. **There is no page that renders them.** A prospect has no way to reach the adaptive intake. |
| 3 | Deposit to schedule (Stripe, credits to final invoice) | ⚠️ | Deposit logic is complete — booking deposits, quote deposits, credit-to-final-invoice, and now the override/waiver. Checkout happens through Stripe (stub mode until you flip it). No SAOS-hosted deposit step page, because Stripe Checkout is the page. |
| 4 | Questionnaire (adaptive, 6 of 10, §7216 + SMS consent) | ⛔ **GAP — still open** | Same as step 2 — nine onboarding modules and two form definitions are seeded, the API serves and scores them, and no UI renders them. |
| 5 | Upload docs (replaces Dropbox) | ✅ | `/documents` — upload, encrypted storage, request/needed states, portal-only rule enforced. |
| 6 | Sign 8879 (KBA then sign) | ✅ | `/sign` — envelope statuses, KBA-before-Docuseal gate, method recorded per 8879. |
| 7 | Recap & recurring (recap, to-dos, estimates, cadence) | ⚠️ | `/` has to-dos, estimate due, invoices, checklist, status. **The session RECAP is missing** — see the admin step 3 finding; the module was never built. Recurring cadence is now stored by the configurator but not shown to the client. |
| 8 | If the IRS writes (plain-language notice status) | ✅ **CLOSED this pass** | `irs_notices` and the whole escalation engine exist; `/irs-notices` is staff-only. **The client has no notice view**, so the panel's promise — "no more did-you-get-my-letter calls" — is unmet. |

## Persona 2 — What you see as owner (9 steps)

| # | Wireframe step | Verdict | Where it lives / what's missing |
|---|---|---|---|
| 1 | Command dashboard (active, need-you-today, extended, at-risk) | ✅ | `/` Executive — owner rollup, revenue, health bands, deadlines incl. AG990-IL, operational flows, pipeline, Dubsado readiness. |
| 2 | Referral queue (§7216-gated both directions) | ✅ | `/hilo` → Referral queues, with the disclosure trail enforced by a DB CHECK. |
| 3 | Approve session recaps ("your voice, before it sends") | ⛔ **GAP — missing module** | Meeting intelligence produces summaries and auto-creates tasks, but the **client-facing bilingual recap and its one-tap approval do not exist** — no table, no API, no screen. This is v4.2 NEW MODULES #6, not just a missing page. |
| 4 | Price book & gates (versioned, effective-dated) | ✅ | `/admin/pricing` — versioned, needs-confirmation flags, price-lock. |
| 5 | Team & access (scoped lanes) | ✅ | `/admin/staff` — roles, permissions, attest independence, intern read-only. |
| 6 | Compliance monitor (IL SOS, annual reports, placeholders) | ⚠️ | Every piece runs as a job with tasks and alerts (SOS recheck, T-60 annual reports, the placeholder send-gate). There is no single "compliance monitor" screen; the signals arrive as tasks and Executive counters. Defensible, but not the wireframe's one-glance panel. |
| 7 | AR & rescue (dunning ladder, work pause, stalled) | ⚠️ | Fully built and gated (3 attempts / 5 days, Rene call task, 30-day pause, letter-gated late fees, Day-60 stalled rescue). Visible as A/R aging in `/reports` and counters on Executive; no dedicated AR cockpit. |
| 8 | Vouchering & books close | ⚠️ | Both loops work (status-only vouchering with T-7 reminders; close with the calendar cross-check). Surfaced via tasks and Executive counters; `/hilo` shows pro-bono and funder metrics. No combined screen. |
| 9 | One task system + quotes | ✅ | `/tasks` (+ boards, dependencies, ladder) and `/pipeline` (quote → engagement + deposit, zero re-entry). |

## Persona 3 — What a tax preparer works from (7 steps)

| # | Wireframe step | Verdict | Where it lives / what's missing |
|---|---|---|---|
| 1 | My queue (assigned returns, deadline-sorted, red when late) | ✅ **CLOSED this pass** | `/tasks` is task-shaped, not return-shaped. `GET /tax-engagements?preparerId=&stage=` exists. **A preparer has no returns queue** — the screen the wireframe says they live in. |
| 2 | Client packet ("everything in one place") | ✅ **CLOSED this pass** | `GET /contacts/:id` returns the full picture. **There is no client detail page in the internal app at all** — the single biggest missing surface, and it is the return's front page for this persona. |
| 3 | Prepare in ATX | ➖ | Deliberately external, per the wireframe. Nothing to build. |
| 4 | Upload final return (+ true-up quote) | ✅ | `/upload-return` — category set, client notification, true-up. |
| 5 | Send for 8879 (KBA envelope, live status, 48h chase) | ⚠️ | The signature engine, KBA gate, wet/remote method and entity-group bundling all exist; the preparer triggers it from `/upload-return`. No live status board of their own. |
| 6 | File & log estimate | ⚠️ | Pipeline stages, e-file acceptance and the estimate tracker exist server-side. Estimate logging has no preparer screen. |
| 7 | Rejects & notices (re-queue with clock, notices as tickets) | ⚠️ | Fully built — `rejected` stage, perfection clocks (5 cal / 10 bus), owned fix tasks, notice tickets with the 48h ladder. Reaches the preparer as tasks rather than as the wireframe's queue panel. |

---

## Summary

Before this pass: **8 conform · 9 partial · 5 gaps · 2 not ours**.
After closing three gaps: **11 conform · 9 partial · 2 gaps · 2 not ours**.

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
4. ⛔ **STILL OPEN — Session recaps + approval** (owner step 3, customer step 7).
   A missing MODULE, not a missing page: no table, no API, no screen. Meeting
   intelligence summarises and creates tasks, but nothing drafts a bilingual
   client recap or queues it for your one-tap approval. This is v4.2 NEW MODULES
   #6. Deliberately not rushed at the end of a milestone — it needs a schema, an
   approval gate, an automation toggle, and EN/ES copy you approve.
5. ⛔ **STILL OPEN — Public intake + questionnaire** (customer steps 2 and 4).
   The API is complete and tested (`/public/forms/:key`, nine onboarding modules,
   two form definitions, scoring, §7216 + SMS consent capture) with no renderer.
   It is also the one gap where the build is not the binding constraint: the
   intake collects §7216 consent, and that consent template is still PLACEHOLDER,
   so the flow could not legally run end-to-end today regardless.

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
