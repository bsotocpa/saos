# signin-activity-48h (2026-09-20)

Generated 2026-09-20T21:43:16.419Z by scripts/report-table.mjs from production; 7 row(s).

Sign-in related audit rows across ALL contacts in the last 48 hours: sign-in requests that matched no portal user (portal.signin_blocked), links issued, the emails that carried them, logins. is_target_contact marks the quote's contact.

```sql
WITH t AS (SELECT q.id AS quote_id, q.contact_id, u.id AS portal_user_id, q.sent_at FROM quotes q JOIN contacts c ON c.id=q.contact_id JOIN portal_users u ON u.contact_id=q.contact_id WHERE q.sent_at IS NOT NULL AND u.email IS DISTINCT FROM c.email ORDER BY q.sent_at DESC LIMIT 1) SELECT a.occurred_at, a.action, CASE WHEN a.object_type='template' THEN a.object_id END AS template_key, a.contact_id = t.contact_id AS is_target_contact, a.contact_id IS NULL AS no_contact, a.details->>'has_portal_user' AS has_portal_user, a.details->>'task_created' AS task_created, a.details->>'purpose' AS purpose FROM audit_log a, t WHERE a.occurred_at > now() - interval '48 hours' AND (a.action IN ('portal.signin_blocked','magic_link.issued','portal.login','portal.logout','portal.logout_all','quote.sent','quote.accepted','quote.send_failed') OR (a.action='email.sent' AND a.object_id IN ('portal_magic_link','portal_invite','portal_magic_link_hilo','portal_invite_hilo','quote_ready'))) ORDER BY a.occurred_at
```

| occurred_at | action | template_key | is_target_contact | no_contact | has_portal_user | task_created | purpose |
|---|---|---|---|---|---|---|---|
| 2026-09-20 20:52:19.484378+00 | email.sent | quote_ready | t | f |  |  |  |
| 2026-09-20 20:52:19.499422+00 | quote.sent |  | t | f |  |  |  |
| 2026-09-20 20:52:55.990886+00 | portal.signin_blocked |  | t | f | true | true |  |
| 2026-09-20 21:08:47.136396+00 | email.sent | portal_magic_link | t | f |  |  |  |
| 2026-09-20 21:08:47.139961+00 | magic_link.issued |  | t | f |  |  | login |
| 2026-09-20 21:09:17.808593+00 | portal.login |  | t | f |  |  |  |
| 2026-09-20 21:10:26.856658+00 | quote.accepted |  | t | f |  |  |  |
