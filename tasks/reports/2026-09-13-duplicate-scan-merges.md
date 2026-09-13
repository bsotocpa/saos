# duplicate-scan-merges (2026-09-13)

Generated 2026-09-13T01:36:51.688Z by scripts/report-table.mjs from production; 12 row(s).

Contacts the duplicate scan merged on a shared identifier, from the audit rows the merge wrote.

```sql
SELECT details->>'loser_name' AS name, left(object_id::text, 8) AS loser, left(details->>'winner', 8) AS winner, details->'shared_identifiers' AS shared FROM audit_log WHERE action = 'contact.merged' AND actor_label LIKE '%applied by script%' AND occurred_at >= '2026-09-13' ORDER BY 1, 2
```

| name | loser | winner | shared |
|---|---|---|---|
| Adriana De La Cruz | 12b47827 | 5ee341a0 | ["phone"] |
| Brenda Martinez | 9f095a4d | 25a290b6 | ["phone"] |
| Cristobal Mora | 6508b904 | 7bd9d192 | ["phone"] |
| Daniel Hernandez | 0d517a64 | bf5675c3 | ["phone"] |
| Daniel Hernandez | 7941c2ee | bf5675c3 | ["phone"] |
| Francisco Martinez | 404f5390 | 9454203b | ["phone"] |
| Hector Diaz | 5b7cb7bf | 5b989154 | ["phone"] |
| Irais Elizarraraz | 1b6d2c13 | 63d94eb3 | ["phone"] |
| John Avila | 34878b3f | e30438db | ["phone"] |
| Juan Munoz | 065a74b7 | a84a8c43 | ["phone"] |
| Mathew Alvarez | e763145c | 7bcc26a8 | ["phone"] |
| Viviana Manzanarez | 67b83f41 | a1258cc0 | ["phone"] |
