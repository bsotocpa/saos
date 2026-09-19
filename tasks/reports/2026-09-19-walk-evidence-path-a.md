# walk-evidence-path-a (2026-09-19)

Generated 2026-09-19T20:44:12.224Z by scripts/report-table.mjs from the log walk-a.log; 24 row(s).

Rows come from walk-step annotations the specs push while they run; a step with empty cells was not cleared by the harness. A10 is an API call by design: Stripe Checkout is outside SAOS.

```sql
node scripts/walk-evidence.mjs A  (reads apps/e2e/.artifacts/last-run.json from the harness run of 2026-09-19: 23 passed, 1 skipped)
```

| step | what | device | control (page + selector) | roles | harness test | viewport | last run | how | cleared |
|---|---|---|---|---|---|---|---|---|---|
| A1 | Add the business with its EIN, make it primary | laptop | /clients/:id Businesses card, button "Add a business", form#add-business-form, button "Add business" | ceo, comms_billing (contacts.write) | apps/e2e/tests/ops-add-business.spec.ts:47 | phone | passed | tap | yes |
| A1 | Add the business with its EIN, make it primary | laptop | role proof: va_entity sees no button, POST refused 403 | ceo, comms_billing (contacts.write) | apps/e2e/tests/ops-add-business.spec.ts:89 | phone | passed | tap | yes |
| A1 | Add the business with its EIN, make it primary | laptop | /clients/:id Businesses card, button "Add a business", form#add-business-form, button "Add business" | ceo, comms_billing (contacts.write) | apps/e2e/tests/ops-add-business.spec.ts:47 | desk | passed | tap | yes |
| A1 | Add the business with its EIN, make it primary | laptop | role proof: va_entity sees no button, POST refused 403 | ceo, comms_billing (contacts.write) | apps/e2e/tests/ops-add-business.spec.ts:89 | desk | passed | tap | yes |
| A2 | Business-tax quote against it, $0 deposit override with a reason, send | laptop |  |  |  |  |  |  | NO |
| A3 | Accept the quote, sign Schedule B, business onboarding form, upload a document | phone |  |  |  |  |  |  | NO |
| A4 | Deliver the return PDF to the portal | laptop |  |  |  |  |  |  | NO |
| A5 | My Returns shows it | phone | portal /returns (My Returns), the delivered return listed with its file name | client (portal sign-in link) | apps/e2e/tests/portal-returns.spec.ts:38 | phone | passed | tap | yes |
| A6 | Upload the signed 8879-CORP scan with its signed date and the PTIN holder | laptop | /clients/:id Returns card, input[type=file] + "Signed on" + "PTIN holder" + button "Upload the signed 8879" | tax_preparer, ceo (engagements.tax.manage) | apps/e2e/tests/ops-scorp-dry-run.spec.ts:76 | phone | passed | tap | yes |
| A6 | Upload the signed 8879-CORP scan with its signed date and the PTIN holder | laptop | /clients/:id Returns card, input[type=file] + "Signed on" + "PTIN holder" + button "Upload the signed 8879" | tax_preparer, ceo (engagements.tax.manage) | apps/e2e/tests/ops-scorp-dry-run.spec.ts:76 | desk | passed | tap | yes |
| A7 | Set the final fee, ready to file, filed with the PTIN holder | laptop | role proof: ed_coo sees the return row on /clients/:id and none of its controls | tax_preparer, ceo (engagements.tax.manage) | apps/e2e/tests/ops-scorp-dry-run.spec.ts:76 | phone | passed | tap | yes |
| A7 | Set the final fee, ready to file, filed with the PTIN holder | laptop | /clients/:id Returns card, buttons "Set final fee" (modal: Final fee, Reason), "Ready to file", "Mark filed" (modal: PTIN holder) | tax_preparer, ceo (engagements.tax.manage) | apps/e2e/tests/ops-scorp-dry-run.spec.ts:76 | phone | passed | tap | yes |
| A7 | Set the final fee, ready to file, filed with the PTIN holder | laptop | role proof: ed_coo sees the return row on /clients/:id and none of its controls | tax_preparer, ceo (engagements.tax.manage) | apps/e2e/tests/ops-scorp-dry-run.spec.ts:76 | desk | passed | tap | yes |
| A7 | Set the final fee, ready to file, filed with the PTIN holder | laptop | /clients/:id Returns card, buttons "Set final fee" (modal: Final fee, Reason), "Ready to file", "Mark filed" (modal: PTIN holder) | tax_preparer, ceo (engagements.tax.manage) | apps/e2e/tests/ops-scorp-dry-run.spec.ts:76 | desk | passed | tap | yes |
| A8 | Upload the ATX ack report, review the rows, release | laptop | /efile-acks input[type=file], the review rows, button "Release" + modal "Release 2" | ceo (efile.manage) | apps/e2e/tests/ops-scorp-dry-run.spec.ts:76 | phone | passed | tap | yes |
| A8 | Upload the ATX ack report, review the rows, release | laptop | /efile-acks input[type=file], the review rows, button "Release" + modal "Release 2" | ceo (efile.manage) | apps/e2e/tests/ops-scorp-dry-run.spec.ts:76 | desk | passed | tap | yes |
| A9 | Both rows read Sent; two acceptance emails | phone | /efile-acks reopened from the list (button "Open"), both rows reading Sent | ceo (efile.manage) | apps/e2e/tests/ops-scorp-dry-run.spec.ts:76 | phone | passed | tap | yes |
| A9 | Both rows read Sent; two acceptance emails | phone | /efile-acks reopened from the list (button "Open"), both rows reading Sent | ceo (efile.manage) | apps/e2e/tests/ops-scorp-dry-run.spec.ts:76 | desk | passed | tap | yes |
| A10 | Pay the final-fee invoice | phone | Stripe Checkout is outside SAOS; the harness posts the checkout.session.completed event to /webhooks/stripe | client (card) | apps/e2e/tests/ops-scorp-dry-run.spec.ts:76 | phone | passed | api | NO |
| A10 | Pay the final-fee invoice | phone | Stripe Checkout is outside SAOS; the harness posts the checkout.session.completed event to /webhooks/stripe | client (card) | apps/e2e/tests/ops-scorp-dry-run.spec.ts:76 | desk | passed | api | NO |
| A11 | Receipt, the money line, the completed engagement | laptop | / (executive view) money line, outside-the-door line, completed-unpaid tile; /clients/:id engagement row without an open balance | ceo | apps/e2e/tests/ops-scorp-dry-run.spec.ts:76 | phone | passed | tap | yes |
| A11 | Receipt, the money line, the completed engagement | laptop | /clients/:id read at phone: return completed, invoice paid, engagement completed, no open balance | ceo | apps/e2e/tests/ops-scorp-dry-run.spec.ts:247 | phone | passed | tap | yes |
| A11 | Receipt, the money line, the completed engagement | laptop | / (executive view) money line, outside-the-door line, completed-unpaid tile; /clients/:id engagement row without an open balance | ceo | apps/e2e/tests/ops-scorp-dry-run.spec.ts:76 | desk | passed | tap | yes |
| A11 | Receipt, the money line, the completed engagement | laptop | /clients/:id read at desk: return completed, invoice paid, engagement completed, no open balance | ceo | apps/e2e/tests/ops-scorp-dry-run.spec.ts:247 | desk | passed | tap | yes |
