# walk-evidence-path-z (2026-09-30)

Generated 2026-09-30T22:14:25.000Z by scripts/report-table.mjs from the log walk-z.log; 4 row(s).

The Trello cutover facts (R90, 2026-09-29): ops-cutover-facts.spec.ts at 390 and 1280 as the bookkeeper fixture, on two synthetic businesses per viewport whose facts the importer’s own functions wrote in the cutover fixture (apps/api/scripts/e2e-fixtures/cutover.ts): an unconfirmed month and a client who files their own ST-1. Everything read or pressed is the business page.

```sql
node scripts/walk-evidence.mjs Z  (reads apps/e2e/.artifacts/last-run.json from the full harness run of 2026-09-30: 137 passed, 0 failed)
```

| step | what | device | control (page + selector) | roles | harness test | viewport | last run | how | cleared |
|---|---|---|---|---|---|---|---|---|---|
| Z1 | An imported "books current through" from a card untouched since before 2026-09-21 reads unconfirmed; the bookkeeper corrects it; the badge, the door and the confirm task clear | phone + laptop | /businesses/:id Service facts: "Books current through" reads the imported month with the "unconfirmed" badge → button "Correct" → input "Books current through (month)" → button "Save" → the corrected month, no badge, no door; the confirm task completed | bookkeeper (bookkeeping.assigned.manage) | apps/e2e/tests/ops-cutover-facts.spec.ts:42 | phone | passed | tap | yes |
| Z1 | An imported "books current through" from a card untouched since before 2026-09-21 reads unconfirmed; the bookkeeper corrects it; the badge, the door and the confirm task clear | phone + laptop | /businesses/:id Service facts: "Books current through" reads the imported month with the "unconfirmed" badge → button "Correct" → input "Books current through (month)" → button "Save" → the corrected month, no badge, no door; the confirm task completed | bookkeeper (bookkeeping.assigned.manage) | apps/e2e/tests/ops-cutover-facts.spec.ts:42 | desk | passed | tap | yes |
| Z2 | A client who files their own ST-1 reads so on the Sales tax line, with no sales-tax engagement | phone + laptop | /businesses/:id Service facts: "Sales tax filing frequency" reads "client files their own ST-1 (as of <date>)" (no sales-tax engagement: cutover-facts.spec.ts) | bookkeeper (bookkeeping.assigned.manage) | apps/e2e/tests/ops-cutover-facts.spec.ts:42 | phone | passed | tap | yes |
| Z2 | A client who files their own ST-1 reads so on the Sales tax line, with no sales-tax engagement | phone + laptop | /businesses/:id Service facts: "Sales tax filing frequency" reads "client files their own ST-1 (as of <date>)" (no sales-tax engagement: cutover-facts.spec.ts) | bookkeeper (bookkeeping.assigned.manage) | apps/e2e/tests/ops-cutover-facts.spec.ts:42 | desk | passed | tap | yes |
