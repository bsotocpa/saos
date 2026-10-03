# batch-19-sabotages (2026-10-03)

Generated 2026-10-03T08:36:12.860Z by scripts/report-table.mjs from the log sabotage-b19.log; 4 row(s).

```sql
scripts/sabotage-run.mjs over scripts/sabotages/2026-10-03-n-r125.mjs; the R125 rows of tasks/sabotage/2026-10-03.log
```

| date | item | file | change | test | on the harness | red | restored green |
|---|---|---|---|---|---|---|---|
| 2026-10-03 | R125: a plain npm test is taken for a receipt | scripts/check-receipt-runner.mjs | a run that names no runner is accepted; the self-test must refuse the check | guard: check:receipt-runner | no | RED as expected (1 failed: check-receipt-runner self-test: "a plain npm test, no runner" was accepted) | green (1 passed) |
| 2026-10-03 | R125: a copy of the runner kept outside the checkout is accepted | scripts/check-receipt-runner.mjs | the runner's path is no longer held to this checkout's committed copy | guard: check:receipt-runner | no | RED as expected (2 failed: check-receipt-runner self-test: "a copy of the runner kept outside the checkout" was accepted; check-receipt-runner self-test: "another checkout's runner" was accepted) | green (1 passed) |
| 2026-10-03 | R125: an edited runner is accepted | scripts/check-receipt-runner.mjs | the runner's hash is no longer compared with the committed copy's | guard: check:receipt-runner | no | RED as expected (1 failed: check-receipt-runner self-test: "a runner whose bytes differ from the committed copy" was accepted) | green (1 passed) |
| 2026-10-03 | R125: a helper edited and not committed | scripts/receipt/hold-awake.ps1 | one line added to the display hold in the working tree only; the check must name the file | guard: check:receipt-runner | no | RED as expected (1 failed: scripts/receipt/hold-awake.ps1 differs from its committed copy) | green (1 passed) |
