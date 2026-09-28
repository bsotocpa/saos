# part1-diagnoses (2026-09-27)

Generated 2026-09-28T05:30:41.389Z by scripts/report-table.mjs from production; 17 row(s).

R87, R88, R85, R79: Brian's records on production, read-only, dates and counts only. R88(b)'s Stripe figure is not in this table: Stripe's own Checkout session for SA-2026-0006 was read through its API on the box (amount_total 1000, usd, paid, livemode true).

```sql
SELECT item, value FROM (VALUES
 (1,'R87 §7216 USE answers on his record (count, first answered on)', (SELECT count(*)||', '||min(COALESCE(signed_at,created_at))::date FROM consents WHERE contact_id='250b24a3-7335-444d-9105-c8a00baa72fc' AND type='7216_use')),
 (2,'R87 intake consent envelopes still draft before 0131 (count, queued on)', (SELECT count(*)||', '||min(created_at)::date FROM signature_envelopes WHERE contact_id='250b24a3-7335-444d-9105-c8a00baa72fc' AND type='consent_7216' AND status='draft')),
 (3,'R87 signed packets (count, signed on)', (SELECT count(*)||', '||min(signed_at)::date FROM engagement_packets WHERE contact_id='250b24a3-7335-444d-9105-c8a00baa72fc' AND status='signed')),
 (4,'R87 the new 1040 engagement opened on', (SELECT created_at::date::text FROM engagements WHERE id=(SELECT engagement_id FROM tax_engagements WHERE id='a23d48db-e4c6-49e6-baf3-b254549f196a'))),
 (5,'R88a the 1120S 8879 signed day as stored (tax_engagements.f8879_signed_at)', (SELECT f8879_signed_at::text FROM tax_engagements WHERE id='89efea3b-7345-4e1e-b090-7618c868b428')),
 (6,'R88a the same day on the envelope the portal reads (completed_at)', (SELECT completed_at::text FROM signature_envelopes WHERE tax_engagement_id='89efea3b-7345-4e1e-b090-7618c868b428' AND type='f8879')),
 (7,'R88a that instant read in America/Chicago', (SELECT to_char(completed_at AT TIME ZONE 'America/Chicago','YYYY-MM-DD HH24:MI') FROM signature_envelopes WHERE tax_engagement_id='89efea3b-7345-4e1e-b090-7618c868b428' AND type='f8879')),
 (8,'R88a scan uploaded on', (SELECT d.created_at::date::text FROM documents d JOIN tax_engagements te ON te.f8879_document_id=d.id WHERE te.id='89efea3b-7345-4e1e-b090-7618c868b428')),
 (9,'R88b quote standard deposit vs override (cents)', (SELECT (SELECT sum(pbi.deposit_cents) FROM quote_line_items qli JOIN price_book_items pbi ON pbi.item_code=qli.item_code AND pbi.version_id=q.price_book_version_id WHERE qli.quote_id=q.id)||' vs '||q.deposit_override_cents FROM quotes q WHERE q.id='3309f097-6cb9-4e79-88ef-ddb39036a930')),
 (10,'R88b override set by role, at (UTC), reason given', (SELECT r.key||', '||to_char(q.deposit_override_at,'YYYY-MM-DD HH24:MI')||', '||(q.deposit_override_reason IS NOT NULL)::text FROM quotes q JOIN staff s ON s.id=q.deposit_override_by_staff_id JOIN roles r ON r.id=s.role_id WHERE q.id='3309f097-6cb9-4e79-88ef-ddb39036a930')),
 (11,'R88b invoice SA-2026-0006 total / paid (cents), live Checkout session on file', (SELECT total_cents||' / '||amount_paid_cents||', '||(stripe_checkout_session_id LIKE 'cs_live_%')::text FROM invoices WHERE invoice_number='SA-2026-0006')),
 (12,'R85 quote accepted at (UTC)', (SELECT to_char(accepted_at,'YYYY-MM-DD HH24:MI:SS') FROM quotes WHERE id='3309f097-6cb9-4e79-88ef-ddb39036a930')),
 (13,'R85 estimate locked at (UTC), by role, range (cents)', (SELECT to_char(te.estimate_locked_at,'YYYY-MM-DD HH24:MI:SS')||', '||(SELECT r.key FROM audit_log a JOIN staff s ON s.id=a.actor_id JOIN roles r ON r.id=s.role_id WHERE a.object_id='a23d48db-e4c6-49e6-baf3-b254549f196a' AND a.action='tax_engagement.estimate_locked' LIMIT 1)||', '||te.estimated_fee_min_cents||'-'||te.estimated_fee_max_cents FROM tax_engagements te WHERE te.id='a23d48db-e4c6-49e6-baf3-b254549f196a')),
 (14,'R85 final fee set at (UTC), cents, outside the quoted range, reason given', (SELECT to_char(a.occurred_at,'YYYY-MM-DD HH24:MI:SS')||', '||(a.details->>'final_fee_cents')||', '||(a.details->>'outside_quoted_range')||', '||((SELECT count(*) FROM audit_log b WHERE b.object_id='a23d48db-e4c6-49e6-baf3-b254549f196a' AND b.action='tax_engagement.final_fee_outside_quote' AND b.details->>'reason' IS NOT NULL)>0)::text FROM audit_log a WHERE a.object_id='a23d48db-e4c6-49e6-baf3-b254549f196a' AND a.action='tax_engagement.final_fee_set')),
 (15,'R79 the 1040 quote''s recorded intent and schedules', (SELECT duplicate_intent||', '||array_to_string(duplicate_intent_schedules,',') FROM quotes WHERE id='3309f097-6cb9-4e79-88ef-ddb39036a930')),
 (16,'R79 engagements on his record withdrawn on 2026-09-27', (SELECT count(*)::text FROM engagements WHERE contact_id='250b24a3-7335-444d-9105-c8a00baa72fc' AND status='withdrawn' AND ended_on='2026-09-27')),
 (17,'R79 live engagements under Schedule A when the quote was sent (tax, no business, draft/active/on hold)', (SELECT count(*)::text FROM engagements WHERE contact_id='250b24a3-7335-444d-9105-c8a00baa72fc' AND service_line='tax' AND business_id IS NULL AND status IN ('draft','active','on_hold') AND created_at < '2026-09-27 20:26:37'))
) t(n,item,value) ORDER BY n
```

| item | value |
|---|---|
| R87 §7216 USE answers on his record (count, first answered on) | 1, 2026-09-20 |
| R87 intake consent envelopes still draft before 0131 (count, queued on) | 2, 2026-08-13 |
| R87 signed packets (count, signed on) | 1, 2026-09-20 |
| R87 the new 1040 engagement opened on | 2026-09-27 |
| R88a the 1120S 8879 signed day as stored (tax_engagements.f8879_signed_at) | 2026-09-20 00:00:00+00 |
| R88a the same day on the envelope the portal reads (completed_at) | 2026-09-20 00:00:00+00 |
| R88a that instant read in America/Chicago | 2026-09-19 19:00 |
| R88a scan uploaded on | 2026-09-20 |
| R88b quote standard deposit vs override (cents) | 20000 vs 1000 |
| R88b override set by role, at (UTC), reason given | ceo, 2026-09-27 20:24, true |
| R88b invoice SA-2026-0006 total / paid (cents), live Checkout session on file | 1000 / 1000, true |
| R85 quote accepted at (UTC) | 2026-09-27 20:28:47 |
| R85 estimate locked at (UTC), by role, range (cents) | 2026-09-27 20:33:48, ceo, 44000-44000 |
| R85 final fee set at (UTC), cents, outside the quoted range, reason given | 2026-09-27 20:34:16, 4000, true, true |
| R79 the 1040 quote's recorded intent and schedules | replaces_existing, A |
| R79 engagements on his record withdrawn on 2026-09-27 | 0 |
| R79 live engagements under Schedule A when the quote was sent (tax, no business, draft/active/on hold) | 0 |
