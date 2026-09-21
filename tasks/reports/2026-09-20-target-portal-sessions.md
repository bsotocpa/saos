# target-portal-sessions (2026-09-20)

Generated 2026-09-20T21:44:32.983Z by scripts/report-table.mjs from production; 2 row(s).

Every portal session the quote contact's portal user has ever had, oldest first. live_at_send: whether the session was valid at the moment the proposal was emailed. The browser's signed-in marker (localStorage) outlives an expired session; see apps/portal/lib/api.ts.

```sql
WITH t AS (SELECT q.id AS quote_id, q.contact_id, u.id AS portal_user_id, q.sent_at FROM quotes q JOIN contacts c ON c.id=q.contact_id JOIN portal_users u ON u.contact_id=q.contact_id WHERE q.sent_at IS NOT NULL AND u.email IS DISTINCT FROM c.email ORDER BY q.sent_at DESC LIMIT 1) SELECT s.created_at, s.expires_at, s.revoked_at IS NOT NULL AS revoked, s.expires_at > now() AS live_now, (s.created_at < t.sent_at AND s.expires_at > t.sent_at AND s.revoked_at IS NULL) AS live_at_send, s.created_at < t.sent_at AS created_before_send, s.user_agent IS NOT NULL AS user_agent_recorded FROM portal_sessions s, t WHERE s.portal_user_id=t.portal_user_id ORDER BY s.created_at
```

| created_at | expires_at | revoked | live_now | live_at_send | created_before_send | user_agent_recorded |
|---|---|---|---|---|---|---|
| 2026-08-14 01:27:23.549048+00 | 2026-09-13 01:27:23.549048+00 | f | f | f | t | t |
| 2026-09-20 21:09:17.805988+00 | 2026-10-20 21:09:17.805988+00 | f | t | f | f | t |
