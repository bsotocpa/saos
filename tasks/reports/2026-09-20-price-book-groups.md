# price-book-groups (2026-09-20)

Generated 2026-09-20T23:47:29.716Z by scripts/report-table.mjs from the log price-book-groups.log; 84 row(s).

Every price-book code and the catalog group it sits in for the quote builder (Brian, 2026-09-20). Migration 0116 wrote group_key and sort_order onto every version's rows and the seed sets them on fresh rows; neither creates a price-book version. A row with a note is a code the ruled list did not name: the note says which group is closest and why.

```sql
node scripts/price-book-groups-report.mjs
```

| code | name | group | sort | note |
|---|---|---|---|---|
| BIZ_1120S | Form 1120-S — S corporation | Business returns (business_returns) | 10 |  |
| BIZ_1120 | Form 1120 — C corporation | Business returns (business_returns) | 20 |  |
| BIZ_1065 | Form 1065 — partnership | Business returns (business_returns) | 30 |  |
| BIZ_990 | Form 990 / 990-EZ — exempt organization | Business returns (business_returns) | 40 |  |
| BIZ_1120C | Form 1120-C — housing co-op | Business returns (business_returns) | 50 |  |
| BIZ_1120F | Form 1120-F — foreign corporation | Business returns (business_returns) | 60 |  |
| BIZ_1120H | Form 1120-H — homeowners association | Business returns (business_returns) | 70 |  |
| BIZ_1120POL | Form 1120-POL — political organization | Business returns (business_returns) | 80 |  |
| BIZ_SCH_C | Schedule C (sole prop or SMLLC) | Business returns (business_returns) | 90 |  |
| DEPOSIT_BUSINESS_TAX | Discovery deposit — business tax (retired) | Business returns (business_returns) | 900 | fits none: a retired deposit item, inactive and never offered; kept only because accepted quotes are price-locked to it |
| BIZ_ADDL_STATE | Additional state return (business) | Business add-ons (business_addons) | 10 |  |
| BIZ_AMENDMENT | Amended business return | Business add-ons (business_addons) | 20 |  |
| BIZ_NOTICE_SUPPORT | Notice support (business) | Business add-ons (business_addons) | 30 |  |
| SCORP_CONVERSION_2553 | S corp conversion (Form 2553) | Business add-ons (business_addons) | 40 |  |
| IND_BASE_SINGLE | Individual return — Single | Individual returns (individual_returns) | 10 |  |
| IND_BASE_MFJ | Individual return — Married filing jointly | Individual returns (individual_returns) | 20 |  |
| IND_BASE_MFS | Individual return — Married filing separately | Individual returns (individual_returns) | 30 |  |
| IND_BASE_HOH | Individual return — Head of household | Individual returns (individual_returns) | 40 |  |
| DEPOSIT_1040 | Discovery deposit — 1040 (retired) | Individual returns (individual_returns) | 900 | fits none: a retired deposit item, inactive and never offered; kept only because accepted quotes are price-locked to it |
| IND_ADDL_STATE | Additional state return | Individual schedules and forms (individual_forms) | 10 |  |
| IND_SCH_C | Schedule C (self-employment) | Individual schedules and forms (individual_forms) | 20 |  |
| IND_SCH_A | Schedule A (itemized deductions) | Individual schedules and forms (individual_forms) | 30 |  |
| IND_SCH_B_D | Schedule B/D (interest, dividends, capital gains) | Individual schedules and forms (individual_forms) | 40 |  |
| IND_SCH_E_RENTAL | Schedule E — rental property | Individual schedules and forms (individual_forms) | 50 |  |
| IND_SCH_E_K1 | Schedule E — K-1 | Individual schedules and forms (individual_forms) | 60 |  |
| IND_SCH_H | Schedule H (household employment) | Individual schedules and forms (individual_forms) | 70 |  |
| IND_SCH_EIC | Schedule EIC (earned income credit) | Individual schedules and forms (individual_forms) | 80 |  |
| IND_F8863 | Form 8863 — education credits | Individual schedules and forms (individual_forms) | 90 |  |
| IND_F8995 | Form 8995 — QBI deduction | Individual schedules and forms (individual_forms) | 100 |  |
| IND_F4562 | Form 4562 — depreciation | Individual schedules and forms (individual_forms) | 110 | not named in the ruled list; a form on the individual return |
| IND_F2441 | Form 2441 — dependent care | Individual schedules and forms (individual_forms) | 120 | not named in the ruled list; a form on the individual return |
| IND_F8812 | Form 8812 — child tax credit | Individual schedules and forms (individual_forms) | 130 | not named in the ruled list; a form on the individual return |
| IND_F5695 | Form 5695 — residential energy credits | Individual schedules and forms (individual_forms) | 140 | not named in the ruled list; a form on the individual return |
| IND_F8949_121 | Form 8949 — §121 home sale | Individual schedules and forms (individual_forms) | 150 | not named in the ruled list; a form on the individual return |
| IND_F8936 | Form 8936 — clean vehicle credit | Individual schedules and forms (individual_forms) | 160 | not named in the ruled list; a form on the individual return |
| IND_NOL | NOL carryover | Individual schedules and forms (individual_forms) | 170 | not named in the ruled list; a carryover computed on the individual return |
| IND_W7_ITIN | Form W-7 — ITIN application | Individual schedules and forms (individual_forms) | 180 | not named in the ruled list; a form filed with the individual return |
| IND_W7_ITIN_ADDL | Form W-7 — each additional ITIN | Individual schedules and forms (individual_forms) | 190 | not named in the ruled list; a form filed with the individual return |
| PRIOR_YEAR_SURCHARGE | Prior-year surcharge (returns 3+ years back) | Individual schedules and forms (individual_forms) | 200 | fits none: a per-return surcharge applied automatically to any return more than two years back; listed with the individual forms because it is priced per form |
| IND_AMENDMENT_1040X | Amended return (1040-X) | Individual schedules and forms (individual_forms) | 210 | fits none: the individual counterpart of the business add-ons (amended return); no individual add-ons group was ruled |
| IND_NOTICE_SUPPORT | Notice / penalty / installment support | Individual schedules and forms (individual_forms) | 220 | fits none: the individual counterpart of the business add-ons (notice support); no individual add-ons group was ruled |
| IND_AUDIT_DEFENSE | Audit defense | Individual schedules and forms (individual_forms) | 230 | fits none: the individual counterpart of the business add-ons (audit defense); no individual add-ons group was ruled |
| ENTITY_FORMATION_EIN | Entity formation with EIN | Entity and compliance (entity_compliance) | 10 |  |
| ENTITY_501C3_1023 | 501(c)(3) application (Form 1023) | Entity and compliance (entity_compliance) | 20 |  |
| ENTITY_ANNUAL_REPORT | Annual report filing | Entity and compliance (entity_compliance) | 30 |  |
| ENTITY_AMENDMENT | Entity amendment | Entity and compliance (entity_compliance) | 40 |  |
| ENTITY_DBA | DBA registration | Entity and compliance (entity_compliance) | 50 |  |
| ENTITY_BOI | BOI report | Entity and compliance (entity_compliance) | 60 |  |
| FILING_1099_W2_BASE | 1099/W-2 filing — base | Information returns (information_returns) | 10 |  |
| FILING_1099_W2_PER_FORM | 1099/W-2 filing — per form | Information returns (information_returns) | 20 |  |
| SCOPE_REVIEW_AUDIT | Review / Audit rung | Assurance and audits (assurance) | 10 |  |
| ATTEST_REVIEW | CPA financial statement review | Assurance and audits (assurance) | 20 |  |
| ATTEST_AUDIT | CPA financial statement audit | Assurance and audits (assurance) | 30 |  |
| ATTEST_WC_INS_AUDIT | Workers comp / payroll insurance audit | Assurance and audits (assurance) | 40 |  |
| COO_UNIT | COO services (ops / people / branding catalog) | Advisory (advisory) | 10 |  |
| SPEC_TAX_PLANNING | Tax planning & analysis | Advisory (advisory) | 20 | not named in the ruled list; specialized CPA advisory work |
| SPEC_FORECASTING_BUDGETING | Forecasting / budgeting | Advisory (advisory) | 30 | not named in the ruled list; specialized CPA advisory work |
| SPEC_LOAN_DUE_DILIGENCE | Loan / funding due diligence | Advisory (advisory) | 40 | not named in the ruled list; specialized CPA advisory work |
| SPEC_CPA_CONFIRMATION_LETTERS | CPA letters of confirmation | Advisory (advisory) | 50 | not named in the ruled list; specialized CPA advisory work |
| IND_CPA_LETTER | CPA letters / wealth statements / tax planning | Advisory (advisory) | 60 | not named in the ruled list; CPA letters and tax planning for an individual, closest to the advisory work |
| IND_SPECIALIZED_HOURLY | Specialized services (hourly) | Advisory (advisory) | 70 | not named in the ruled list; specialized hourly work for an individual, closest to the advisory work |
| RES_PENALTY_ABATEMENT | Penalty abatement (first-time or reasonable cause) | Advisory (advisory) | 80 | fits none: tax resolution work under the specialized CPA line; closest to advisory |
| RES_INSTALLMENT_AGREEMENT | Installment agreement setup | Advisory (advisory) | 90 | fits none: tax resolution work under the specialized CPA line; closest to advisory |
| LATE_FEE_MONTHLY | Late fee — monthly rate on past-due balances | Advisory (advisory) | 900 | fits none: a rate on past-due balances, never offered on a quote; filed with its service line (specialized CPA) |
| ACCT_WEEKLY | Accounting — weekly (full management, weekly CPA session) | Recurring services (recurring) | 10 |  |
| ACCT_MONTHLY | Accounting — monthly (full management, monthly CPA session) | Recurring services (recurring) | 20 |  |
| ACCT_QUARTERLY | Accounting — quarterly (full management, quarterly CPA session) | Recurring services (recurring) | 30 |  |
| ACCT_SEMI_ANNUAL | Accounting — semi-annual (full management, semi-annual CPA session) | Recurring services (recurring) | 40 |  |
| SCOPE_FULLMGMT_PAYROLL | Payroll — full management & compliance (W-2/940/941/944/UI) | Recurring services (recurring) | 50 |  |
| SCOPE_FULLMGMT_SALES_TAX | Sales tax — full management & compliance | Recurring services (recurring) | 60 |  |
| SALES_TAX_ST1_FILING | ST-1 sales tax filing | Recurring services (recurring) | 70 |  |
| SCOPE_REG_SETUP | Registration & Setup | Recurring services (recurring) | 80 |  |
| SCOPE_ADMIN_TRAINING | Admin & Training Support | Recurring services (recurring) | 90 |  |
| SETUP_QBO | QuickBooks Online setup | Recurring services (recurring) | 100 | not named in the ruled list; stands up the recurring accounting stack |
| SETUP_PAYROLL | Payroll setup | Recurring services (recurring) | 110 | not named in the ruled list; stands up the recurring payroll stack |
| PASS_QBO | QuickBooks Online subscription (software cost) | Recurring services (recurring) | 120 | not named in the ruled list; a monthly software pass-through billed alongside the recurring plan |
| PASS_QBO_PAYROLL | QBO Payroll subscription (software cost) | Recurring services (recurring) | 130 | not named in the ruled list; a monthly software pass-through billed alongside the recurring plan |
| ACCT_CATCHUP_HOURLY | Catch-up / cleanup (hourly) | Recurring services (recurring) | 140 | fits none: one-time bookkeeping catch-up, hourly; closest to the recurring accounting it precedes |
| RES_BOOKS_RECONSTRUCTION | Books reconstruction (per year, hourly) | Recurring services (recurring) | 150 | fits none: one-time books reconstruction for a resolution year; closest to the recurring accounting it precedes |
| ACCT_PREP_WEEKLY | Prep component — weekly close | Recurring services (recurring) | 900 | fits none: a derivation component, never offered on a quote (display_on_quote false) |
| ACCT_PREP_MONTHLY | Prep component — monthly close | Recurring services (recurring) | 910 | fits none: a derivation component, never offered on a quote (display_on_quote false) |
| ACCT_PREP_QUARTERLY | Prep component — quarterly close | Recurring services (recurring) | 920 | fits none: a derivation component, never offered on a quote (display_on_quote false) |
| ACCT_PREP_SEMI_ANNUAL | Prep component — semi-annual close | Recurring services (recurring) | 930 | fits none: a derivation component, never offered on a quote (display_on_quote false) |
| CPA_SESSION | Session component — one CPA session | Recurring services (recurring) | 940 | fits none: a derivation component, never offered on a quote (display_on_quote false) |
