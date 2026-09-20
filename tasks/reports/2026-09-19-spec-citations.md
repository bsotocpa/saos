# spec-citations (2026-09-19)

Generated 2026-09-19T23:24:34.671Z by scripts/report-table.mjs from the log citations.log; 12 row(s).

Last run = the green receipt run of 2026-09-19 (tasks/receipts/2026-09-19-receipt-run-3.log). A row reading door defect means no spec asserts that control.

```sql
node scripts/spec-citations.mjs tasks/receipts/2026-09-19-receipt-run-3.log <control=regex pairs as in the script header>
```

| control | spec | test title | last run |
|---|---|---|---|
| refund record (the webhook writes the refund row) | apps/api/test/refunds.spec.ts:106 | charge.refunded: the invoice stops saying Paid — refund row, amounts reversed, receipt queued | passed |
| refund record (a replay records one refund) | apps/api/test/refunds.spec.ts:144 | THE REPLAY: the same charge.refunded delivered twice records ONE refund and queues ONE receipt | passed |
| refund record (staff-initiated refund attributed once) | apps/api/test/money-digest.spec.ts:137 | a webhook refund matched to a staff-initiated refund is attributed to that staff member, once | passed |
| refund record (an Ops control that records a refund) |  | no spec asserts it: door defect |  |
| void control (route: reason, actor, client told) | apps/api/test/invoice-void.spec.ts:116 | the billing role voids a sent invoice: reason and actor recorded, session expired, client told, number kept | passed |
| void control (void is terminal) | apps/api/test/invoice-void.spec.ts:179 | void is terminal: nothing moves an invoice out of it, not even SQL | passed |
| void control (an Ops tap on the harness) |  | no spec asserts it: door defect |  |
| test-client flag (reports and dashboards) | apps/api/test/test-client.spec.ts:74 | a test client with money, work and a pipeline stage changes no report and no dashboard number | passed |
| test-client flag (broadcast audience) | apps/api/test/test-clients.spec.ts:225 | a test client can NEVER be in a broadcast audience, whatever segment is built | passed |
| test-client flag (an Ops tap on the harness) |  | no spec asserts it: door defect |  |
| MFA at first login (mfa_setup_required, no session) | apps/api/test/auth.spec.ts:162 | MFA is required: password-only account must enroll before receiving a session | passed |
| MFA on a temporary password | apps/api/test/staff-accounts.spec.ts:56 | ruling 1: the temporary password dies at 72 hours or first use, and the session owes a password until it is set | passed |
