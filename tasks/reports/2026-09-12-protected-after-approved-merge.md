# protected-after-approved-merge (2026-09-12)

Generated 2026-09-13T01:51:51.050Z by scripts/report-table.mjs from production; 6 row(s).

The protected names after tonight's operations: every record, its state.

```sql
SELECT first_name || ' ' || last_name AS name, left(id::text, 8) AS record, is_archived::text AS archived, COALESCE(left(merged_into_contact_id::text, 8), '') AS merged_into, (COALESCE(notes, '') LIKE '%Possible duplicate%')::text AS noted FROM contacts WHERE (first_name = 'Jackson' AND last_name = 'Flores') OR first_name = 'Josean' OR (first_name = 'Joseph' AND last_name = 'Basilone') ORDER BY 1, 2
```

| name | record | archived | merged_into | noted |
|---|---|---|---|---|
| Jackson Flores | 70bf9210 | false |  | false |
| Josean Irizarry | 224346a2 | false |  | true |
| Josean Irizarry | 66300bc1 | false |  | true |
| Josean Irizarry | 7497cc21 | false |  | true |
| Joseph Basilone | 8e499a4f | false |  | false |
| Joseph Basilone | b773c010 | true | 8e499a4f | false |
