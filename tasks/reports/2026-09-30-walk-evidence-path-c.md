# walk-evidence-path-c (2026-09-30)

Generated 2026-10-01T01:59:45.075Z by scripts/report-table.mjs from the log walk-c.log; 4 row(s).

Same-name pairs (R97, 2026-09-29): ops-same-name.spec.ts at 390 and 1280 as the CEO fixture, on two synthetic same-name pairs per viewport, each record holding a task, with the open suggestion the pass leaves (apps/api/scripts/e2e-fixtures/same-name.ts; the pass itself is proven in same-name.spec.ts). Every answer is a tap.

```sql
node scripts/walk-evidence.mjs C  (reads apps/e2e/.artifacts/last-run.json from the full harness run of 2026-09-30: 139 passed, 0 failed)
```

| step | what | device | control (page + selector) | roles | harness test | viewport | last run | how | cleared |
|---|---|---|---|---|---|---|---|---|---|
| C1 | A same-name pair's banner opens Compare; a reason and Merge (the R92 door) join them; the banner goes and the other record redirects | phone + laptop | /clients/:id banner "Possible duplicate of <other>, compare" → "compare" (modal: Email, Phone, Businesses, Engagements, Last activity, Portal user side by side) → reason → "Merge" (the R92 pair door) → the banner is gone and the other record's page opens this one | ceo (contacts.merge for Merge; contacts.write for Not a duplicate) | apps/e2e/tests/ops-same-name.spec.ts:34 | phone | passed | tap | yes |
| C1 | A same-name pair's banner opens Compare; a reason and Merge (the R92 door) join them; the banner goes and the other record redirects | phone + laptop | /clients/:id banner "Possible duplicate of <other>, compare" → "compare" (modal: Email, Phone, Businesses, Engagements, Last activity, Portal user side by side) → reason → "Merge" (the R92 pair door) → the banner is gone and the other record's page opens this one | ceo (contacts.merge for Merge; contacts.write for Not a duplicate) | apps/e2e/tests/ops-same-name.spec.ts:34 | desk | passed | tap | yes |
| C2 | Compare, a reason and Not a duplicate: the banner goes from both records | phone + laptop | /clients/:id banner → "compare" → reason → "Not a duplicate" → the banner is gone from this record and from the other | ceo (contacts.merge for Merge; contacts.write for Not a duplicate) | apps/e2e/tests/ops-same-name.spec.ts:34 | phone | passed | tap | yes |
| C2 | Compare, a reason and Not a duplicate: the banner goes from both records | phone + laptop | /clients/:id banner → "compare" → reason → "Not a duplicate" → the banner is gone from this record and from the other | ceo (contacts.merge for Merge; contacts.write for Not a duplicate) | apps/e2e/tests/ops-same-name.spec.ts:34 | desk | passed | tap | yes |
