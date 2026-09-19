# status-staff-accounts (2026-09-19)

Generated 2026-09-19T18:07:33.568Z by scripts/report-table.mjs from production; 6 row(s).

Staff accounts on the box: temp passwords, MFA, last sign-in.

```sql
SELECT st.email, r.key AS role, st.is_active::text AS active, st.totp_enabled::text AS mfa_enabled, st.must_change_password::text AS temp_password_pending, st.temp_password_expires_at::date::text AS temp_password_expires, COALESCE(st.last_login_at::date::text, 'never') AS last_login FROM staff st JOIN roles r ON r.id = st.role_id ORDER BY 2, 1
```

| email | role | active | mfa_enabled | temp_password_pending | temp_password_expires | last_login |
|---|---|---|---|---|---|---|
| marian@sotoaccounting.com | bookkeeper | true | false | true | 2026-09-15 | never |
| brian@sotoaccounting.com | ceo | true | true | false |  | 2026-09-19 |
| rene@sotoaccounting.com | comms_billing | true | false | true | 2026-09-15 | never |
| jackson@sotoaccounting.com | ed_coo | true | false | true | 2026-09-15 | never |
| anamaria@sotoaccounting.com | tax_preparer | true | false | true | 2026-09-15 | never |
| laura@sotoaccounting.com | va_entity | true | false | true | 2026-09-15 | never |
