# item0-preflight (2026-09-20)

Generated 2026-09-20T06:38:33.396Z by scripts/report-table.mjs from production; 15 row(s).

Item 0, read-only through the deploy key's psql session; booleans and counts only.

```sql
SELECT * FROM (SELECT 'a. active tax_preparer accounts (R11 active = staff.is_active AND role tax_preparer)' AS check, count(*)::text AS value FROM staff st JOIN roles r ON r.id = st.role_id WHERE r.key = 'tax_preparer' AND st.is_active UNION ALL SELECT 'a. rows the Assign preparer and PTIN holder selects list (active, tax_preparer or ceo)', count(*)::text FROM staff st JOIN roles r ON r.id = st.role_id WHERE st.is_active AND r.key IN ('tax_preparer','ceo') UNION ALL SELECT 'a. the preparer account has enrolled MFA (totp_enabled)', coalesce(bool_and(st.totp_enabled), false)::text FROM staff st JOIN roles r ON r.id = st.role_id WHERE r.key = 'tax_preparer' UNION ALL SELECT 'b. BIZ_1120S active in the version in force', (count(*) > 0)::text FROM price_book_items i WHERE i.item_code = 'BIZ_1120S' AND i.is_active AND i.version_id = (SELECT id FROM price_book_versions WHERE effective_from <= current_date ORDER BY effective_from DESC LIMIT 1) UNION ALL SELECT 'b. the version in force', (SELECT version_number::text FROM price_book_versions WHERE effective_from <= current_date ORDER BY effective_from DESC LIMIT 1) UNION ALL SELECT 'c. Brians contact has an email', (count(*) > 0)::text FROM contacts WHERE lower(email) = 'brian@sotoaccounting.com' AND NOT is_archived UNION ALL SELECT 'c. Brians contact has a portal user', (count(*) > 0)::text FROM portal_users pu JOIN contacts c ON c.id = pu.contact_id WHERE lower(c.email) = 'brian@sotoaccounting.com' UNION ALL SELECT 'd. ceo holds the wildcard (so quotes.manage, deposits.override, engagements.create, documents.write, efile.manage)', (count(*) > 0)::text FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.key = 'ceo' AND rp.permission = '*' UNION ALL SELECT 'f. armed: ' || key, 'enabled' FROM automations WHERE enabled) t ORDER BY 1
```

| check | value |
|---|---|
| a. active tax_preparer accounts (R11 active = staff.is_active AND role tax_preparer) | 1 |
| a. rows the Assign preparer and PTIN holder selects list (active, tax_preparer or ceo) | 2 |
| a. the preparer account has enrolled MFA (totp_enabled) | false |
| b. BIZ_1120S active in the version in force | true |
| b. the version in force | 5 |
| c. Brians contact has an email | true |
| c. Brians contact has a portal user | true |
| d. ceo holds the wildcard (so quotes.manage, deposits.override, engagements.create, documents.write, efile.manage) | true |
| f. armed: attachment_acks | enabled |
| f. armed: efile_acknowledgment | enabled |
| f. armed: payment_receipt | enabled |
| f. armed: portal_upload_acks | enabled |
| f. armed: refund_receipt | enabled |
| f. armed: schedule_added_notice | enabled |
| f. armed: void_notice | enabled |
