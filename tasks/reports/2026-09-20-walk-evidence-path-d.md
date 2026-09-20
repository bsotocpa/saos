# walk-evidence-path-d (2026-09-20)

Generated 2026-09-20T04:45:36.864Z by scripts/report-table.mjs from the log walk-D.log; 8 row(s).

The R17 taps: Void invoice and the test-client flag.

```sql
node scripts/walk-evidence.mjs D  (reads apps/e2e/.artifacts/last-run.json from the harness run of 2026-09-20)
```

| step | what | device | control (page + selector) | roles | harness test | viewport | last run | how | cleared |
|---|---|---|---|---|---|---|---|---|---|
| D1 | Void a sent invoice from the client page: a reason, and the row reads cancelled with that reason and the actor | phone + laptop | /clients/:id Invoices card, button "Void…" → ask() modal, textarea, button "Void invoice" | ceo, comms_billing (billing.manage) | apps/e2e/tests/ops-billing-taps.spec.ts:93 | phone | passed | tap | yes |
| D1 | Void a sent invoice from the client page: a reason, and the row reads cancelled with that reason and the actor | phone + laptop | role proof: bookkeeper sees no invoice and no Void control, POST /invoices/:id/void refused 403 | ceo, comms_billing (billing.manage) | apps/e2e/tests/ops-billing-taps.spec.ts:217 | phone | passed | tap | yes |
| D1 | Void a sent invoice from the client page: a reason, and the row reads cancelled with that reason and the actor | phone + laptop | /clients/:id Invoices card, button "Void…" → ask() modal, textarea, button "Void invoice" | ceo, comms_billing (billing.manage) | apps/e2e/tests/ops-billing-taps.spec.ts:93 | desk | passed | tap | yes |
| D1 | Void a sent invoice from the client page: a reason, and the row reads cancelled with that reason and the actor | phone + laptop | role proof: bookkeeper sees no invoice and no Void control, POST /invoices/:id/void refused 403 | ceo, comms_billing (billing.manage) | apps/e2e/tests/ops-billing-taps.spec.ts:217 | desk | passed | tap | yes |
| D2 | Flag a contact as a test record: the note, and the record leaves every report and list | phone + laptop | /clients/:id header, button "Flag as a test record…" → ask() modal, textarea, button "Flag as a test record" | ceo, comms_billing (contacts.write) | apps/e2e/tests/ops-billing-taps.spec.ts:155 | phone | passed | tap | yes |
| D2 | Flag a contact as a test record: the note, and the record leaves every report and list | phone + laptop | role proof: bookkeeper sees no flag control, POST /contacts/:id/archive refused 403 | ceo, comms_billing (contacts.write) | apps/e2e/tests/ops-billing-taps.spec.ts:217 | phone | passed | tap | yes |
| D2 | Flag a contact as a test record: the note, and the record leaves every report and list | phone + laptop | /clients/:id header, button "Flag as a test record…" → ask() modal, textarea, button "Flag as a test record" | ceo, comms_billing (contacts.write) | apps/e2e/tests/ops-billing-taps.spec.ts:155 | desk | passed | tap | yes |
| D2 | Flag a contact as a test record: the note, and the record leaves every report and list | phone + laptop | role proof: bookkeeper sees no flag control, POST /contacts/:id/archive refused 403 | ceo, comms_billing (contacts.write) | apps/e2e/tests/ops-billing-taps.spec.ts:217 | desk | passed | tap | yes |
