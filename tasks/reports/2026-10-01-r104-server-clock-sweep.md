# r104-server-clock-sweep (2026-10-01)

Generated 2026-10-01T01:32:48.815Z by scripts/report-table.mjs from the log r104-sweep.log; 42 row(s).

```sql
the R104 sweep of every CURRENT_DATE, now()::date, date_trunc on now(), stored-instant ::date cast and JavaScript UTC day in apps/api/src, packages/db and apps/api/scripts, classified by hand, line numbers as at 42e9c78
```

| class | site (line before the fix) | what it decides | the Chicago-evening case (19:00-24:00 CDT, 18:00 CST) | fixed by |
|---|---|---|---|---|
| c | apps/api/src/modules/pricing/service.ts:70-71 | which price-book version prices quotes, deposits and engagements when no day is given | on a new version's eve the next version is in force from 19:00; on a version's last evening it is already out | priceBookInForce / CHICAGO_TODAY |
| c | apps/api/src/modules/pricing/quotes.ts:82 | the price book a quote composes from | as above | priceBookInForce |
| c | apps/api/src/modules/pricing/quote-routes.ts:130 | the price-book lines the quote builder offers | as above | priceBookInForce |
| c | apps/api/src/modules/pricing/bundles.ts:52 | a bundle's components and discounts | as above | priceBookInForce |
| c | apps/api/src/modules/pricing/packages.ts:39 | a package's price | as above | priceBookInForce |
| c | apps/api/src/modules/pricing/tax-interview.ts:187 | the tax interview's price lookups | as above | priceBookInForce |
| c | apps/api/src/modules/engagements/configurator.ts:177 | the engagement configurator's prices | as above | priceBookInForce |
| c | apps/api/src/modules/engagements/service.ts:55 | the price lock written onto a new engagement | an engagement made after 19:00 on a version's eve locks tomorrow's prices | priceBookInForce |
| c | apps/api/src/modules/engagements/attest-addendum.ts:100 | the attest addendum's price | as for the price book | priceBookInForce |
| c | apps/api/src/modules/tax/resolution-routes.ts:143 | resolution and prior-year pricing | as for the price book | priceBookInForce |
| c | apps/api/src/modules/billing/dunning.ts:44 | the late-fee rate and grace period in force | a fee assessed after 19:00 on a rate change's eve takes the new rate | priceBookInForce |
| c | apps/api/src/modules/tax/pipeline.ts:1164 | a jurisdiction's accepted day when the ATX report gives none | an acknowledgment released after 19:00 is accepted tomorrow | CHICAGO_TODAY |
| c | apps/api/src/modules/tax/pipeline.ts:1174 | the return's federal accepted day, same fallback | as above | CHICAGO_TODAY |
| c | apps/api/src/modules/tax/pipeline.ts:1180 | the return's state accepted day, same fallback | as above | CHICAGO_TODAY |
| c | apps/api/src/modules/tasks/service.ts:499 | My Tasks "Overdue" | after 19:00 every task due today lists as overdue | CHICAGO_TODAY |
| c | apps/api/src/modules/tasks/service.ts:500 | My Tasks "Due today" | after 19:00 it lists tomorrow's tasks and hides today's | CHICAGO_TODAY |
| c | apps/api/src/modules/tasks/service.ts:501 | My Tasks "Due this week" | after 19:00 the week starts tomorrow; today's tasks drop out | CHICAGO_TODAY |
| c | apps/api/src/modules/tasks/service.ts:364 | a recurring task's next due day when it had none (JS UTC day) | completed after 19:00, the next occurrence is due a day late | todayChicago |
| c | apps/api/src/modules/notices/service.ts:142 | when an IRS notice's response deadline escalates to Brian (14 days) | after 19:00 a notice 15 days out escalates (a day early, never late) | CHICAGO_TODAY |
| c | apps/api/src/modules/engagements/close.ts:181 | an engagement's end day when closed without one | closed after 19:00, it ended tomorrow | CHICAGO_TODAY |
| c | apps/api/src/modules/engagements/change-order.ts:175 | the superseded engagement's end day on a change order | accepted after 19:00, it ended tomorrow | CHICAGO_TODAY |
| b | apps/api/src/modules/admin/routes.ts:227 | the Pricing page's "pending" flag on the newest version | from 19:00 on its eve a staged version reads in force | CHICAGO_TODAY |
| b | apps/api/src/modules/crm/health.ts:128 | the health signal "overdue documents" | after 19:00 a request due today counts overdue | CHICAGO_TODAY |
| b | apps/api/src/modules/crm/health.ts:141 | the health signal "red clock" (deadline within 14 days, no documents) | after 19:00 it counts a day early | CHICAGO_TODAY |
| b | apps/api/src/modules/dashboards/service.ts:137 | the executive count "Perfection window closing" | after 19:00 it counts a reject one more day out | CHICAGO_TODAY |
| b | apps/api/src/modules/dashboards/service.ts:141 | the executive count "Vouchers past funder date" | after 19:00 a voucher due today counts as past | CHICAGO_TODAY |
| b | apps/api/src/modules/tasks/service.ts:629 | the team workload "overdue" count | after 19:00 tasks due today count overdue | CHICAGO_TODAY |
| b | apps/api/src/modules/tasks/routes.ts:618 | a time entry's day when none is given | logged after 19:00, dated tomorrow | CHICAGO_TODAY |
| b | packages/db/migrations/0006_ops.js:107 | the time_entries.entry_date column default | as above | migration 0137 |
| b | apps/api/src/modules/forms/service.ts:391 | a Hilo contact's first-contact day (existing contact) | an intake after 19:00 is dated tomorrow | CHICAGO_TODAY |
| b | apps/api/src/modules/forms/service.ts:400 | a Hilo contact's first-contact day (new contact) | as above | CHICAGO_TODAY |
| b | apps/api/src/modules/billing/dunning.ts:97 | an overdue invoice's "overdue since" when it has no due day (sent_at::date) | sent after 19:00, overdue since tomorrow; the dunning count runs a day short | chicagoDayOf |
| b | apps/api/src/modules/tax/routes.ts:489 | "engagement letter signed on" on the return (engagement_letter_signed_at::date) | signed after 19:00, it shows tomorrow | chicagoDayOf |
| b | apps/api/src/modules/portal-auth/onboarding-rescue.ts:115 | an onboarding's age for the Day 60 stall flag (JS UTC day) | opened after 19:00, a day younger: flagged a day late | chicagoDate |
| b | apps/api/src/modules/dashboards/service.ts:84,85,226 | MTD, YTD, Hilo sessions this month (date_trunc on now()) | the month's last evening reads next month | fixed in 1c959bc (receipt run 54) |
| a | apps/api/src/modules/crm/routes.ts:821; tax/pipeline.ts:224,547; tax/routes.ts:451,488 | the signed-8879 day read back (f8879_signed_at::date) | none: written as a day at the session's midnight, read in the same zone | named harmless in check:chicago-dates |
| a | apps/api/src/modules/admin/container-health.ts:151,288 | a once-a-day dedupe key for container alerts | none: the day it names decides nothing | named harmless |
| a | apps/api/src/migration/sources.ts:149,402 | import dates converted from dates built at UTC midnight | none | not a server-clock day |
| a | apps/api/src/modules/tax/deadlines.ts:320; crm/routes.ts:958 | calendar arithmetic on UTC-midnight dates | none | not a server-clock day |
| a | packages/db/seeds/data/schedule_price_lines.mjs:113-114 | a deploy-time seed warning counting live items on unmapped lines | a message only | left |
| a | packages/db/migrations/0061:45, 0064:50 | historic backfills, already run | none | left |
| a | apps/api/scripts (e2e-boot.ts:245,256,422; e2e-fixtures consent-new-engagement.ts:46, path-b-990.ts:72, path-b.ts:111,125, portal-signing.ts:75; live-stripe-check.ts:47; trello-probe.ts:76) | harness fixtures and hand-run scripts reading the book in force | none in production | left |
