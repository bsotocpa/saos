# TODO — 2026-09-09 morning batch (Brian's rulings). One commit per item; suite + one sabotage per run; red blocks deploy.

FIRST — walk failures
- [x] A. SA-2026-0003 paid again: prove writer; state-machine trigger (refunded→paid illegal w/o payment; void terminal; paid→refunded only via refund row; reconcile touches sent/overdue only); sabotage: trigger detached; nightly Stripe drift check → task; lessons instance.
- [x] B. DATE vs TIMESTAMPTZ: DATE columns serialized as calendar dates at the driver (pg 1082 parser), helper typed; enumerate DATE columns + render sites; pausedDays arithmetic; test ended >= started; guard.
- [x] C. Decision-1 corrected sequence: withdraw ef90aabc (route), period 2025 on 6e474b1f + BRIAN S. test row + Brian S. real row (list before/after), transfer SA-2026-0001 → 6e474b1f.
- [x] D. Mobile overflow: stack void metadata on narrow viewports; send-log rows wrap; 390px walk.
- [x] E. Portal shows void invoices: Cancelled/Anulada, sorted last, no pay action.
- [x] F. Engagement order: active, on_hold, closed; newest first within group.

DECISIONS
- [x] 2. Tax year shown in builder, printed on the quote, in the engagement title; test asserts all three.
- [x] 3. Void reverses issuance completely (symmetric with issue); field diff test; fix 6e474b1f via route; lessons instance.
- [x] 5. SOP seeds: reviewed_at NULL → overwrite; else refuse + diff; dispute SOP on the box confirmed.
- [x] 6. pausedDays clock bug: root-cause in production code; list affected on_hold engagements; freeze clock in spec.

NEW
- [x] 7. Stranded deposits: withdraw refuses w/ paid unapplied deposit unless superseding or actor selects refund (billing task); transfer route (billing.manage, audit both); move 0001 → 6e474b1f; query of invoices on non-active engagements.
- [x] 8. Outbox double-send audit (attempts > 1), grouped by contact; protected names flagged.
- [x] 9. Ungated send sites: list 13 by module:function/template/recipient class; gate client-reachable; staff-only get a recipient test; guard fails on new ungated client sites.
- [x] 10. Signature failures log livemode + endpoint id.
- [x] 11. Actor display: name, never email (audit, invoice, engagement rows).
- [x] PLAN: Playwright rendered-output harness (one page).

## Review — 2026-09-09 evening (all rulings shipped; 14 commits f833c1b…393e015)
- Every item above shipped with its own commit, a green full suite (609 api / 12 ops / 3 portal at the end) and one sabotage that bit. Exception recorded honestly: decision 2's sabotage script failed on a heredoc backslash and the commit went out first; the sabotage was run right after (2 of 2 red, restored green).
- DECISION-PENDING: period 2025 on 6e474b1f refused by the index — abb43fc6 (Rehearsal Client 2, created 22:58 UTC by a quote acceptance) already holds tax/2025. Nothing withdrawn without a ruling.
- DECISION-PENDING: client (portal) actor labels still carry the client's email; a portal session has no display name.
- NOT DONE: STRIPE_WEBHOOK_ENDPOINT_ID on the box — the write needs the live key in a shell and was refused by the tool policy; the audit row says "unconfigured" until the installer runs or Brian sets it.
- Brian arms in Admin → Automations: payment_receipt, refund_receipt, void_notice (shipped OFF per CLAUDE.md; receipts and cancellation notices are HELD until armed).
- Next overnight: tasks/next-overnight-plan.md (plan only).

## Evening batch — 2026-09-09 (Brian's evening rulings; all shipped, one commit per item)
- [x] 0. DATE consumer audit: calendarDay(), guard rule, date-consumers.spec (8 tests on both sides of today), production check clean (5819fb3)
- [x] 5. Drafts are not payable; filing and acceptance issue in their own transaction (931d4ed)
- [x] 1. Withdrawal voids attached sent/overdue invoices, deletes drafts; DB invariant 0085; abb43fc6 withdrawn, 6e474b1f = tax/2025 with the $250 deposit (976ac35)
- [x] 2. Client actors by display name (5522d76)
- [x] 3. Held count on the automation row; arming replays nothing; NOT armed (73e0628)
- [x] 4. Installer idempotent; STRIPE_WEBHOOK_ENDPOINT_ID server-managed (755baa9)
- [x] 12. Zero native dialogs; one in-app modal; guard (4b8707e)
- [x] 13. Builder chips / sticky summary / tax-year select (6d28e26)
- [x] 14. One link per invoice — sent by email or text, never printed (7368078)
- [x] Audit 1, 3, 5, 11, 12, 6, 7, 8, 9, 10 (7ac18e2 … 40f9d83); audit 2 and 4 were done earlier
- DECISION-PENDING: completing an engagement with an unpaid invoice stays allowed (the collection tail) — the 0085 invariant covers withdrawn only.
- Held for Brian: arm payment_receipt / refund_receipt / void_notice in Admin → Automations; run install-stripe-live.sh (idempotent) for STRIPE_WEBHOOK_ENDPOINT_ID.

## Morning batch — 2026-09-10 (rulings on the evening report)
- [x] 0. First new-driver job run: 09-10 vs 09-09 diffed on the box, read-only. All 18 job run records identical field for field; zero rows flipped overdue / late fees / entity / document reminders on either day; no job.failed rows. Only 09-10 delta is the stripe_drift task the isolation fix was built to raise.
- [x] 1. Companion tests: dunning, aging and the drift check include invoices on completed engagements (a57d6f7). Sabotage: dunning active-only → red.
- [x] 4. Stub Stripe adapter refuses to load beside a live key or outside NODE_ENV=test; boot names the reason (5e48270). Sabotage: force-load under production config → boot failed with the reason.
- [x] BUILD. Rendered-output harness, page one = Ops client page at 390x844 and 1280x800 (c4a3254). In the root suite; failures commit screenshots to tasks/walks/<date>/; passing artifacts local 14 days. Sabotage: raw enum back on a badge → both viewports red, screenshots in tasks/walks/2026-09-10/; restored → five consecutive green runs.
- [ ] 2. Installer recreates the endpoint only when the secret is missing or fails verification (branch installer-endpoint-in-place, 2828ce3, three cases tested on the box). HELD: Brian runs the current installer this morning; merge and deploy after.
- Gate for page two of the harness: five consecutive green runs of page one — met 2026-09-10.
- OBSERVATION: an outbox row reads `sent` when its effect suppressed the client email at the gate (SA-2026-0004 void notice, 02:56 UTC). The audit row says suppressed and no client was written to, but the outbox alone reads as a send.
- Brian armed payment_receipt, refund_receipt and void_notice himself at 08:47-08:48 UTC. Nothing replayed.
- STRIPE_WEBHOOK_ENDPOINT_ID still unset on the box until the installer runs.

## Evening batch — 2026-09-10 (rulings on the morning report)
- [x] 1. Merged installer-endpoint-in-place (5cd160a) and deployed. Sabotage: the in-place branch forced to always recreate → case 3 red on all four assertions; restored → all five cases pass on the box.
- [x] 2. Post-rotation confirmation from the box: we_1UEFdxITVkZx9n3n5QdIfTU5 in .env, in the running container, and server-managed so the deploy preserved it. One endpoint on the live account, enabled, exactly the five events, nothing lost in the delete/create. Reconcile sweep runs clean. The drift check's Stripe call answers for both invoices. Zero webhook.signature_failed rows ever.
- [x] 4a. Outbox suppressed state (393ee72): sent / suppressed / skipped, `sent` means sent. Backfill touched exactly one row, listed by name first: Rehearsal Client 2's 2026-09-10 cancellation notice, a test client. Sabotage: the hold branch made to write 'sent' → red on exactly that.
- [x] 4b. Harness page two, portal Invoices EN/ES at both viewports (21631dd). Sabotage: inv_refunded left untranslated → both viewports red, Spanish screenshot showing the English word. Restored → five consecutive green runs of both pages.
- FINDING, fixed in 21631dd: with a portal account granted, the Ops portal-access badge read `active` — the enum word beside an engagement badge reading `Active` that means something else. Now No access / Invited / Signed up / Revoked.
- Brian declined a second real-card payment: SA-2026-0003 proved the path on live keys and held through forty ticks; the rotation only risked the signature, which the installer verified both ways.
- Gate for harness page three: five consecutive green runs of pages one and two — met 2026-09-10.

## Phone walk findings — 2026-09-10 evening (Brian's rulings on the 09-10 walk)
- [x] 0. Harness vs device. Three gaps closed: it ran `next dev` (now build+start), its phone was Chromium (now WebKit), it dispatched clicks instead of tapping (now hit-tested). None reproduces the dead Withdraw. App-shell cache header fixed (no-store; only /_next/static immutable). Lesson written under checks-that-lie: "green harness, dead button". CONFIRMED 2026-09-12 by Brian: Withdraw opens on the iPhone after the no-store deploy. The stale shell was the cause.
- [x] 1. One modal shell: opaque panel, backdrop, scroll lock, focus in, escape and click-out. All three modals converted. Harness asserts the contract at both viewports.
- [x] 2. No money record reads unknown. invoices.voided_by_label; cascades record mechanism + person. SA-2026-0004 backfilled.
- [x] 3. Reasons stand alone. SA-2026-0004 rewritten; the cascade prefix is a sentence.
- [x] 4. Task dedupe. Seven duplicates, not two — dedupe key was the quote id. Opt-in by kind; five duplicates cancelled through setTaskStatus on two test clients.
- [x] 5. Tasks on a phone, 5a–5h, plus harness page three. Found and fixed a 1280px horizontal overflow nobody had reported.
- [x] 6. Drift task: reported as a finding, NOT built — no resolve-as-expected path exists. Awaiting a ruling.
- [x] 7. Pay-link walk item noted as untestable until an open invoice exists.
- [x] Role resolver audit delivered (table only, no changes). Four live defects found; awaiting rulings.
- Gate for harness page four: five consecutive green runs of pages one, two and three.
