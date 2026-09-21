# walk-evidence-path-d (2026-09-20)

Generated 2026-09-21T01:56:02.328Z by scripts/report-table.mjs from the log walk-d.log; 4 row(s).

Void, the test-client flag, the refund door on (D3) and off (D3b, R32); how=api rows are the Stripe events.

```sql
node scripts/walk-evidence.mjs D  (reads apps/e2e/.artifacts/last-run.json from the full harness run of 2026-09-20: 0 passed, 0 failed)
```

| step | what | device | control (page + selector) | roles | harness test | viewport | last run | how | cleared |
|---|---|---|---|---|---|---|---|---|---|
| D1 | Void a sent invoice from the client page: a reason, and the row reads cancelled with that reason and the actor | phone + laptop |  |  |  |  |  |  | NO |
| D2 | Flag a contact as a test record: the note, and the record leaves every report and list | phone + laptop |  |  |  |  |  |  | NO |
| D3 | Refund a paid invoice from Ops | phone + laptop |  |  |  |  |  |  | NO |
| D3b | With the Refund control off: the paid row reads that refunds are made in Stripe and recorded here, no Refund button, and the route refuses | phone + laptop |  |  |  |  |  |  | NO |
