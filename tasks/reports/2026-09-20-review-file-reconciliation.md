# review-file-reconciliation (2026-09-20)

Generated 2026-09-20T21:54:38.996Z by scripts/report-table.mjs from the log review-reconciliation.log; 14 row(s).

Ruling R34. The two numbers count different things. The match table's 'in the review file' column is CARD ROWS whose verdict is ambiguous in an admitted file (files 01, 02, and file 04 with a live service) — the rows of out/trello_match_ambiguous.csv, 89 of them. review.csv is ONE ROW PER TRELLO NAME across those same files, and it also carries every not-in-SAOS name from them, because create-or-skip is a decision the importer obeys (R24). So the 150 is: the 89 ambiguous card rows collapsed to their distinct names, plus the distinct not-in-SAOS names from the admitted files, minus the names that appear both ways (one row, verdict ambiguous). Rows never in either number: file 03's not-in-SAOS rows (the enrichment list, never created) and file-04 rows with no live service. Computed from the out/ files of the local match run, whose review.csv and ambiguous file carry the same 150 and 89 as the box run.

```sql
TRELLO_IMPORT_DIR=C:/Users/brian/saos-imports/trello_import_v2/trello_import node scripts/review-file-reconciliation.mjs   (reads the matcher's own output files under <bundle>/out/ — review.csv, trello_match_ambiguous.csv, trello_match_matched.csv, trello_match_not_in_saos.csv, enrichment_file03.csv — and the decisions file; counts only, no name or id leaves the script; it exits non-zero unless the classes sum from the 89 to the 150)
```

| row class | card rows | distinct names | in the 89 (match table: in the review file) | in the 150 (review.csv) | how it is counted |
|---|---|---|---|---|---|
| ambiguous card rows in the admitted files (01, 02, live 04) — out/trello_match_ambiguous.csv | 89 | 84 | 89 | 84 | the 89 is CARD ROWS (01: 23, 02: 30, 04: 36); review.csv has one row per NAME |
| of which: the same name on more than one admitted ambiguous card, collapsed | 5 | - | 5 | 0 | 89 rows - 84 names = 5 rows that add nothing to the 150 |
| not-in-SAOS card rows in the admitted files, whose name is in review.csv | 89 | 67 | 0 | 66 | never in the 89 (not ambiguous); in the 150 because "create or skip" is a decision the importer obeys (01: 22, 02: 16, 04: 51) |
| of which: the same name on more than one not-in-SAOS card, collapsed | 22 | - | 0 | 0 | 89 rows - 67 names |
| of which: a name ambiguous on one card and not-in-SAOS on another | - | 1 | 0 | 0 | one review row, verdict ambiguous (there is something to choose between); already counted in the ambiguous names above |
| not-in-SAOS card rows from file 03 — out/enrichment_file03.csv | 40 | 40 | 0 | 0 | file 03 is never imported; these go to the enrichment list and are never created; 5 of them carry a name that also reached review.csv through another file's row, and are counted there under that row, not here |
| not-in-SAOS card rows from file 04 with no live service | 69 | 69 | 0 | 0 | not admitted: nothing live to attach (the same rule that keeps them out of the 89) |
| not-in-SAOS card rows from files 01/02 missing from review.csv (must be 0) | 0 | 0 | 0 | 0 | every 01/02 not-in-SAOS row is admitted |
| review.csv rows by verdict | - | 150 | - | 150 | ambiguous 84, not_in_saos 66 |
| review.csv rows by the files the name appears in | - | 150 | - | 150 | 01 02: 2, 01 04: 1, 01: 41, 02 04: 5, 02: 39, 04: 62 |
| review.csv rows carrying a saved pick (decisions file) | - | 3 | - | 3 | a pick already applied is still a row, with the pick shown; 2 matched card row(s) at tier decision and 2 skip row(s) sit in the matched file, 1 create row(s) in the not-in-SAOS file |
| review.csv rows with three candidates / with none | - | 1 / 68 | - | - | none: the 66 not-in-SAOS names, where the decision is create or skip, plus 2 ambiguous name(s) with no live candidate to show (a saved pick naming an id that is no longer live comes back ambiguous on purpose) |
| THE SUM | 178 | 150 | 89 | 150 | 84 ambiguous names + 67 not-in-SAOS names - 1 counted both ways = 150; the 89 is 89 ambiguous card rows = 84 names + 5 repeats |
| CHECK | - | - | - | - | the classes sum from the 89 to the 150 |
