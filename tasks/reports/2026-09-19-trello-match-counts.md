# trello-match-counts (2026-09-19)

Generated 2026-09-19T23:34:38.581Z by scripts/report-table.mjs from the log match-counts.log; 5 row(s).

Item 11. Auto-accept is a UNIQUE EXACT match on the normalized key and nothing else; every other row is in the review file with its candidates and scores. Normalization: businesses reuse the bundle's own key() from imports/trello_import/scripts/extract.py (upper-case, & -> AND, punctuation dropped, the legal-suffix and form-number tokens dropped, spaces collapsed) applied to the SAOS name as well; contacts reuse norm() from apps/api/src/modules/crm/duplicates.ts (lower-case, collapse whitespace) unchanged, because a suffix stripper on a person's name merges a Jr. into his father. Similarity for the candidate lists is TRIGRAM JACCARD over the set of character 3-grams, threshold 0.45, top 5 kept; a score never promotes a row to matched. File 05 widens candidate lists only and is labelled via05 in the CSV: the SAOS record is canonical, so a variant spelling that matches exactly is a hint for a person, never an accept (17 ambiguous rows are ambiguous for that reason alone; 170 carry a via05 candidate). FINDINGS column: files 01-03 are all TY2025 filers, so a row missing from SAOS is a finding; for file 04 a finding is a missing row that also carries an ACTIVE bookkeeping cadence (bk_cadence_label set and bk_status not Lost/Inactive/Dissolved/Self-Prepared), which is 22 of the 123 missing. Two shapes worth naming: 112 rows in files 01-03 matched a SAOS BUSINESS rather than a contact (entity returns whose card names the entity) and are counted as matched; and 73 rows are households ('A & B Lastname') of which ZERO auto-accepted - 37 have exactly one spouse resolving to one contact, 15 have neither resolving uniquely, 20 have neither name in SAOS, 1 has both but the two contacts share neither an address nor a business household. Only 373 of 847 live contacts carry an address_line1 on the copy, so the share-an-address half of the household rule cannot fire for most pairs. Row counts are the matching outputs in imports/trello_import/out/ (gitignored): trello_match_matched.csv 542, trello_match_ambiguous.csv 320, trello_match_not_in_saos.csv 204.

```sql
DATABASE_URL=postgresql://saos:***@postgres:5432/saos_trello_copy node --experimental-strip-types scripts/trello-match.ts --dir /trello_import   (apps/api/scripts/trello-match.ts, run inside saos-api-1 against the pg_dump copy saos_trello_copy; the script refuses any database whose name does not end in _copy)
```

| source file | total | matched | ambiguous | not in SAOS | findings |
|---|---|---|---|---|---|
| 01_tax_wip.csv | 100 | 52 | 25 | 23 | 23 |
| 02_tax_ar_worklist.csv | 114 | 63 | 33 | 18 | 18 |
| 03_tax_completed_roster.csv | 388 | 215 | 133 | 40 | 40 |
| 04_business_services.csv | 464 | 212 | 129 | 123 | 22 |
| ALL FOUR FILES | 1066 | 542 | 320 | 204 | 103 |
