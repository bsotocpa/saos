# TODO — 2026-09-09 morning batch (Brian's rulings). One commit per item; suite + one sabotage per run; red blocks deploy.

FIRST — walk failures
- [ ] A. SA-2026-0003 paid again: prove writer; state-machine trigger (refunded→paid illegal w/o payment; void terminal; paid→refunded only via refund row; reconcile touches sent/overdue only); sabotage: trigger detached; nightly Stripe drift check → task; lessons instance.
- [ ] B. DATE vs TIMESTAMPTZ: DATE columns serialized as calendar dates at the driver (pg 1082 parser), helper typed; enumerate DATE columns + render sites; pausedDays arithmetic; test ended >= started; guard.
- [ ] C. Decision-1 corrected sequence: withdraw ef90aabc (route), period 2025 on 6e474b1f + BRIAN S. test row + Brian S. real row (list before/after), transfer SA-2026-0001 → 6e474b1f.
- [ ] D. Mobile overflow: stack void metadata on narrow viewports; send-log rows wrap; 390px walk.
- [ ] E. Portal shows void invoices: Cancelled/Anulada, sorted last, no pay action.
- [ ] F. Engagement order: active, on_hold, closed; newest first within group.

DECISIONS
- [ ] 2. Tax year shown in builder, printed on the quote, in the engagement title; test asserts all three.
- [ ] 3. Void reverses issuance completely (symmetric with issue); field diff test; fix 6e474b1f via route; lessons instance.
- [ ] 5. SOP seeds: reviewed_at NULL → overwrite; else refuse + diff; dispute SOP on the box confirmed.
- [ ] 6. pausedDays clock bug: root-cause in production code; list affected on_hold engagements; freeze clock in spec.

NEW
- [ ] 7. Stranded deposits: withdraw refuses w/ paid unapplied deposit unless superseding or actor selects refund (billing task); transfer route (billing.manage, audit both); move 0001 → 6e474b1f; query of invoices on non-active engagements.
- [ ] 8. Outbox double-send audit (attempts > 1), grouped by contact; protected names flagged.
- [ ] 9. Ungated send sites: list 13 by module:function/template/recipient class; gate client-reachable; staff-only get a recipient test; guard fails on new ungated client sites.
- [ ] 10. Signature failures log livemode + endpoint id.
- [ ] 11. Actor display: name, never email (audit, invoice, engagement rows).
- [ ] PLAN: Playwright rendered-output harness (one page).
