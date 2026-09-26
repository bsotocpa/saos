# Day-two effects of imported engagements (proposal, 2026-09-26, R58)

Report only; nothing is built. Source: `tasks/reports/2026-09-26-day-two-deltas.md` (saos_r58_copy,
image f3dc0827a73d, importer at HEAD 00b8352; mailer replaced by a counter, Stripe stubbed, Twilio
blanked, automations as copied from production).

## What the daily jobs changed

Nothing a client could see. All 28 `DAILY_JOBS` (`apps/api/src/jobs/daily.ts:77-134`) plus
`runHealthRefresh` ran once after the import: tasks 1281 -> 1281, invoices 6 -> 6, outbox 8 -> 8,
notifications 17 -> 17, mailer calls 0, `job.failed` rows 0. Every job returned `skipped=true`
except `health_refresh` (363 contacts re-scored, 0 red alerts). Revenue, pipeline and the CEO's
needs-you-today rollup were identical before and after the jobs.

## What the import itself changed

- 105 engagements (44 tax, 30 sales_tax, 31 payroll), 44 returns, 13 contacts, 89 businesses.
- 128 tasks, all Trello card types (114 `trello_ar_worklist`, 8 `trello_amendment`,
  5 `trello_notify_client`, 1 `trello_books_review`): 100 to comms_billing, 20 to the CEO, 8 to the
  tax_preparer. The CEO's "Needs you today" grew 5 -> 25 (19 AR worklist, 1 books review).
- No "Start onboarding" task: 8 before, 8 after, 8 after the jobs. It exists only on quote
  acceptance (`apps/api/src/modules/pricing/quotes.ts:1307`).
- Executive view: open returns 1 -> 36 (1,000 -> 21,000 cents), `efileRejectsOpen` 0 -> 2 (two
  imported returns at `rejected`), tax_preparer open returns 0 -> 34, comms_billing open tasks
  3 -> 103.

## The sales-tax and payroll engagements

61 created (30 sales_tax with `filing_frequency`; 31 payroll, 24 with `payroll_provider`), active,
`period_key = 'ongoing'`. They caused **0 invoices, 0 outbox rows, 0 tasks, 0 notifications**,
before and after the jobs. Why: no daily job bills by service line. The only invoice factories are
`invoiceForFiledEngagement` (`apps/api/src/modules/billing/service.ts:318`, called from
`apps/api/src/modules/tax/pipeline.ts:333` at `filed`) and the quote-acceptance deposit path;
neither reaches an ongoing engagement. The ruling holds today by absence, not by a guard.

## The one invoice, and where it came from

The only invoice (+1 `sent`, 20,000 cents), notification (+1 `invoice_generated`,
`billing/service.ts:420`), engagement, filed return and `outbox.refused_in_import` row were made by
the importer's own sabotage probe (`apps/api/scripts/trello-import.ts:406-500`, run unconditionally
at `:495`): a synthetic `is_test` contact walked to `filed`. `is_test` keeps it out of revenue and
A/R (`apps/api/src/modules/dashboards/service.ts:29-48`), but it shows as a filed return
(`filed` 1 -> 2), a `sent` invoice and a real alert to a staff member, and on the production import
it would stay.

## Latent effects for later days (gated today)

- `entity_compliance` (`apps/api/src/modules/entity/service.ts:231`): 43 imported anniversaries
  will raise staff tasks as windows open; client reminders gated (`:397`).
- `document_chase`: 11 imported returns sit at `documents_requested`; gated and dependent on
  `docs_requested_at`, which the import does not stamp.
- `health_refresh` (`apps/api/src/modules/crm/health.ts:172`) can raise internal `health_red`
  alerts (`:224-236`).

## What to suppress

1. **The probe on a non-copy database.** Gate probe A behind the `_copy` check that already guards
   `--unsafe-no-import-mode` (`trello-import.ts:129`), or delete its rows at the end. It is the sole
   source of every invoice and notification delta here.
2. **A flag on the engagement, not a guard per job.** The import sets `work_paused_at` with
   `work_pause_source = 'import'` (or a new `billing_hold_reason`) on every `source = 'trello'`
   engagement with `period_key = 'ongoing'`; a person clears it on the client page. Every present
   and future invoice factory refuses a held engagement and counts the refusal in its run record.
   One predicate, checked where money is made, survives the 2026-09-20 recurring-billing proposal.
3. **Keep the import context** (`apps/api/src/outbox.ts:165-170`); name "import provenance" as its
   own suppression reason in job run records.
4. **Do not suppress the tasks.** They are the migrated work; if 5 -> 25 on the CEO's rollup is
   unwanted, that is a board-column choice, not a gate.
