# r101-returns-counted-open-in-batch-12 (2026-09-30)

Generated 2026-09-30T23:12:34.194Z by scripts/report-table.mjs from the log r101-read.log; 3 row(s).

```sql
production read-only, 2026-09-30: every tax return whose stage is not filed or completed (the batch 12 predicate), with the queue's own open test (stage not completed or withdrawn) beside it
```

| return_id | tax_year | form | stage | engagement_status | test_client | created_on | preparer | open_by_the_queue |
|---|---|---|---|---|---|---|---|---|
| e97c195a-524b-43dc-8197-eec0343edadc | 2025 | 1040 | withdrawn | withdrawn | no | 2026-08-13 | none | no |
| 24c00168-13f0-40c4-9bdb-0083e0f3d250 | 2025 | 1040 | withdrawn | withdrawn | no | 2026-08-13 | none | no |
| a23d48db-e4c6-49e6-baf3-b254549f196a | 2025 | 1040 | intake_started | active | no | 2026-09-27 | named | yes |
