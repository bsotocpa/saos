# date-invariants (2026-09-19)

Generated 2026-09-19T19:36:38.810Z by scripts/report-table.mjs from the log date-invariants.log; 30 row(s).

Every chronology check the code carries: database CHECK constraints and trigger refusals comparing dates, and API comparisons through calendarDay()/daysBetween().

```sql
node scripts/date-invariants.mjs
```

| level | where | what |
|---|---|---|
| db | packages/db/migrations/0002_contacts.js:210 | CHECK (direction <> 'hilo_to_soto' OR status NOT IN ('sent', 'converted') OR disclosure_shown_at IS NOT NULL) |
| db | packages/db/migrations/0030_broadcasts_reviews.js:64 | CHECK (status <> 'sent' OR (approved_by_staff_id IS NOT NULL AND approved_at IS NOT NULL)) |
| db | packages/db/migrations/0035_hilo_events.js:57 | CHECK (ends_at IS NULL OR ends_at > starts_at) |
| db | packages/db/migrations/0038_master_and_schedules.js:91 | CHECK (status <> 'signed' OR signed_at IS NOT NULL) |
| db | packages/db/migrations/0067_outbox.js:59 | CONSTRAINT outbox_sent_has_time CHECK (status <> 'sent' OR sent_at IS NOT NULL), |
| db | packages/db/migrations/0079_delete_orphan_engagement_letters.js:86 | RAISE EXCEPTION |
| db | packages/db/migrations/0100_lifecycle_and_return_invariants.js:90 | RAISE EXCEPTION 'return_without_engagement: engagement % still holds % unfiled return(s); withdraw or complete them first (the withdraw route cascades)', NEW.id |
| app | apps/api/src/modules/admin/routes.ts:161 | if (calendarDay(b.effectiveFrom, 'effectiveFrom') <= calendarDay(cur.effective_from, 'effective_from')) { |
| app | apps/api/src/modules/billing/dunning.ts:123 | const daysOverdue = daysBetween(inv.overdue_since, today); |
| app | apps/api/src/modules/billing/dunning.ts:132 | daysBetween(inv.last_dunning_at.slice(0, 10), today) >= ATTEMPT_SPACING_DAYS; |
| app | apps/api/src/modules/billing/dunning.ts:238 | if (last && daysBetween(last, today) < 30) continue; |
| app | apps/api/src/modules/bookkeeping/routes.ts:62 | if (calendarDay(b.periodEnd, 'periodEnd') < calendarDay(b.periodStart, 'periodStart')) throw new AppError(400, 'bad_period', 'periodEnd must not precede periodS |
| app | apps/api/src/modules/crm/health.ts:245 | daysBetween(calendarDay(c.client_since, 'client_since'), todayChicago()) > UPSELL_TENURE_YEARS * 365.25; |
| app | apps/api/src/modules/crm/routes.ts:408 | if (b.formationDate && calendarDay(b.formationDate, 'formationDate') > calendarDay(todayChicago(), 'today')) throw new AppError(400, 'formation_date_in_future', |
| app | apps/api/src/modules/entity/service.ts:40 | candidate: (year: number, formationDate: string / null) => string / null; |
| app | apps/api/src/modules/entity/service.ts:42 | firstDueYear?: (formationDate: string) => number; |
| app | apps/api/src/modules/grants/vouchers.ts:142 | const daysLeft = daysBetween(today, v.funder_due_date); |
| app | apps/api/src/modules/portal-auth/onboarding-rescue.ts:115 | const ageDays = daysBetween(row.created_at.toISOString().slice(0, 10), today); |
| app | apps/api/src/modules/tax/deadlines.ts:262 | export function daysBetween(from: string, to: string): number { |
| app | apps/api/src/modules/tax/extension-batch.ts:111 | if (calendarDay(today) < calendarDay(window.cutoff, 'cutoff') // calendarDay(today) >= calendarDay(window.deadline, 'deadline')) continue; |
| app | apps/api/src/modules/tax/extension.ts:389 | const daysLeft = r.effective_deadline ? daysBetween(today, r.effective_deadline) : null; |
| app | apps/api/src/modules/tax/extension.ts:436 | daysLeft: daysBetween(today, next.date), |
| app | apps/api/src/modules/tax/extension.ts:471 | if (next && daysBetween(today, next.date) === 7) { |
| app | apps/api/src/modules/tax/pipeline.ts:472 | if (calendarDay(te.perfection_deadline, 'perfection_deadline') < calendarDay(today)) { |
| app | apps/api/src/modules/tax/pipeline.ts:485 | } else if (daysBetween(today, te.perfection_deadline) <= 2 && te.preparer_id) { |
| app | apps/api/src/modules/tax/queue.ts:95 | daysLeft: r.effective_deadline ? daysBetween(today, r.effective_deadline) : null, |
| app | apps/api/src/modules/tax/resolution.ts:71 | return expiry !== null && calendarDay(today) <= calendarDay(expiry, 'refund statute expiry'); |
| app | apps/api/src/modules/tax/resolution.ts:89 | if (calendarDay(today) > calendarDay(expiry, 'refund statute expiry')) { |
| app | apps/api/src/modules/tax/signed-8879.ts:30 | ): Promise<{ taxEngagementId: string; signedOn: string }> { |
| app | apps/api/src/modules/tax/signed-8879.ts:55 | if (calendarDay(input.signedOn, 'signedOn') > calendarDay(todayChicago(), 'today')) throw new AppError(409, 'signed_date_in_future', `The signed date ${input.si |
