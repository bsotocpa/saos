# walk-evidence-path-k (2026-09-29)

Generated 2026-09-29T10:10:31.376Z by scripts/report-table.mjs from the log walk-k.log; 4 row(s).

Counts as (R96, 2026-09-29): ops-counts-as.spec.ts at 390 and 1280, the CEO fixture in Ops and the client in the portal, on a synthetic client per viewport with an accepted 1040 (its checklist open) and two files already on file (apps/api/scripts/e2e-fixtures/counts-as.ts). Every match is a tap.

```sql
node scripts/walk-evidence.mjs K  (reads apps/e2e/.artifacts/last-run.json from the full harness run of 2026-09-29: 135 passed, 0 failed)
```

| step | what | device | control (page + selector) | roles | harness test | viewport | last run | how | cleared |
|---|---|---|---|---|---|---|---|---|---|
| K1 | Ops: a file on file before the checklist is matched to a pending item from its row; the row reads what it counts as | phone + laptop | /clients/:id Documents card: a file on file before the checklist, select "Counts as…" → a pending checklist item → "Save" → the row reads "counts as <item>" | ceo (documents.write) | apps/e2e/tests/ops-counts-as.spec.ts:39 | phone | passed | tap | yes |
| K1 | Ops: a file on file before the checklist is matched to a pending item from its row; the row reads what it counts as | phone + laptop | /clients/:id Documents card: a file on file before the checklist, select "Counts as…" → a pending checklist item → "Save" → the row reads "counts as <item>" | ceo (documents.write) | apps/e2e/tests/ops-counts-as.spec.ts:39 | desk | passed | tap | yes |
| K2 | The client matches a file already sent to the item it is for on the portal's Documents page | phone + laptop | portal /documents: the client's file already sent, select "This file is for…" → a pending checklist item → "Save" → the row reads "Counts as: <item>"; the file Ops matched reads the same | the client | apps/e2e/tests/ops-counts-as.spec.ts:39 | phone | passed | tap | yes |
| K2 | The client matches a file already sent to the item it is for on the portal's Documents page | phone + laptop | portal /documents: the client's file already sent, select "This file is for…" → a pending checklist item → "Save" → the row reads "Counts as: <item>"; the file Ops matched reads the same | the client | apps/e2e/tests/ops-counts-as.spec.ts:39 | desk | passed | tap | yes |
