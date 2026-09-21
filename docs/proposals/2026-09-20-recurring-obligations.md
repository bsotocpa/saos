# Recurring obligations from a sales-tax or payroll fact (proposal, 2026-09-20, R33)

Report only; nothing below is built. The import now lands `engagements.filing_frequency` and
`engagements.payroll_provider` (apps/api/src/modules/engagements/import-facts.ts); this is what
it would take for those columns to become dated work for comms_billing.

## 1. What exists today

**Cadence on engagements.** `prep_cadence` (packages/db/migrations/0029_recurring_configurator.js:25;
`annual` added in 0105_bookkeeping_facts.js:34) and the S corp floor
(apps/api/src/modules/engagements/configurator.ts:33, enforced :228). Nothing derives a dated task
from `prep_cadence`; the configurator only reads it back (:396-462).

**Annual-report tasks: the one working model.** `entity_compliance` (0003_engagements.js:183) with
`anniversary_mmdd` / `anniversary_kind` (0108_annual_report_anniversary.js:32-56);
`nextAnnualReportDueDate()` (apps/api/src/modules/entity/service.ts:95); `runEntityComplianceJob()`
(:231) flips status at T-60/T-30 from app_settings (:244-251) and calls `createTask({ sourceType:
'annual_report', sourceId: ec.id, dueDate })` (:362-378); the client reminder sits behind the
`annual_report_client_reminders` automation (:397).

**The escalation ladder.** `tasks.waiting_since` / `tasks.ladder_rung` (0013_task_ux_v45.js:31-34);
armed in `setTaskStatus` on entering `waiting_for_input` (apps/api/src/modules/tasks/service.ts:331-343);
run by `runLadderJob()` (:652) behind `isAutomationEnabled('escalation_ladder')` (:665), thresholds
from `app_settings 'ladder.days'` (:682-684), the day-14 call to comms_billing (:740).

**The tasks service.** `createTask()` (tasks/service.ts:77) dedupes on `(source_type, source_id)`
over open statuses (:78-86) and resolves the SOP link from `TASK_TYPE_SOPS`
(apps/api/src/modules/sops/task-types.ts:23). It already carries recurrence: `recurFreq` /
`recurInterval` (:26-51), `advanceDate()` (:278), the next occurrence spawned on completion
(:346-368; the comment names a quarterly ST-1). Role routing: `ownerForRole` /
`alertRecipientForRole` (apps/api/src/staffing.ts:41, :103).

**The scheduler.** `startScheduler()` (apps/api/src/jobs/daily.ts:152) ticks every 15 minutes (:30)
and runs `DAILY_JOBS` (:65-121) once per calendar day, idempotent through an audit_log run record
(`runJobsIsolated` :123). `entity_compliance` :71, `escalation_ladder` :93. Client-facing sends sit
behind `isAutomationEnabled()` (apps/api/src/automations.ts:54; keys :21-45).

**Deadlines.** Tax only: `THE_TABLE` (apps/api/src/modules/tax/deadlines.ts:42), `originalDeadline`
(:145), `extendedDeadline` (:164), `rollToBusinessDay` (:115). No ST-1, 941, 940 or state
withholding date exists anywhere (greps `941`, `ST-1`, `sales_tax`, `payroll`, `filing_frequency`
over `*.ts` and sops.mjs). Bookkeeping `close_cycles` (0024_books_close_cycle.js:42-63) are created
by hand (bookkeeping/routes.ts:63), never by a job.

**Sales tax and payroll in code.** Plumbing only (period.ts:26, engagement-lines.ts:58). No task
type, automation key, daily job or SOP page.

## 2. A sales-tax fact becomes dated tasks

1. **A deadline table, not a date in code.** `apps/api/src/modules/sales-tax/deadlines.ts` holding
   `ST_DEADLINES` beside `THE_TABLE`: Illinois ST-1 due the 20th after the month (monthly), the 20th
   after quarter end (quarterly), January 20 (annual); one row per state and frequency;
   `dueDateFor(frequency, periodEnd, state)` through `rollToBusinessDay`. `quarterly_or_annual`
   yields no date and a `sales_tax_frequency_unresolved` task instead — 0106's ambiguity is
   resolved by a person, never by a default.
2. **One task per period, from a job.** `sales_tax_obligations` in `DAILY_JOBS` (daily.ts:65-121):
   for every active `sales_tax` engagement with a frequency, `createTask({ source: 'system',
   sourceType: 'sales_tax_filing', sourceId: '<engagement_id>:<period_end>', dueDate,
   engagementId, businessId, assignedStaffId: ownerForRole('comms_billing') })`. The dedupe key is
   engagement + period, so the job is idempotent like `entity_compliance`. Lead time
   (`sales_tax.lead_days`) lives in `app_settings`, not in code.
3. **Why a job and not `recurFreq`.** Recurrence spawns on completion (:346-368); a task nobody
   closed spawns nothing, and the obligation exists either way.
4. **Waiting on the client** goes through `setTaskStatus(waiting_for_input)`, which arms the
   existing ladder (:331-343). No new ladder.
5. **Client-facing.** None at first. A "send the period's sales figures" notice, if ever wanted, is
   a new `AUTOMATION_KEYS` entry seeded `enabled = false`, an EN/ES template and a gate check in
   the job — never a send from the task.
6. **Registry.** Both task types in `TASK_TYPE_SOPS` with SOP slugs, or
   `scripts/check-task-sop-hooks.mjs` fails the build.

## 3. A payroll fact becomes dated tasks

1. **The same deadline table, a second section:** 941 due the last day of the month after quarter
   end (Apr 30, Jul 31, Oct 31, Jan 31); 940 and W-2/W-3 Jan 31; IL-941 the same quarterly dates;
   IL UI-3/40 the month after the quarter. Deposit schedules are out of scope: the firm does not
   run the deposits, and a wrong deposit date is worse than none.
2. **What the provider changes.** A set `payroll_provider` means the provider files; the firm's
   task is *confirm and pull the copies*, not *prepare*. So the job creates
   `payroll_quarterly_confirm` when a provider is set and `payroll_quarterly_file` when it is NULL,
   same due date, different SOP. Nothing branches on the provider's value, only on its presence.
3. **The job**, `payroll_obligations` in `DAILY_JOBS`: one task per active `payroll` engagement per
   quarter, `sourceId: '<engagement_id>:<quarter>'`, plus one `payroll_year_end` task each December
   for the W-2 and 940, all to comms_billing. Idempotent the same way.
4. **Waiting, ladder, client sends, registry:** as in section 2. A closed payroll never became an
   active engagement (import-facts.ts), so the job creates nothing for it.

## 4. The SOPs each proposal needs

| SOP | Owner | Steps |
|---|---|---|
| `rene-sales-tax-filing` (`sales_tax_filing`) | comms_billing | 1. Confirm the period's sales figures are in the books. 2. File the ST-1 in MyTax Illinois. 3. Record the confirmation number and amount on the task. 4. Figures missing: set waiting-for-input; the ladder runs. |
| `rene-sales-tax-frequency-unresolved` (`sales_tax_frequency_unresolved`) | comms_billing | 1. Read the assigned frequency in MyTax. 2. Set it on the engagement. 3. Close; the next job run creates the dated task. |
| `rene-payroll-quarterly-confirm` (`payroll_quarterly_confirm`) | comms_billing | 1. Confirm in the provider that the 941 and state returns were accepted. 2. Save the copies to the client's documents (portal, never email). 3. Record the acceptance dates. |
| `rene-payroll-quarterly-file` (`payroll_quarterly_file`) | comms_billing | 1. Reconcile the quarter's payroll register. 2. File the 941, IL-941 and UI-3/40. 3. Record confirmations; escalate a deposit shortfall to Brian the same day. |
| `rene-payroll-year-end` (`payroll_year_end`) | comms_billing | 1. Reconcile the four quarters to W-3 totals. 2. File 940 and W-2/W-3, or confirm the provider did. 3. Deliver W-2s through the portal. |

All admin-editable, seeded like the existing pages (packages/db/seeds/data/sops.mjs).
