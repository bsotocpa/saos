# trello-match-counts (2026-09-20)

Generated 2026-09-20T02:53:08.714Z by scripts/report-table.mjs from the log match-counts.log; 5 row(s).

Item d. SECOND-TIER AUTO-ACCEPT, old rule against new, from ONE run of 1066 rows judged twice: every result row carries the verdict the 2026-09-19 rule would have given (unique EXACT match on the normalized key and nothing else) beside the verdict the new rules produced. Two runs against two moments of the copy would not have been comparable.

THE THREE NEW RULES. (1) HOUSEHOLDS: the first-named person of "A & B Lastname", by exact normalized first and last name, when that lands on exactly one live contact. 27 of the 73 household rows now match, against ZERO on 2026-09-19. The failure it could make is a wrong PRIMARY on a joint return, visible and fixable on the return page; it cannot attach a return to the wrong family, because the surname and one exact first name both have to land. (2) BUSINESSES BY SIMILARITY: trigram Jaccard >= 0.90 with a unique candidate whose runner-up is at least 0.15 lower. Both halves matter — 0.90 means the difference is punctuation or a dropped word, and the 0.15 gap is what stops the rule firing between two businesses that resemble EACH OTHER, which is how a sibling entity gets picked silently. It accepted 1 row: at Jaccard over the SET of character trigrams, 0.90 is a very high bar, and that is the bar as ruled. (3) BUSINESSES BY OWNER: the person named in parentheses on the card matches, exactly and uniquely, a contact who is ALREADY a member of the candidate business in SAOS. 1 row. It is the strongest of the three and the one least about spelling — an entity name is evidence about a string, its owner is evidence about a relationship SAOS already records — and the junk in that column ("SM", "CLOSED", a note about a client who died) is filtered by the requirement itself.

MATCHED BY TIER: exact 544, household_first 27, owner_in_parens 1, trigram_090 1. 29 rows promoted from ambiguous; NOT ONE promoted from not-in-SAOS, which is why the not-in-SAOS columns are identical old and new. What did not change: a score alone still never accepts below 0.90, a name shared by two SAOS records still never accepts, and file 05 spelling variants are still hints only (144 ambiguous rows carry one).

Item e. THE REVIEW FILE IS THE LAST COLUMN, and it is not the ambiguous count. It holds three kinds of row and no others: file 01, file 02, and file 04 rows carrying a LIVE service (a bookkeeping cadence, sales tax, or payroll). File 03 ambiguous rows are excluded — 112 of them — because file 03 is 388 accepted-and-paid TY2025 returns whose import intent is "existence check only": an ambiguous row there resolves to no work, and 112 of 291 would have made the file 38 percent noise. Inactive file-04 rows are excluded for the same reason. 88 rows to review, against 291 ambiguous overall.

Item f. 40 file-03 rows with no SAOS record at all go to out/enrichment_file03.csv and are NOT created: a completed-and-paid roster row carries no engagement, no stage and no money, so a contact made from it would be a name in the directory with nothing attached and nobody accountable. File 04 carries 159 rows with an active service, 32 of which are not in SAOS.

Match outputs (gitignored, under the bundle directory, never the repo): trello_match_matched.csv 573, trello_match_ambiguous.csv 88 (the review file), trello_match_not_in_saos.csv 202, enrichment_file03.csv 40. The SAOS side of this run: 847 live contacts, 615 live businesses.

```sql
TRELLO_IMPORT_DIR=/trello_import DATABASE_URL=postgresql://saos:***@postgres:5432/saos_trello_copy node --experimental-strip-types scripts/trello-match.ts   (run inside a THROWAWAY container built from the deployed saos-api image — never inside saos-api-1 — against saos_trello_copy, a fresh pg_dump of production carrying migrations 0105-0111. The scripts refuse any database whose name does not end in _copy. The copy was dropped and the bundle removed from the box at the end; production was read and never written.)
```

| source file | total | matched old | matched new | ambiguous old | ambiguous new | not in SAOS old | not in SAOS new | in the review file |
|---|---|---|---|---|---|---|---|---|
| 01_tax_wip.csv | 100 | 52 | 55 | 25 | 22 | 23 | 23 | 22 |
| 02_tax_ar_worklist.csv | 114 | 64 | 67 | 33 | 30 | 17 | 17 | 30 |
| 03_tax_completed_roster.csv | 388 | 215 | 236 | 133 | 112 | 40 | 40 | 0 |
| 04_business_services.csv | 464 | 213 | 215 | 129 | 127 | 122 | 122 | 36 |
| ALL FOUR FILES | 1066 | 544 | 573 | 320 | 291 | 202 | 202 | 88 |
