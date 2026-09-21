# portal-email-mismatch-counts (2026-09-20)

Generated 2026-09-20T21:43:46.630Z by scripts/report-table.mjs from production; 1 row(s).

Questions (c) and (d): both columns are citext, so IS DISTINCT FROM is already case-insensitive; the lower() column is the same compare spelled out.

```sql
SELECT (SELECT count(*) FROM contacts c WHERE NOT c.is_archived) AS contacts_unarchived, (SELECT count(DISTINCT u.contact_id) FROM portal_users u) AS contacts_with_portal_user, (SELECT count(DISTINCT u.contact_id) FROM portal_users u WHERE u.is_active) AS contacts_with_active_portal_user, (SELECT count(*) FROM portal_users u JOIN contacts c ON c.id=u.contact_id WHERE u.email IS DISTINCT FROM c.email) AS portal_email_differs_citext, (SELECT count(*) FROM portal_users u JOIN contacts c ON c.id=u.contact_id WHERE lower(u.email::text) IS DISTINCT FROM lower(c.email::text)) AS portal_email_differs_lower, (SELECT count(*) FROM portal_users u JOIN contacts c ON c.id=u.contact_id WHERE c.email IS NULL) AS contact_email_null_with_portal_user, (SELECT count(*) FROM portal_users u JOIN contacts c ON c.id=u.contact_id WHERE u.email IS DISTINCT FROM c.email AND u.last_login_at IS NOT NULL) AS differs_and_has_logged_in, (SELECT count(*) FROM portal_users u JOIN contacts c ON c.id=u.contact_id WHERE u.email IS DISTINCT FROM c.email AND u.is_active) AS differs_and_active
```

| contacts_unarchived | contacts_with_portal_user | contacts_with_active_portal_user | portal_email_differs_citext | portal_email_differs_lower | contact_email_null_with_portal_user | differs_and_has_logged_in | differs_and_active |
|---|---|---|---|---|---|---|---|
| 849 | 3 | 3 | 1 | 1 | 0 | 1 | 1 |
