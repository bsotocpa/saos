# status-waiver-amendment (2026-09-19)

Generated 2026-09-19T18:07:36.231Z by scripts/report-table.mjs from production; 1 row(s).

The SA-2026-0001 waiver reason and its amendment.

```sql
SELECT i.invoice_number, i.stripe_check_waived_at::date::text AS waived, i.stripe_check_waived_reason AS original_reason, st.display_name AS amended_by, ra.created_at::date::text AS amended_on, ra.body AS amendment FROM invoices i JOIN reason_amendments ra ON ra.object_id = i.id AND ra.field = 'stripe_check_waived_reason' JOIN staff st ON st.id = ra.staff_id WHERE i.invoice_number = 'SA-2026-0001'
```

| invoice_number | waived | original_reason | amended_by | amended_on | amendment |
|---|---|---|---|---|---|
| SA-2026-0001 | 2026-09-12 | idk claude code told me to | Brian Soto | 2026-09-19 | Paid under the Stripe test key on 2026-08-13, before live keys were installed 2026-09-09. |
