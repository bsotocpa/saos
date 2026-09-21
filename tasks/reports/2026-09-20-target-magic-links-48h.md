# target-magic-links-48h (2026-09-20)

Generated 2026-09-20T21:43:45.646Z by scripts/report-table.mjs from production; 1 row(s).

Magic-link tokens issued to the quote contact's portal user in the last 48 hours (the sign-in link is single use: used_at set on redemption).

```sql
WITH t AS (SELECT q.id AS quote_id, q.contact_id, u.id AS portal_user_id, q.sent_at FROM quotes q JOIN contacts c ON c.id=q.contact_id JOIN portal_users u ON u.contact_id=q.contact_id WHERE q.sent_at IS NOT NULL AND u.email IS DISTINCT FROM c.email ORDER BY q.sent_at DESC LIMIT 1) SELECT m.created_at, m.purpose::text, m.expires_at, m.used_at IS NOT NULL AS used, m.used_at, m.expires_at < now() AS expired_now FROM magic_link_tokens m, t WHERE m.portal_user_id=t.portal_user_id AND m.created_at > now() - interval '48 hours' ORDER BY m.created_at
```

| created_at | purpose | expires_at | used | used_at | expired_now |
|---|---|---|---|---|---|
| 2026-09-20 21:08:46.356603+00 | login | 2026-09-20 21:38:46.356603+00 | t | 2026-09-20 21:09:17.797425+00 | t |
