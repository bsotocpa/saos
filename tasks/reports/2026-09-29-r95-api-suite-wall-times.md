# r95-api-suite-wall-times (2026-09-29)

Generated 2026-09-29T09:53:14.032Z by scripts/report-table.mjs from the log r95-wall-times.log; 8 row(s).

```sql
the API suite's own duration (node --test duration_ms) from each run's log
```

| measure | suite | API suite duration (s) | tests | failed | resets |
|---|---|---|---|---|---|
| before | receipt run 37 (fsync on, per-spec migrations) | 463 | 934 | 0 | 0 |
| before | receipt run 38 (fsync on, per-spec migrations) | 473 | 934 | 0 | 0 |
| before | receipt run 39 (fsync on, per-spec migrations) | 432 | 939 | 0 | 0 |
| before | receipt run 41 (fsync on, per-spec migrations) | 518 | 942 | 2 | 2 |
| fsync off | main, per-spec migrations (a few late specs on the new helper) | 227 | 942 | 0 | 0 |
| fsync off | receipt worktree, per-spec migrations | 368 | 949 | 98 | 182 |
| after | main, template clones (R95) | 107 | 942 | 2 | 2 |
| after | main, template clones, three connection probes beside it | 98 | 942 | 0 | 0 |
