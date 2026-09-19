# status-paths (2026-09-19)

Generated 2026-09-19T19:34:03.461Z by scripts/report-table.mjs from production; 4 row(s).

The refund path, the void path, the test-client flag and abandoned Checkout sessions, as production holds them.

```sql
SELECT 'refund path' AS path, count(*)::text AS rows, COALESCE(max(created_at)::date::text, 'never') AS last_seen, 'invoice_refunds rows written by the webhook or the refund route' AS evidence FROM invoice_refunds UNION ALL SELECT 'void path', count(*)::text, COALESCE(max(voided_at)::date::text, 'never'), 'invoices with status void' FROM invoices WHERE status = 'void' UNION ALL SELECT 'test-client flag', count(*)::text, COALESCE(max(updated_at)::date::text, 'never'), 'contacts with is_test = true' FROM contacts WHERE is_test UNION ALL SELECT 'abandoned Checkout sessions', count(*)::text, COALESCE(max(created_at)::date::text, 'never'), 'invoices still payable that carry a Checkout session id and no payment' FROM invoices WHERE stripe_checkout_session_id IS NOT NULL AND status IN ('sent', 'overdue') AND amount_paid_cents = 0
```

| path | rows | last_seen | evidence |
|---|---|---|---|
| refund path | 1 | 2026-09-09 | invoice_refunds rows written by the webhook or the refund route |
| void path | 2 | 2026-09-10 | invoices with status void |
| test-client flag | 3 | 2026-09-12 | contacts with is_test = true |
| abandoned Checkout sessions | 0 | never | invoices still payable that carry a Checkout session id and no payment |
