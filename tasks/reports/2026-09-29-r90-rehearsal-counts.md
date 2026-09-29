# r90-rehearsal-counts (2026-09-29)

Generated 2026-09-29T09:53:14.227Z by scripts/report-table.mjs from the log r90-rehearsal-table.log; 10 row(s).

```sql
bash scripts/rehearse-cutover-facts.sh /c/Users/brian/saos-imports/trello_import_v2/trello_import (the importer's own count lines)
```

| measure | count |
|---|---|
| bundle | 2026-09-19 (trello_import_v2), card_last_activity and sales_tax_status absent |
| R90 client-self-files rows recorded | 0 |
| R90 self-filer rows that met a live engagement (task to Rene) | 0 |
| R90 books-current-through months written unconfirmed | 0 |
| first pass: records created | 101 |
| first pass: returns created | 44 |
| first pass: service fact rows written | 391 |
| second pass: every delta (contacts, businesses, engagements, returns, tasks, attestations, facts, ledger, outbox) | 0 |
| the copy saos_trello_copy after the run | dropped |
| the bundle on the box after the run | deleted |
