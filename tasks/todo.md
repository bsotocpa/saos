# TODO — 2026-09-09 refund/void/test-flag/pay-link (Brian's rulings, verbatim intent)

Standing: red suite blocks deploy · one sabotage per run · lessons.md "refund silently
ignored = Paid forever" under checks-that-lie · launch-readiness.md updated · one commit per item.

## 0. Prove SAOS is wrong right now
- [x] SA-2026-0003: SAOS says `paid`; Stripe (asked with SAOS's own key) says refunded. PROVEN 07:4x UTC: charge refunded:true amount_refunded:2000, refund re_…h2l52cr requested_by_customer.

## 1. Refund + dispute webhooks
- [x] Subscribe charge.refunded, charge.dispute.created, charge.dispute.closed on the LIVE endpoint via API; verify the list on the box. DONE: we_1UDevjIT… subscribes to all five, read back.
- [x] charge.refunded → refund row (amount, stripe refund id, reason), ledger reversal, status refunded / partially_refunded, audit, outbox effect (refund receipt to client — registered transactional send).
- [x] charge.dispute.created → status disputed; staff task via the one door, billing role (CEO fallback), due = evidence_due_by from the payload; no client send.
- [x] charge.dispute.closed → won: paid; lost: as refunded.
- [x] Idempotent on Stripe event id (#48 latch). Test: replay charge.refunded twice → one refund row, one reversal. Sabotage (latch blinded): replay test fails, plus three others that carry the FK to the latch row.
- [x] Fixtures: stripe-trigger-shaped payloads for all three (test mode) in the suite.
- [ ] Tell Brian the Stripe resend path and what SA-2026-0003 should show on his phone.

## 2. Void path
- [x] Status `void`; reason required; actor recorded; roles billing + CEO.
- [x] Only sent/open/overdue can be voided — enforced in the DATABASE (trigger), paid never.
- [x] On void: expire open Stripe session, out of AR aging, ledger reversal, audit, client void notice via the client-send gate.
- [x] Invoice number retained (sequence, never reissued). PENDING: Brian voids SA-2026-0002 from the iPhone UI — not by script. Sabotage (trigger unattached): exactly the 4 database-level tests fail. Proven on the dev server via API: paid → 409 "refunded, not voided"; blank reason → 400; sent → void with reason + actor, notice queued. The button itself was not clicked locally (stale-cookie fight in the test browser); Brian's first use is the walk.

## 3. Test client flag
- [x] contacts.is_test already existed (with a DB constraint: a test flag needs a test_note) and is set on Rehearsal C. Audit: dashboards (14 queries) all excluded; reports: pipeline_conversion and team_throughput did NOT — fixed. No month-end packet exists in SAOS; the aggregate surfaces are the report tiles and the executive dashboard, all covered by one behavioural test: a flagged client with money, work and a pipeline stage moves no number; un-flagged, it moves five.
- [x] Explicitly NOT set on Jackson F., Josean I. (3 records), Joseph B. (2 records) — verified on the box 2026-09-09: all is_test = false. Test contacts on the box: 2.

## 4. Invoice pay link (ruled)
- [ ] Signed tokenized URL scoped to one invoice, no portal login; Stripe Checkout is the auth.
- [ ] Token dies on paid, void, or 90 days; revoked → plain "no longer payable" page, no data.
- [ ] Portal invite stays a separate onboarding event. Close the runbook item.

## Q (answer only): does the sweep retire expired live sessions?
