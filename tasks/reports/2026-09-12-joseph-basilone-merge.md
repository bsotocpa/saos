# joseph-basilone-merge (2026-09-12)

Generated 2026-09-13T01:52:17.813Z by scripts/report-table.mjs from production; 1 row(s).

The protected merge Brian approved, from the audit row the merge wrote.

```sql
SELECT details->>'loser_name' AS name, left(object_id::text, 8) AS loser, left(details->>'winner', 8) AS winner, details->'shared_identifiers' AS shared, details->'moved' AS moved, actor_label FROM audit_log WHERE action = 'contact.merged' AND object_id = 'b773c010-d6b8-4e2c-aee9-229866e56f4b'
```

| name | loser | winner | shared | moved | actor_label |
|---|---|---|---|---|---|
| Joseph Basilone | b773c010 | 8e499a4f | ["phone"] | {"tasks": 1, "import_records": 2, "business_members": 1, "enrichment_queue": 1} | Brian Soto (ruled 2026-09-13, applied by script) |
