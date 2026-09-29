# walk-evidence-path-x (2026-09-29)

Generated 2026-09-29T10:10:30.875Z by scripts/report-table.mjs from the log walk-x.log; 2 row(s).

Duplicate merges (R92, 2026-09-29): ops-batch10.spec.ts at 390 and 1280 as the CEO fixture, on a synthetic pair the batch-10 fixture enters twice with one phone, one record holding a portal sign-in; X1 merges them through POST /contacts/merge-pair, reads the survivor rule, opens the retired record by its own address and lands on the survivor, and finds the survivor alone in search.

```sql
node scripts/walk-evidence.mjs X  (reads apps/e2e/.artifacts/last-run.json from the full harness run of 2026-09-29: 135 passed, 0 failed)
```

| step | what | device | control (page + selector) | roles | harness test | viewport | last run | how | cleared |
|---|---|---|---|---|---|---|---|---|---|
| X1 | The CEO merges a marked pair; the survivor is chosen by rule (the portal sign-in, else the most engagements); the retired record redirects to the survivor and leaves search | phone + laptop | POST /contacts/merge-pair as the CEO (the pair door; survivor by rule: the portal sign-in) → /clients/<retired id> in the address bar lands on the survivor's page; GET /contacts?search= returns the survivor alone | ceo (contacts.merge) | apps/e2e/tests/ops-batch10.spec.ts:103 | phone | passed | tap | yes |
| X1 | The CEO merges a marked pair; the survivor is chosen by rule (the portal sign-in, else the most engagements); the retired record redirects to the survivor and leaves search | phone + laptop | POST /contacts/merge-pair as the CEO (the pair door; survivor by rule: the portal sign-in) → /clients/<retired id> in the address bar lands on the survivor's page; GET /contacts?search= returns the survivor alone | ceo (contacts.merge) | apps/e2e/tests/ops-batch10.spec.ts:103 | desk | passed | tap | yes |
