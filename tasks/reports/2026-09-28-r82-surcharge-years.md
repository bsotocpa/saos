# r82-surcharge-years (2026-09-28)

Generated 2026-09-28T07:34:25.566Z by scripts/report-table.mjs from production; 1 row(s).

R82: how many production quotes name a tax year more than 2 back (a PRIOR_YEAR_SURCHARGE year), which no quote has ever been priced for.

```sql
SELECT count(*) FILTER (WHERE (interview_answers->>'tax_year')::int < extract(year from now())::int - 3) AS quotes_for_years_more_than_2_back, count(*) FILTER (WHERE interview_answers ? 'tax_year') AS quotes_with_a_year, count(*) AS quotes FROM quotes
```

| quotes_for_years_more_than_2_back | quotes_with_a_year | quotes |
|---|---|---|
| 0 | 2 | 14 |
