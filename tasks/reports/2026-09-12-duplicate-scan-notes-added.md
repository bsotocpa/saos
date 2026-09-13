# duplicate-scan-notes-added (2026-09-12)

Generated 2026-09-13T01:52:19.440Z by scripts/report-table.mjs from production; 3 row(s).

Records the rerun noted after the approved merge: winners of the earlier merges that still stand beside a same-name record sharing nothing.

```sql
SELECT c.first_name || ' ' || c.last_name AS name, left(c.id::text, 8) AS record, c.source::text AS source FROM audit_log a JOIN contacts c ON c.id = a.object_id::uuid WHERE a.action = 'contact.updated' AND a.details->'fields' ? 'notes' AND a.occurred_at >= (SELECT occurred_at FROM audit_log WHERE action = 'contact.merged' AND object_id = 'b773c010-d6b8-4e2c-aee9-229866e56f4b') ORDER BY 1
```

| name | record | source |
|---|---|---|
| Cristobal Mora | 7bd9d192 | dubsado |
| Hector Diaz | 5b989154 | dubsado |
| John Avila | e30438db | dubsado |
