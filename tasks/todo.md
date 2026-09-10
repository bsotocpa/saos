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
