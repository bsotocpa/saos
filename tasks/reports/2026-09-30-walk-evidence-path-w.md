# walk-evidence-path-w (2026-09-30)

Generated 2026-10-01T01:59:44.229Z by scripts/report-table.mjs from the log walk-w.log; 4 row(s).

Past deadlines (R93, 2026-09-29): ops-batch10.spec.ts at 390 and 1280 as the CEO fixture, on a return the batch-10 fixture opens by hand 20 days past its original deadline with no extension; W1 reads "Overdue since <date>" on the Ops row, the queue and the client’s portal card (signed in by the link they were emailed); W2 records the extension on the row and reads the overdue line gone from all three.

```sql
node scripts/walk-evidence.mjs W  (reads apps/e2e/.artifacts/last-run.json from the full harness run of 2026-09-30: 139 passed, 0 failed)
```

| step | what | device | control (page + selector) | roles | harness test | viewport | last run | how | cleared |
|---|---|---|---|---|---|---|---|---|---|
| W1 | A return past its derived deadline, with no extension and no filing, reads "Overdue since <date>" on the Ops row, the queue and the portal card, never a bare past date | phone + laptop | /clients/:id Returns card row, /queue row, and portal / (Home) services card for a return 20 days past its original deadline with no extension: each reads "Overdue since <date>", with no "Due" or "Deadline" date | ceo (engagements.tax.manage); the client | apps/e2e/tests/ops-batch10.spec.ts:48 | phone | passed | tap | yes |
| W1 | A return past its derived deadline, with no extension and no filing, reads "Overdue since <date>" on the Ops row, the queue and the portal card, never a bare past date | phone + laptop | /clients/:id Returns card row, /queue row, and portal / (Home) services card for a return 20 days past its original deadline with no extension: each reads "Overdue since <date>", with no "Due" or "Deadline" date | ceo (engagements.tax.manage); the client | apps/e2e/tests/ops-batch10.spec.ts:48 | desk | passed | tap | yes |
| W2 | Recording the extension clears the overdue reading on the row, the queue and the portal card | phone + laptop | /clients/:id Returns card, button "Record extension" (modal: "Date filed" today) → the row, the /queue row and the portal card no longer read "Overdue since" | ceo (engagements.tax.manage); the client | apps/e2e/tests/ops-batch10.spec.ts:48 | phone | passed | tap | yes |
| W2 | Recording the extension clears the overdue reading on the row, the queue and the portal card | phone + laptop | /clients/:id Returns card, button "Record extension" (modal: "Date filed" today) → the row, the /queue row and the portal card no longer read "Overdue since" | ceo (engagements.tax.manage); the client | apps/e2e/tests/ops-batch10.spec.ts:48 | desk | passed | tap | yes |
