# batch-10-11-receipts-and-deploys (2026-09-30)

Generated 2026-09-30T19:02:48.573Z by scripts/report-table.mjs from the log receipts-deploys.log; 18 row(s).

```sql
the receipt run logs and deploy.sh logs of batches 10 and 11
```

| run or deploy | commit | result |
|---|---|---|
| receipt run 37 | b6a0d3b | red: the 1120S walk at 390 (a label changing in place); fixed, lesson |
| receipt run 38 | 956bede | green: 123 passed |
| deploy | d17b408 | R50 v3, OPS_RETURN_STEPPER=on |
| receipt run 39 | 18bd603 | green: 127 passed |
| deploy | e29096b | R91, R93, the deploy order, the R92 door |
| receipt run 40 | 595bd26 | red: check:css-classes (.qb-years); fixed, lesson |
| receipt run 41 | b5090b0 | red: 2 API connection resets; explained (Docker relay), lesson |
| receipt run 42 | a9a1cd7 | red: 17 API resets, 1 harness red (WebKit storage); both fixed, lessons |
| receipt run 43 | c1250a5 | green: API 943 (8 connect retries), harness 129 |
| deploy | 1b4dab3 | R89 (0134), R95; pushed 89782c4..1b4dab3 |
| receipt run 44 | 9643b6f | green: API 948 (0 retries), harness 131 |
| deploy | c45a7f8 | R90 (0135), R92 scripts; pushed 1b4dab3..c45a7f8 |
| receipt run 45 | 836af49 | green: API 951 (0 retries), harness 133 |
| deploy | fb87d25 | R96; pushed c45a7f8..fb87d25 |
| receipt run 46 | e964184 | green: API 953 (2 retries), harness 135 |
| deploy | 3fa030c | R97 (0136); pushed fb87d25..3fa030c |
| receipt run 47 | 86feed9 | red: 1 API (the alert-center push reached the local ntfy), 1 harness (a MinIO upload reset by the relay), 8 connect retries; both fixed (forced test targets, MinIO connect retry), lesson |
| receipt run 48 | f54315d | red: 39 harness walks (the test configuration lost the harness boot's own settings), API 957 (15 connect retries); fixed, check and sabotage extended, lesson |
