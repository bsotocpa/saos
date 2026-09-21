# walk-evidence-path-q (2026-09-20)

Generated 2026-09-21T01:56:02.590Z by scripts/report-table.mjs from the log walk-q.log; 4 row(s).

The Quotes card (R39): Q1 to Q4 are the CEO taps at 390 and 1280; the role proof is ed_coo, who reads the card and holds no quotes.manage.

```sql
node scripts/walk-evidence.mjs Q  (reads apps/e2e/.artifacts/last-run.json from the full harness run of 2026-09-20: 0 passed, 0 failed)
```

| step | what | device | control (page + selector) | roles | harness test | viewport | last run | how | cleared |
|---|---|---|---|---|---|---|---|---|---|
| Q1 | Open a quote from the card: the Ops quote page reads the client, the business, the lines and the state | phone + laptop |  |  |  |  |  |  | NO |
| Q2 | Copy the client link: a fresh portal link, the confirmation line, and the link opens the proposal | phone + laptop |  |  |  |  |  |  | NO |
| Q3 | Resend the proposal email: the same send path, a new link in the mailer, the confirmation line | phone + laptop |  |  |  |  |  |  | NO |
| Q4 | Withdraw a draft with a reason: the row reads Withdrawn | phone + laptop |  |  |  |  |  |  | NO |
