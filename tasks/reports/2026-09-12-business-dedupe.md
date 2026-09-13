# business-dedupe (2026-09-12)

Generated 2026-09-13T01:51:48.458Z by scripts/report-table.mjs from production; 1 row(s).

Same-name businesses within one contact, merged through the route, from the audit rows.

```sql
SELECT details->>'loser_name' AS loser_name, left(object_id::text, 8) AS loser, left(details->>'winner', 8) AS winner, details->'moved' AS moved, actor_label FROM audit_log WHERE action = 'business.merged' AND occurred_at > now() - interval '45 minutes' ORDER BY occurred_at
```

| loser_name | loser | winner | moved | actor_label |
|---|---|---|---|---|
| Tri-Taylor Condominium Association | f716be19 | 61eb0a62 | {} | Brian Soto (ruled 2026-09-13, applied by script) |
