# price-book-schedules (2026-09-26)

Generated 2026-09-26T22:53:28.774Z by scripts/report-table.mjs from the log price-book-schedules.log; 84 row(s).

R46 report part (2026-09-26), regenerated after the R46 build. One row per seeded price-book item: the engagement line the quote conversion creates (apps/api/src/modules/pricing/engagement-lines.ts), the schedule(s) today's packet assembly attaches (apps/api/src/modules/engagements/packet.ts resolveSchedules: each live engagement's accepted quote lines, engagement_scope_items, through schedule_for_price_line; withdrawn engagements contribute nothing; an engagement opened by hand falls back to service_schedules by service line and, for tax, to its own return's type), and the schedule(s) under the ruled rule (the accepted quote's lines through packages/db/seeds/data/schedule_price_lines.mjs). The two columns now agree on every row. Derived from the seeds and the code, not from production.

```sql
node --experimental-strip-types scripts/price-book-schedules.mjs
```

| code | price service line | pricing mode | active | engagement line (engagement-lines.ts) | schedules today (packet.ts resolveSchedules) | schedules under the ruled rule (accepted quote lines → schedule_price_lines) |
|---|---|---|---|---|---|---|
| IND_BASE_SINGLE | individual_tax | flat | yes | tax | A | A |
| IND_BASE_MFJ | individual_tax | flat | yes | tax | A | A |
| IND_BASE_MFS | individual_tax | flat | yes | tax | A | A |
| IND_BASE_HOH | individual_tax | flat | yes | tax | A | A |
| IND_ADDL_STATE | individual_tax | flat | yes | tax | A | A |
| IND_SCH_C | individual_tax | flat | yes | tax | A | A |
| IND_SCH_A | individual_tax | flat | yes | tax | A | A |
| IND_SCH_B_D | individual_tax | flat | yes | tax | A | A |
| IND_SCH_E_RENTAL | individual_tax | flat | yes | tax | A | A |
| IND_SCH_E_K1 | individual_tax | flat | yes | tax | A | A |
| IND_SCH_H | individual_tax | flat | yes | tax | A | A |
| IND_SCH_EIC | individual_tax | flat | yes | tax | A | A |
| IND_F8863 | individual_tax | flat | yes | tax | A | A |
| IND_F8995 | individual_tax | flat | yes | tax | A | A |
| IND_F4562 | individual_tax | flat | yes | tax | A | A |
| IND_F2441 | individual_tax | flat | yes | tax | A | A |
| IND_F8812 | individual_tax | flat | yes | tax | A | A |
| IND_W7_ITIN | individual_tax | flat | yes | tax | A | A |
| IND_W7_ITIN_ADDL | individual_tax | flat | yes | tax | A | A |
| IND_F5695 | individual_tax | flat | yes | tax | A | A |
| IND_NOL | individual_tax | flat | yes | tax | A | A |
| IND_F8949_121 | individual_tax | flat | yes | tax | A | A |
| IND_F8936 | individual_tax | flat | yes | tax | A | A |
| IND_AMENDMENT_1040X | individual_tax | flat | yes | tax | A | A |
| IND_NOTICE_SUPPORT | individual_tax | flat | yes | tax | A | A |
| IND_AUDIT_DEFENSE | individual_tax | flat | yes | tax | A | A |
| IND_CPA_LETTER | individual_tax | range | yes | tax | A | A |
| IND_SPECIALIZED_HOURLY | individual_tax | flat | yes | tax | A | A |
| BIZ_SCH_C | business_tax | flat | yes | tax | B | B |
| BIZ_1065 | business_tax | flat | yes | tax | B | B |
| BIZ_1120S | business_tax | flat | yes | tax | B | B |
| BIZ_1120 | business_tax | flat | yes | tax | B | B |
| BIZ_990 | business_tax | flat | yes | tax | B | B |
| BIZ_1120C | business_tax | flat | yes | tax | B | B |
| BIZ_1120F | business_tax | flat | yes | tax | B | B |
| BIZ_1120H | business_tax | flat | yes | tax | B | B |
| BIZ_1120POL | business_tax | flat | yes | tax | B | B |
| BIZ_ADDL_STATE | business_tax | flat | yes | tax | B | B |
| BIZ_AMENDMENT | business_tax | flat | yes | tax | B | B |
| BIZ_NOTICE_SUPPORT | business_tax | flat | yes | tax | B | B |
| ACCT_WEEKLY | recurring_accounting | flat | yes | bookkeeping | C | C |
| ACCT_MONTHLY | recurring_accounting | flat | yes | bookkeeping | C | C |
| ACCT_QUARTERLY | recurring_accounting | flat | yes | bookkeeping | C | C |
| ACCT_SEMI_ANNUAL | recurring_accounting | flat | yes | bookkeeping | C | C |
| ACCT_CATCHUP_HOURLY | recurring_accounting | flat | yes | bookkeeping | C | C |
| ACCT_PREP_WEEKLY | recurring_accounting | flat | yes | bookkeeping | C | C |
| ACCT_PREP_MONTHLY | recurring_accounting | flat | yes | bookkeeping | C | C |
| ACCT_PREP_QUARTERLY | recurring_accounting | flat | yes | bookkeeping | C | C |
| ACCT_PREP_SEMI_ANNUAL | recurring_accounting | flat | yes | bookkeeping | C | C |
| CPA_SESSION | recurring_accounting | flat | yes | bookkeeping | C | C |
| SCOPE_REG_SETUP | recurring_accounting | flat | yes | bookkeeping | C | C |
| SCOPE_REVIEW_AUDIT | attest | flat | yes | attest | F | F |
| SCOPE_ADMIN_TRAINING | recurring_accounting | flat | yes | bookkeeping | C | C |
| SCOPE_FULLMGMT_PAYROLL | recurring_accounting | flat | yes | payroll | C | C |
| SCOPE_FULLMGMT_SALES_TAX | recurring_accounting | flat | yes | sales_tax | C | C |
| SALES_TAX_ST1_FILING | recurring_accounting | flat | yes | sales_tax | C | C |
| SETUP_QBO | setup_conversion | flat | yes | bookkeeping | C | C |
| SETUP_PAYROLL | setup_conversion | flat | yes | bookkeeping | C | C |
| SCORP_CONVERSION_2553 | entity_services | flat | yes | entity | E | E |
| PASS_QBO | software_passthrough | flat | yes | none | none (no engagement is created for this line) | none (schedule_price_lines maps nothing; not a service) |
| PASS_QBO_PAYROLL | software_passthrough | flat | yes | none | none (no engagement is created for this line) | none (schedule_price_lines maps nothing; not a service) |
| FILING_1099_W2_BASE | filings_1099_w2 | flat | yes | payroll | C | C |
| FILING_1099_W2_PER_FORM | filings_1099_w2 | flat | yes | payroll | C | C |
| ENTITY_FORMATION_EIN | entity_services | flat | yes | entity | E | E |
| ENTITY_501C3_1023 | entity_services | flat | yes | entity | E | E |
| ENTITY_ANNUAL_REPORT | entity_services | flat | yes | entity | E | E |
| ENTITY_AMENDMENT | entity_services | flat | yes | entity | E | E |
| ENTITY_DBA | entity_services | flat | yes | entity | E | E |
| ENTITY_BOI | entity_services | flat | yes | entity | E | E |
| ATTEST_REVIEW | attest | flat | yes | attest | F | F |
| ATTEST_AUDIT | attest | flat | yes | attest | F | F |
| ATTEST_WC_INS_AUDIT | attest | flat | yes | attest | F | F |
| SPEC_CPA_CONFIRMATION_LETTERS | specialized_cpa | flat | yes | specialized_cpa | D | D |
| SPEC_LOAN_DUE_DILIGENCE | specialized_cpa | flat | yes | specialized_cpa | D | D |
| SPEC_TAX_PLANNING | specialized_cpa | flat | yes | specialized_cpa | D | D |
| SPEC_FORECASTING_BUDGETING | specialized_cpa | flat | yes | specialized_cpa | D | D |
| COO_UNIT | coo | flat | yes | coo | D | D |
| DEPOSIT_1040 | deposit | flat | no | none | none (no engagement is created for this line) | none (schedule_price_lines maps nothing; not a service) |
| DEPOSIT_BUSINESS_TAX | deposit | flat | no | none | none (no engagement is created for this line) | none (schedule_price_lines maps nothing; not a service) |
| PRIOR_YEAR_SURCHARGE | individual_tax | flat | yes | tax | A | A |
| RES_PENALTY_ABATEMENT | specialized_cpa | flat | yes | specialized_cpa | D | D |
| RES_INSTALLMENT_AGREEMENT | specialized_cpa | flat | yes | specialized_cpa | D | D |
| RES_BOOKS_RECONSTRUCTION | recurring_accounting | flat | yes | bookkeeping | C | C |
| LATE_FEE_MONTHLY | specialized_cpa | percent | yes | specialized_cpa | D | D |
