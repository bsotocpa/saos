# price-book-v6-published (2026-09-27)

Generated 2026-09-27T11:39:30.823Z by scripts/report-table.mjs from production; 14 row(s).

R75: price book v6 as published on production by apps/api/scripts/publish-price-book-v6.ts through POST /admin/price-book/versions (a CEO session labelled 'ruled 2026-09-27 R75, applied by script'). effective_to is the exclusive handover day: v5 is in force through 2026-09-30.

```sql
SELECT item, value FROM (VALUES
 (1,'v5 effective_from / effective_to', (SELECT effective_from||' / '||effective_to FROM price_book_versions WHERE id='80d5d24a-ad98-466e-a1f4-be7816d28744')),
 (2,'v5 last day in force', (SELECT (effective_to - 1)::text FROM price_book_versions WHERE id='80d5d24a-ad98-466e-a1f4-be7816d28744')),
 (3,'v6 version_number / effective_from / effective_to', (SELECT version_number||' / '||effective_from||' / '||COALESCE(effective_to::text,'(open)') FROM price_book_versions WHERE id='992e77c9-db60-4063-881b-103fa4fb3020')),
 (4,'v6 lines (v5 lines)', (SELECT count(*)||' ('||(SELECT count(*) FROM price_book_items WHERE version_id='80d5d24a-ad98-466e-a1f4-be7816d28744')||')' FROM price_book_items WHERE version_id='992e77c9-db60-4063-881b-103fa4fb3020')),
 (5,'BIZ_990PF: mode, price, deposit, group, sort (cents)', (SELECT pricing_mode||', '||amount_cents||', '||deposit_cents||', '||group_key||', '||sort_order FROM price_book_items WHERE version_id='992e77c9-db60-4063-881b-103fa4fb3020' AND item_code='BIZ_990PF')),
 (6,'BIZ_990T: mode, price, deposit, group, sort (cents)', (SELECT pricing_mode||', '||amount_cents||', '||deposit_cents||', '||group_key||', '||sort_order FROM price_book_items WHERE version_id='992e77c9-db60-4063-881b-103fa4fb3020' AND item_code='BIZ_990T')),
 (7,'BIZ_990 deposit in v6 (the rule the two follow)', (SELECT deposit_cents::text FROM price_book_items WHERE version_id='992e77c9-db60-4063-881b-103fa4fb3020' AND item_code='BIZ_990')),
 (8,'v6 lines whose catalog group differs from v5', (SELECT count(*)::text FROM price_book_items o JOIN price_book_items n ON n.item_code=o.item_code AND n.version_id='992e77c9-db60-4063-881b-103fa4fb3020' WHERE o.version_id='80d5d24a-ad98-466e-a1f4-be7816d28744' AND n.group_key IS DISTINCT FROM o.group_key)),
 (9,'v6 lines whose price or deposit differs from v5', (SELECT count(*)::text FROM price_book_items o JOIN price_book_items n ON n.item_code=o.item_code AND n.version_id='992e77c9-db60-4063-881b-103fa4fb3020' WHERE o.version_id='80d5d24a-ad98-466e-a1f4-be7816d28744' AND (n.amount_cents IS DISTINCT FROM o.amount_cents OR n.deposit_cents IS DISTINCT FROM o.deposit_cents))),
 (10,'packages: v6 (v5)', (SELECT count(*)||' ('||(SELECT count(*) FROM bundles WHERE version_id='80d5d24a-ad98-466e-a1f4-be7816d28744')||')' FROM bundles WHERE version_id='992e77c9-db60-4063-881b-103fa4fb3020')),
 (11,'package components: v6 (v5)', (SELECT count(*)||' ('||(SELECT count(*) FROM bundle_components c JOIN bundles b ON b.id=c.bundle_id WHERE b.version_id='80d5d24a-ad98-466e-a1f4-be7816d28744')||')' FROM bundle_components c JOIN bundles b ON b.id=c.bundle_id WHERE b.version_id='992e77c9-db60-4063-881b-103fa4fb3020')),
 (12,'discount rule: code, rate, lines, condition, scope', (SELECT rule_code||', '||percent_rate::float||'%, '||array_to_string(applies_to_service_lines::text[], ' + ')||', '||condition||', '||scope FROM price_book_discount_rules WHERE version_id='992e77c9-db60-4063-881b-103fa4fb3020')),
 (13,'audit price_book.version_created: actor label', (SELECT actor_label FROM audit_log WHERE action='price_book.version_created' AND object_id='992e77c9-db60-4063-881b-103fa4fb3020')),
 (14,'script sessions left open', (SELECT count(*)::text FROM staff_sessions WHERE user_agent='script: ruled 2026-09-27 R75, applied by script' AND revoked_at IS NULL))
) t(n, item, value) ORDER BY n
```

| item | value |
|---|---|
| v5 effective_from / effective_to | 2026-08-16 / 2026-10-01 |
| v5 last day in force | 2026-09-30 |
| v6 version_number / effective_from / effective_to | 6 / 2026-10-01 / (open) |
| v6 lines (v5 lines) | 86 (84) |
| BIZ_990PF: mode, price, deposit, group, sort (cents) | flat, 120000, 30000, business_returns, 41 |
| BIZ_990T: mode, price, deposit, group, sort (cents) | flat, 120000, 30000, business_returns, 42 |
| BIZ_990 deposit in v6 (the rule the two follow) | 30000 |
| v6 lines whose catalog group differs from v5 | 0 |
| v6 lines whose price or deposit differs from v5 | 0 |
| packages: v6 (v5) | 2 (2) |
| package components: v6 (v5) | 12 (12) |
| discount rule: code, rate, lines, condition, scope | HILO_REFERRAL, 50%, individual_tax + business_tax + entity_services, referred_by_hilo, first_engagement |
| audit price_book.version_created: actor label | Brian Soto (ruled 2026-09-27 R75, applied by script) |
| script sessions left open | 0 |
