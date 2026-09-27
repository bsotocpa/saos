# r78-first-engagement-spec (2026-09-27)

Generated 2026-09-27T21:12:57.136Z by scripts/report-table.mjs from the log r78.log; 3 row(s).

R78: the first engagement is the first that carries a line the rule reaches (tax, entity); a withdrawn engagement never consumes it. The code: priorEligibleEngagement in apps/api/src/modules/pricing/referral-discount.ts, read at quote time and at acceptance.

```sql
grep '^✔' on apps/api/test/price-book-v6.spec.ts's R78 test and its second-engagement test in receipt run 25's log (tree fb896e7)
```

| case | how the spec sets it up | expected | receipt run 25 |
|---|---|---|---|
| a Hilo-referred client with a bookkeeping-only engagement quotes a 1040 | an active bookkeeping engagement, no tax or entity engagement | half off at the quote and still half off after acceptance (the same test runs again there) | passed |
| a Hilo-referred client whose only earlier engagement is a withdrawn tax engagement | a withdrawn tax engagement with its reason and end date | half off: a withdrawn engagement never consumes it | passed |
| a Hilo-referred client whose earlier tax engagement is completed | a completed tax engagement | full price, and the builder preview says not_first_engagement | passed |
