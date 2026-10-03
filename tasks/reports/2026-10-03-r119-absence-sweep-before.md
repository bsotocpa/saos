# r119-absence-sweep-before (2026-10-03)

Generated 2026-10-03T00:58:57.066Z by scripts/report-table.mjs from the log r119-sweep-before.log; 22 row(s).

```sql
node scripts/check-absence-waits.mjs --list on the walks as they stood at e2d3711 plus the R118 walk (2026-10-02): every absence assertion with no positive wait since a fixed wait or a navigation; 22 in 12 walk files, each fixed; after the sweep the check reads 0
```

| walk | line | opened by | opened at line | the absence it read |
|---|---|---|---|---|
| ops-add-client.spec.ts | 109 | navigation | 107 | // Receipt run 54: the directory's own list load landed mid-typing and the form lost the names typed // before |
| ops-batch10.spec.ts | 98 | navigation | 97 | await expect(page.locator('section.card', { has: page.getByText(who.overdue.fullName, { exact: true }) }).firs |
| ops-batch10.spec.ts | 100 | navigation | 97 | await expect(portal.locator('section#services').getByTestId('service-overdue'), 'the portal card clears').toHa |
| ops-client-page.spec.ts | 115 | fixed wait | 113 | expect(overflowing, 'send-log rows inside the viewport').toBe(0) |
| ops-consent-new-engagement.spec.ts | 116 | navigation | 114 | await expect(page.locator('[data-testid=envelope-row][data-status=consent-waiting]'), 'nothing waits once answ |
| ops-consent-new-engagement.spec.ts | 117 | navigation | 114 | await expect(page.getByTestId('envelope-row').filter({ hasText: /§7216/ }), 'and no consent row reads "Being p |
| ops-consent-new-engagement.spec.ts | 120 | navigation | 118 | await expect(page.locator('[data-testid=unsigned-row][data-kind=consent]'), 'Home stops asking').toHaveCount(0 |
| ops-filing-corrections.spec.ts | 337 | fixed wait | 336 | await expect(page.getByTestId('correct-filing'), 'no Correct the filing control anywhere on her page').toHaveC |
| ops-filing-corrections.spec.ts | 338 | fixed wait | 336 | await expect(page.getByRole('button', { name: 'Correct the filing' })).toHaveCount(0) |
| ops-path-b.spec.ts | 216 | navigation | 215 | await expect(page.getByRole('button', { name: COPY.pay }), 'the paid invoice offers no way to pay it again').t |
| ops-portal-email-move.spec.ts | 124 | navigation | 123 | await expect(page.getByTestId('portal-email-move-pending'), 'nothing is pending any more').toHaveCount(0) |
| ops-reopen-return.spec.ts | 218 | fixed wait | 217 | await expect(page.getByTestId('reopen-return'), 'no Reopen control anywhere on her page').toHaveCount(0) |
| ops-reopen-return.spec.ts | 219 | fixed wait | 217 | await expect(page.getByRole('button', { name: 'Reopen…' })).toHaveCount(0) |
| ops-return-stepper-switch.spec.ts | 163 | fixed wait | 162 | await expect(card.getByTestId('current-step-control'), 'and gets no control').toHaveCount(0) |
| ops-return-stepper-switch.spec.ts | 164 | fixed wait | 162 | await expect(card.getByTestId('return-details'), 'and no details area').toHaveCount(0) |
| ops-return-stepper-switch.spec.ts | 166 | fixed wait | 162 | await expect(page.getByTestId(id), `${id} is not on her page`).toHaveCount(0) |
| ops-scorp-dry-run.spec.ts | 336 | navigation | 324 | await expect(card.getByTestId('upload-engagement-letter'), 'the paper door leaves the row once the letter is o |
| ops-scorp-dry-run.spec.ts | 416 | fixed wait | 414 | await expect(page.getByRole('button', { name }), `${name} is not on Jaqueline's page`).toHaveCount(0) |
| ops-scorp-dry-run.spec.ts | 420 | fixed wait | 414 | await expect(page.getByTestId(id), `${id} is not on Jaqueline's page`).toHaveCount(0) |
| ops-scorp-dry-run.spec.ts | 635 | navigation | 634 | await expect(page.getByTestId('engagement-open-balance'), 'the open balance is gone once paid').toHaveCount(0) |
| ops-tasks-phone.spec.ts | 73 | fixed wait | 57 | expect(chipRow, 'the backlog is not in the row a person works from').not.toContain('Migration backlog') |
| portal-signing-home.spec.ts | 95 | fixed wait | 94 | await expect(page.locator('[data-testid=unsigned-row]:not([data-kind=consent])'), 'no signed document waits'). |
