# price-book-deposit-check (2026-09-26)

Generated 2026-09-26T21:48:31.385Z by scripts/report-table.mjs from production; 5 row(s).

R55: per price-book version, the rows whose deposit exceeds their flat price (the predicate of constraint price_book_items_deposit_not_over_price). The version in force is the one with effective_to NULL. Counts only.

```sql
SELECT v.version_number, v.effective_from::text AS effective_from, v.effective_to::text AS effective_to, count(i.id)::int AS item_rows, count(*) FILTER (WHERE i.deposit_cents IS NOT NULL AND i.unit = 'flat' AND i.amount_cents IS NOT NULL AND i.deposit_cents > i.amount_cents)::int AS deposit_over_price_rows FROM price_book_versions v LEFT JOIN price_book_items i ON i.version_id = v.id GROUP BY v.version_number, v.effective_from, v.effective_to ORDER BY v.version_number
```

| version_number | effective_from | effective_to | item_rows | deposit_over_price_rows |
|---|---|---|---|---|
| 1 | 2026-07-05 | 2026-08-13 | 84 | 0 |
| 2 | 2026-08-13 | 2026-08-14 | 84 | 0 |
| 3 | 2026-08-14 | 2026-08-15 | 84 | 0 |
| 4 | 2026-08-15 | 2026-08-16 | 84 | 4 |
| 5 | 2026-08-16 |  | 84 | 0 |
