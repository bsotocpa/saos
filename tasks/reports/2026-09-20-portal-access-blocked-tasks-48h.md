# portal-access-blocked-tasks-48h (2026-09-20)

Generated 2026-09-20T21:43:44.599Z by scripts/report-table.mjs from production; 1 row(s).

Tasks the sign-in request route creates when a KNOWN contact asks for a link on an address with no portal user (source_type portal_access_blocked), last 48 hours.

```sql
WITH t AS (SELECT q.id AS quote_id, q.contact_id, u.id AS portal_user_id, q.sent_at FROM quotes q JOIN contacts c ON c.id=q.contact_id JOIN portal_users u ON u.contact_id=q.contact_id WHERE q.sent_at IS NOT NULL AND u.email IS DISTINCT FROM c.email ORDER BY q.sent_at DESC LIMIT 1) SELECT k.created_at, k.status::text, k.contact_id = t.contact_id AS is_target_contact FROM tasks k, t WHERE k.source_type='portal_access_blocked' AND k.created_at > now() - interval '48 hours' ORDER BY k.created_at
```

| created_at | status | is_target_contact |
|---|---|---|
| 2026-09-20 20:52:55.987283+00 | not_started | t |
