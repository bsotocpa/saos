# path-b-preflight (2026-09-27)

Generated 2026-09-27T09:47:21.611Z by scripts/report-table.mjs from production; 21 row(s).

R73: Path B preflight on production, read-only. Brian's contact and Ana-Maria's staff row by id. Rows 6 and 7: the send gate before and after today's fix (apps/api/src/modules/engagements/period.ts activeEngagementsFor now reads the business, as migration 0098's index does).

```sql
SELECT item, value FROM (VALUES
 (1,'live individual (no business) engagements on Brian''s contact', (SELECT count(*) FROM engagements WHERE contact_id='250b24a3-7335-444d-9105-c8a00baa72fc' AND status IN ('draft','active','on_hold') AND business_id IS NULL)::text),
 (2,'live engagements on Brian''s contact, any (the 1120-S, on his business)', (SELECT count(*) FROM engagements WHERE contact_id='250b24a3-7335-444d-9105-c8a00baa72fc' AND status IN ('draft','active','on_hold'))::text),
 (3,'withdrawn engagements on Brian''s contact whose return is a 1040', (SELECT count(DISTINCT e.id) FROM engagements e JOIN tax_engagements te ON te.engagement_id=e.id WHERE e.contact_id='250b24a3-7335-444d-9105-c8a00baa72fc' AND e.status='withdrawn' AND te.return_type='1040')::text),
 (4,'quoted scope lines on those withdrawn engagements', (SELECT count(*) FROM engagement_scope_items s JOIN engagements e ON e.id=s.engagement_id WHERE e.contact_id='250b24a3-7335-444d-9105-c8a00baa72fc' AND e.status='withdrawn')::text),
 (5,'1040 returns the packet reads from live engagements (R46 filter)', (SELECT count(*) FROM tax_engagements te JOIN engagements e ON e.id=te.engagement_id WHERE e.contact_id='250b24a3-7335-444d-9105-c8a00baa72fc' AND e.status IN ('draft','active','on_hold') AND te.stage<>'withdrawn' AND te.return_type='1040')::text),
 (6,'active 2025 tax engagements the send gate matched for a personal 1040 quote BEFORE the fix (any business)', (SELECT count(*) FROM engagements WHERE contact_id='250b24a3-7335-444d-9105-c8a00baa72fc' AND service_line='tax' AND period_key='2025' AND status IN ('active','on_hold'))::text),
 (7,'active 2025 tax engagements the send gate matches AFTER the fix (no business, as the database index reads it)', (SELECT count(*) FROM engagements WHERE contact_id='250b24a3-7335-444d-9105-c8a00baa72fc' AND service_line='tax' AND period_key='2025' AND status IN ('active','on_hold') AND business_id IS NULL)::text),
 (8,'v5 in force (effective_to empty)', (SELECT (effective_to IS NULL)::text FROM price_book_versions WHERE id='80d5d24a-ad98-466e-a1f4-be7816d28744')),
 (9,'IND_BASE_* lines active in v5', (SELECT count(*) FROM price_book_items WHERE version_id='80d5d24a-ad98-466e-a1f4-be7816d28744' AND item_code LIKE 'IND_BASE_%' AND is_active)::text),
 (10,'individual schedule and form lines active in v5 (group individual_forms)', (SELECT count(*) FROM price_book_items WHERE version_id='80d5d24a-ad98-466e-a1f4-be7816d28744' AND group_key='individual_forms' AND is_active)::text),
 (11,'  of those, lines carrying a deposit', (SELECT count(*) FROM price_book_items WHERE version_id='80d5d24a-ad98-466e-a1f4-be7816d28744' AND group_key='individual_forms' AND is_active AND deposit_cents IS NOT NULL)::text),
 (12,'v5 IND_BASE_SINGLE price / deposit (cents)', (SELECT amount_cents||' / '||deposit_cents FROM price_book_items WHERE version_id='80d5d24a-ad98-466e-a1f4-be7816d28744' AND item_code='IND_BASE_SINGLE')),
 (13,'v5 IND_BASE_MFJ, MFS, HOH price / deposit (cents)', (SELECT string_agg(item_code||' '||amount_cents||' / '||deposit_cents, ' · ' ORDER BY item_code) FROM price_book_items WHERE version_id='80d5d24a-ad98-466e-a1f4-be7816d28744' AND item_code IN ('IND_BASE_MFJ','IND_BASE_MFS','IND_BASE_HOH'))),
 (14,'Brian''s portal user active', (SELECT bool_and(is_active)::text FROM portal_users WHERE contact_id='250b24a3-7335-444d-9105-c8a00baa72fc')),
 (15,'Brian''s portal sign-in address equals his contact email', (SELECT bool_and(lower(pu.email)=lower(c.email))::text FROM portal_users pu JOIN contacts c ON c.id=pu.contact_id WHERE c.id='250b24a3-7335-444d-9105-c8a00baa72fc')),
 (16,'sign-in moves ever offered on his portal user (R45)', (SELECT count(*) FROM portal_email_changes pec JOIN portal_users pu ON pu.id=pec.portal_user_id WHERE pu.contact_id='250b24a3-7335-444d-9105-c8a00baa72fc')::text),
 (17,'Ana-Maria active, role tax_preparer', (SELECT (s.is_active AND r.key='tax_preparer')::text FROM staff s JOIN roles r ON r.id=s.role_id WHERE s.id='12e9bc33-7452-48b1-bcff-84ef6af7e18b')),
 (18,'Ana-Maria in the Assign preparer / PTIN holder list (active, role tax_preparer or ceo)', (SELECT (s.is_active AND r.key IN ('tax_preparer','ceo'))::text FROM staff s JOIN roles r ON r.id=s.role_id WHERE s.id='12e9bc33-7452-48b1-bcff-84ef6af7e18b')),
 (19,'Ana-Maria has ever signed in', (SELECT (last_login_at IS NOT NULL)::text FROM staff WHERE id='12e9bc33-7452-48b1-bcff-84ef6af7e18b')),
 (20,'Ana-Maria temporary password expired', (SELECT (temp_password_expires_at < now())::text FROM staff WHERE id='12e9bc33-7452-48b1-bcff-84ef6af7e18b')),
 (21,'Ana-Maria MFA enrolled', (SELECT totp_enabled::text FROM staff WHERE id='12e9bc33-7452-48b1-bcff-84ef6af7e18b'))
) t(n, item, value) ORDER BY n
```

| item | value |
|---|---|
| live individual (no business) engagements on Brian's contact | 0 |
| live engagements on Brian's contact, any (the 1120-S, on his business) | 1 |
| withdrawn engagements on Brian's contact whose return is a 1040 | 2 |
| quoted scope lines on those withdrawn engagements | 0 |
| 1040 returns the packet reads from live engagements (R46 filter) | 0 |
| active 2025 tax engagements the send gate matched for a personal 1040 quote BEFORE the fix (any business) | 1 |
| active 2025 tax engagements the send gate matches AFTER the fix (no business, as the database index reads it) | 0 |
| v5 in force (effective_to empty) | true |
| IND_BASE_* lines active in v5 | 4 |
| individual schedule and form lines active in v5 (group individual_forms) | 23 |
|   of those, lines carrying a deposit | 0 |
| v5 IND_BASE_SINGLE price / deposit (cents) | 20000 / 20000 |
| v5 IND_BASE_MFJ, MFS, HOH price / deposit (cents) | IND_BASE_HOH 25000 / 20000 · IND_BASE_MFJ 25000 / 20000 · IND_BASE_MFS 25000 / 20000 |
| Brian's portal user active | true |
| Brian's portal sign-in address equals his contact email | false |
| sign-in moves ever offered on his portal user (R45) | 0 |
| Ana-Maria active, role tax_preparer | true |
| Ana-Maria in the Assign preparer / PTIN holder list (active, role tax_preparer or ceo) | true |
| Ana-Maria has ever signed in | false |
| Ana-Maria temporary password expired | true |
| Ana-Maria MFA enrolled | false |
