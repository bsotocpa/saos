# r97-production-state (2026-09-29)

Generated 2026-09-29T10:12:47.097Z by scripts/report-table.mjs from production; 2 row(s).

```sql
SELECT 'records archived as empty duplicates, with a redirect' AS measure, count(*)::int AS count FROM contacts WHERE archived_reason = 'Empty duplicate from the Dubsado migration' AND merged_into_contact_id IS NOT NULL UNION ALL SELECT 'same-name banners open (each on both client pages)', count(*)::int FROM contact_duplicate_suggestions WHERE status = 'open'
```

| measure | count |
|---|---|
| records archived as empty duplicates, with a redirect | 16 |
| same-name banners open (each on both client pages) | 43 |
