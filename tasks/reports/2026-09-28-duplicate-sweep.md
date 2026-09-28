# duplicate-sweep (2026-09-28)

Generated 2026-09-28T07:34:24.278Z by scripts/report-table.mjs from the log dup.log; 3 row(s).

R80, report-only: every production contact (not archived, not a test record) and business, read-only on the box. Contacts pair on the scan's normalizer (the same name) and the merge's identifiers (the same email, the same last ten phone digits); businesses on the legal name without punctuation or entity ending, and the EIN's digits. The review file with the pairs and a proposal each is client data and stays off the repository: C:\Users\brian\saos-review\2026-09-28-duplicates.csv. Nothing is merged until Brian rules on each pair.

```sql
node scripts/duplicate-sweep.mjs --date 2026-09-28
```

| kind | shared | proposal | pairs |
|---|---|---|---|
| contact | name | no merge: name only | 62 |
| contact | name | protected: never proposed | 3 |
| contact | phone | merge proposed | 4 |
