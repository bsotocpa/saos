# r106-layout-before-summary (2026-10-01)

Generated 2026-10-01T02:30:25.677Z by scripts/report-table.mjs from the log layout-before-summary.log; 60 row(s).

```sql
the R106 layout audit (apps/e2e/tests/layout-audit.spec.ts, LAYOUT_AUDIT=report): every Ops and portal page at 375, 768 and 1440 in Chromium and WebKit through apps/e2e/tests/layout-check.ts; the failures in apps/e2e/.artifacts/layout-failures.jsonl
```

| page | check | chromium-375 | chromium-768 | chromium-1440 | webkit-375 | webkit-768 | webkit-1440 | total |
|---|---|---|---|---|---|---|---|---|
| ops-account | tap-target | 34 | 34 | 34 | 34 | 34 | 34 | 204 |
| ops-admin-automations | word-broken | 1 | 0 | 0 | 1 | 0 | 0 | 2 |
| ops-admin-automations | tap-target | 49 | 49 | 49 | 49 | 49 | 49 | 294 |
| ops-admin-document-checklist | tap-target | 123 | 123 | 123 | 123 | 123 | 123 | 738 |
| ops-admin-pricing | word-broken | 304 | 0 | 0 | 304 | 0 | 0 | 608 |
| ops-admin-pricing | tap-target | 385 | 222 | 222 | 385 | 222 | 222 | 1658 |
| ops-admin-settings | word-broken | 67 | 0 | 0 | 67 | 0 | 0 | 134 |
| ops-admin-settings | tap-target | 61 | 61 | 61 | 61 | 61 | 61 | 366 |
| ops-admin-staff | word-broken | 32 | 23 | 0 | 32 | 23 | 0 | 110 |
| ops-admin-staff | clipped | 5 | 5 | 5 | 5 | 5 | 5 | 30 |
| ops-admin-staff | tap-target | 61 | 61 | 61 | 61 | 56 | 56 | 356 |
| ops-admin-templates | word-broken | 292 | 0 | 0 | 292 | 0 | 0 | 584 |
| ops-admin-templates | tap-target | 94 | 94 | 94 | 94 | 94 | 94 | 564 |
| ops-admin-wisp | word-broken | 8 | 0 | 0 | 9 | 0 | 0 | 17 |
| ops-admin-wisp | tap-target | 29 | 29 | 29 | 29 | 29 | 29 | 174 |
| ops-alerts | word-broken | 1 | 0 | 0 | 1 | 0 | 0 | 2 |
| ops-alerts | tap-target | 28 | 28 | 28 | 28 | 28 | 1 | 141 |
| ops-announcements | tap-target | 29 | 29 | 29 | 29 | 29 | 2 | 147 |
| ops-approvals | tap-target | 31 | 31 | 31 | 31 | 31 | 1 | 156 |
| ops-business | tap-target | 32 | 32 | 32 | 32 | 32 | 32 | 192 |
| ops-client | tap-target | 51 | 54 | 55 | 51 | 54 | 55 | 320 |
| ops-clients | word-broken | 0 | 5 | 0 | 0 | 1 | 0 | 6 |
| ops-clients | tap-target | 33 | 58 | 58 | 33 | 58 | 58 | 298 |
| ops-configurator | tap-target | 29 | 29 | 29 | 29 | 29 | 29 | 174 |
| ops-documents | tap-target | 59 | 59 | 59 | 59 | 59 | 59 | 354 |
| ops-efile-acks | tap-target | 28 | 28 | 28 | 28 | 28 | 28 | 168 |
| ops-events | tap-target | 28 | 28 | 28 | 28 | 28 | 28 | 168 |
| ops-executive | word-broken | 2 | 0 | 0 | 2 | 0 | 0 | 4 |
| ops-executive | tap-target | 30 | 30 | 30 | 30 | 30 | 30 | 180 |
| ops-hilo | tap-target | 28 | 28 | 28 | 28 | 28 | 28 | 168 |
| ops-inbox | tap-target | 28 | 28 | 28 | 28 | 28 | 28 | 168 |
| ops-login | tap-target | 5 | 5 | 5 | 5 | 5 | 5 | 30 |
| ops-pipeline | tap-target | 29 | 29 | 29 | 29 | 29 | 29 | 174 |
| ops-queue | tap-target | 53 | 53 | 53 | 53 | 53 | 53 | 318 |
| ops-quote | tap-target | 28 | 28 | 28 | 28 | 28 | 28 | 168 |
| ops-recorder | tap-target | 29 | 29 | 29 | 29 | 29 | 3 | 148 |
| ops-reports | tap-target | 39 | 39 | 39 | 39 | 39 | 39 | 234 |
| ops-returns-no-preparer | tap-target | 29 | 31 | 31 | 29 | 31 | 31 | 182 |
| ops-returns-stage | tap-target | 29 | 29 | 29 | 29 | 29 | 29 | 174 |
| ops-sops | tap-target | 77 | 77 | 77 | 77 | 77 | 77 | 462 |
| ops-tasks | overflow | 0 | 1 | 0 | 0 | 1 | 0 | 2 |
| ops-tasks | tap-target | 51 | 103 | 103 | 51 | 103 | 103 | 514 |
| ops-tasks-boards | word-broken | 1 | 1 | 1 | 1 | 1 | 1 | 6 |
| ops-tasks-boards | tap-target | 28 | 28 | 28 | 28 | 28 | 28 | 168 |
| ops-upload-return | tap-target | 29 | 29 | 29 | 29 | 2 | 29 | 147 |
| portal-consent | tap-target | 4 | 4 | 4 | 4 | 4 | 4 | 24 |
| portal-documents | clipped | 2 | 0 | 0 | 2 | 0 | 0 | 4 |
| portal-documents | tap-target | 17 | 17 | 17 | 15 | 2 | 13 | 81 |
| portal-estimate | tap-target | 20 | 20 | 20 | 18 | 7 | 7 | 92 |
| portal-home | tap-target | 18 | 17 | 17 | 18 | 17 | 17 | 104 |
| portal-invoices | tap-target | 14 | 14 | 14 | 14 | 2 | 14 | 72 |
| portal-login | tap-target | 4 | 4 | 4 | 4 | 4 | 4 | 24 |
| portal-messages | tap-target | 15 | 15 | 15 | 15 | 4 | 15 | 79 |
| portal-notices | tap-target | 13 | 13 | 13 | 13 | 13 | 13 | 78 |
| portal-profile | tap-target | 22 | 22 | 22 | 20 | 9 | 20 | 115 |
| portal-questionnaire | tap-target | 23 | 23 | 23 | 21 | 21 | 21 | 132 |
| portal-request-service | tap-target | 15 | 15 | 15 | 14 | 3 | 14 | 76 |
| portal-resources | tap-target | 13 | 13 | 13 | 13 | 2 | 13 | 67 |
| portal-returns | tap-target | 13 | 13 | 13 | 13 | 2 | 13 | 67 |
| portal-sign | tap-target | 13 | 13 | 13 | 13 | 13 | 2 | 67 |
