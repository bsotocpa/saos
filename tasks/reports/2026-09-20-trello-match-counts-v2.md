# trello-match-counts-v2 (2026-09-20)

Generated 2026-09-20T07:09:59.375Z by scripts/report-table.mjs from the log match-counts.log; 5 row(s).

Ruling R24, and the v2 bundle. The old/new columns still compare the 2026-09-19 rule (a unique EXACT match on the normalized key and nothing else) against everything since, from ONE run of 1066 rows judged twice.

R24. MATCH DECISIONS PERSIST, AND THEY ARE TIER 0. A decisions file outside the repo and outside Dropbox (TRELLO_DECISIONS_FILE, default C:/Users/brian/saos-imports/decisions.json), keyed by match_key, is read FIRST and applied BEFORE every tier. That order is the whole point: a pick Brian made outranks anything a similarity score can work out, including a later exact match, so a SAOS record that appears in a future bundle cannot quietly overrule him. The reason it exists: "Phase 2 runs at each role’s cutover from a fresh bundle" means this matcher runs five more times, and without a memory it hands over the same 89 judgements every time — and the second time through, a person skims.

THREE ANSWERS, and skip is not the absence of one. A candidate id matches; "create" leaves the row not-in-SAOS so the importer creates it; "skip" means this Trello name is not a client of ours and NOTHING is created — a verdict the importer obeys, and different from not-in-SAOS in exactly that respect. A fourth case is handled deliberately: a pick naming an id that is no longer live (archived or merged since) comes back AMBIGUOUS rather than falling through to the tiers, because re-deciding a stale pick with a score is the one thing this mechanism exists to stop. And a corrupt decisions file is a hard stop, not an empty object: falling back to "no decisions" would re-derive every pick and look like a clean run. This rehearsal carried 4 test picks — one candidate id, one create, one skip, one deliberately stale id — and the tier breakdown shows 2 rows matched at tier "decision" (a pick keyed by NAME applies to every card carrying it).

THE REVIEW FILE IS NOW A DECISION FORM, at <bundle>/out/review.csv: ONE ROW PER TRELLO NAME — 150 of them — with up to three candidates (name, id and score each) and a "pick" column taking a candidate id, "create" or "skip". One row per NAME and not per card is the shape change that matters: a client can appear on four cards across four files, and the 2026-09-19 file asked about each separately — four judgements about one person, four chances to answer differently. 87 of the 150 rows are ambiguous names with candidates, 63 are not-in-SAOS names where create-or-skip is itself the decision, and 4 carry three candidates. A row already decided comes back with the saved pick in the column. The candidate NAME is in the file because a column of UUIDs is not something a person can decide from, which is also why this file lives under the bundle directory and never in the repo or a report.

MATCHED BY TIER on this run: exact 544, household_first 27, decision 2, owner_in_parens 1, trigram_090 1. 31 rows promoted above the 2026-09-19 rule. The review-file admission rule is unchanged (files 01, 02, and file 04 rows carrying a live service; file 03’s 112 ambiguous rows stay out because an ambiguous row on an accepted-and-paid return resolves to no work), and 40 file-03 rows with no SAOS record at all go to out/enrichment_file03.csv and are never created.

THE SAOS SIDE of this run: 847 live contacts, 615 live businesses. Match outputs, all gitignored and under the bundle directory: trello_match_matched.csv 575, trello_match_ambiguous.csv 89 (the review set), trello_match_not_in_saos.csv 198, review.csv 150, enrichment_file03.csv 40.

```sql
TRELLO_IMPORT_DIR=/trello_import_v2/trello_import TRELLO_DECISIONS_FILE=/decisions/decisions.json DATABASE_URL=postgresql://saos:***@postgres:5432/saos_trello_copy node --experimental-strip-types scripts/trello-match.ts   (run inside a THROWAWAY container built from the deployed saos-api image — never saos-api-1 — against saos_trello_copy, a fresh pg_dump of production carrying migrations 0105-0114. The scripts refuse any database whose name does not end in _copy. The copy was dropped and the bundle removed from the box at the end; production was read and never written.)
```

| source file | total | matched old | matched new | ambiguous old | ambiguous new | not in SAOS old | not in SAOS new | in the review file |
|---|---|---|---|---|---|---|---|---|
| 01_tax_wip.csv | 100 | 52 | 55 | 26 | 23 | 22 | 22 | 23 |
| 02_tax_ar_worklist.csv | 114 | 64 | 68 | 34 | 30 | 16 | 16 | 30 |
| 03_tax_completed_roster.csv | 388 | 215 | 236 | 133 | 112 | 40 | 40 | 0 |
| 04_business_services.csv | 464 | 213 | 216 | 132 | 128 | 119 | 120 | 36 |
| ALL FOUR FILES | 1066 | 544 | 575 | 325 | 293 | 197 | 198 | 89 |
