# quote-contact-audit-48h (2026-09-20)

Generated 2026-09-20T21:43:14.636Z by scripts/report-table.mjs from production; 58 row(s).

Every audit row for that quote's contact in the last 48 hours, oldest first. Names, addresses and ids are not selected; object_id is shown only when it is a template key.

```sql
WITH t AS (SELECT q.id AS quote_id, q.contact_id, u.id AS portal_user_id, q.sent_at FROM quotes q JOIN contacts c ON c.id=q.contact_id JOIN portal_users u ON u.contact_id=q.contact_id WHERE q.sent_at IS NOT NULL AND u.email IS DISTINCT FROM c.email ORDER BY q.sent_at DESC LIMIT 1) SELECT a.occurred_at, a.actor_type::text, a.action, a.object_type, CASE WHEN a.object_type='template' THEN a.object_id END AS template_key, a.details->>'purpose' AS purpose, a.details->>'has_portal_user' AS has_portal_user, a.details->>'task_created' AS task_created, a.details->>'transport' AS transport, a.ip IS NOT NULL AS ip_recorded FROM audit_log a, t WHERE a.contact_id=t.contact_id AND a.occurred_at > now() - interval '48 hours' ORDER BY a.occurred_at
```

| occurred_at | actor_type | action | object_type | template_key | purpose | has_portal_user | task_created | transport | ip_recorded |
|---|---|---|---|---|---|---|---|---|---|
| 2026-09-19 17:57:45.397424+00 | staff | contact.viewed | contact |  |  |  |  |  | t |
| 2026-09-19 17:57:45.495649+00 | staff | documents.listed | contact |  |  |  |  |  | t |
| 2026-09-20 01:59:37.476603+00 | staff | contact.viewed | contact |  |  |  |  |  | t |
| 2026-09-20 01:59:37.5381+00 | staff | documents.listed | contact |  |  |  |  |  | t |
| 2026-09-20 02:02:03.707669+00 | staff | business.created | business |  |  |  |  |  | t |
| 2026-09-20 02:02:03.892414+00 | staff | contact.viewed | contact |  |  |  |  |  | t |
| 2026-09-20 02:02:04.011643+00 | staff | documents.listed | contact |  |  |  |  |  | t |
| 2026-09-20 20:41:59.924867+00 | staff | contact.viewed | contact |  |  |  |  |  | t |
| 2026-09-20 20:41:59.997018+00 | staff | documents.listed | contact |  |  |  |  |  | t |
| 2026-09-20 20:49:41.85632+00 | staff | contact.viewed | contact |  |  |  |  |  | t |
| 2026-09-20 20:51:32.312481+00 | staff | quote.created | quote |  |  |  |  |  | f |
| 2026-09-20 20:51:50.157808+00 | staff | quote.deposit_overridden | quote |  |  |  |  |  | f |
| 2026-09-20 20:52:19.484378+00 | system | email.sent | template | quote_ready |  |  |  | smtp | f |
| 2026-09-20 20:52:19.496562+00 | staff | lead.stage_changed | contact |  |  |  |  |  | f |
| 2026-09-20 20:52:19.499422+00 | staff | quote.sent | quote |  |  |  |  |  | f |
| 2026-09-20 20:52:55.990886+00 | system | portal.signin_blocked | contact |  |  | true | true |  | f |
| 2026-09-20 20:58:48.964228+00 | staff | contact.viewed | contact |  |  |  |  |  | t |
| 2026-09-20 20:58:49.05698+00 | staff | documents.listed | contact |  |  |  |  |  | t |
| 2026-09-20 20:59:07.749944+00 | staff | contact.viewed | contact |  |  |  |  |  | t |
| 2026-09-20 20:59:07.825533+00 | staff | documents.listed | contact |  |  |  |  |  | t |
| 2026-09-20 21:08:29.444113+00 | staff | contact.viewed | contact |  |  |  |  |  | t |
| 2026-09-20 21:08:29.526659+00 | staff | documents.listed | contact |  |  |  |  |  | t |
| 2026-09-20 21:08:47.136396+00 | system | email.sent | template | portal_magic_link |  |  |  | smtp | f |
| 2026-09-20 21:08:47.139961+00 | system | magic_link.issued | portal_user |  | login |  |  |  | f |
| 2026-09-20 21:08:47.199566+00 | staff | contact.viewed | contact |  |  |  |  |  | t |
| 2026-09-20 21:08:47.278593+00 | staff | documents.listed | contact |  |  |  |  |  | t |
| 2026-09-20 21:09:17.808593+00 | client | portal.login |  |  |  |  |  |  | t |
| 2026-09-20 21:10:26.856658+00 | system | lead.stage_changed | contact |  |  |  |  |  | f |
| 2026-09-20 21:10:26.856658+00 | staff | engagement.created | engagement |  |  |  |  |  | f |
| 2026-09-20 21:10:26.856658+00 | system | contact.status_changed | contact |  |  |  |  |  | f |
| 2026-09-20 21:10:26.856658+00 | client | quote.accepted | quote |  |  |  |  |  | f |
| 2026-09-20 21:16:59.665553+00 | staff | contact.viewed | contact |  |  |  |  |  | t |
| 2026-09-20 21:16:59.750032+00 | staff | documents.listed | contact |  |  |  |  |  | t |
| 2026-09-20 21:17:14.074276+00 | staff | packet.created | engagement_packet |  |  |  |  |  | f |
| 2026-09-20 21:17:14.140087+00 | staff | contact.viewed | contact |  |  |  |  |  | t |
| 2026-09-20 21:17:14.229863+00 | staff | documents.listed | contact |  |  |  |  |  | t |
| 2026-09-20 21:25:15.296712+00 | staff | packet.sent | engagement_packet |  |  |  |  |  | f |
| 2026-09-20 21:25:15.359846+00 | staff | contact.viewed | contact |  |  |  |  |  | t |
| 2026-09-20 21:25:15.459569+00 | staff | documents.listed | contact |  |  |  |  |  | t |
| 2026-09-20 21:25:51.172881+00 | system | email.sent | template | packet_ready_to_sign |  |  |  | smtp | f |
| 2026-09-20 21:33:18.326599+00 | system | contact.status_changed | contact |  |  |  |  |  | f |
| 2026-09-20 21:33:18.326599+00 | client | packet.signed | engagement_packet |  |  |  |  |  | f |
| 2026-09-20 21:33:18.345648+00 | client | packet.signed_in_portal | engagement_packet |  |  |  |  |  | t |
| 2026-09-20 21:33:18.408047+00 | system | consent.presentation_computed | contact |  |  |  |  |  | f |
| 2026-09-20 21:33:27.643061+00 | system | consent.presentation_computed | contact |  |  |  |  |  | f |
| 2026-09-20 21:33:49.625378+00 | system | consent.presentation_computed | contact |  |  |  |  |  | f |
| 2026-09-20 21:33:49.638133+00 | client | consent.granted | contact |  |  |  |  |  | t |
| 2026-09-20 21:33:49.758345+00 | system | consent.presentation_computed | contact |  |  |  |  |  | f |
| 2026-09-20 21:33:56.505177+00 | system | consent.presentation_computed | contact |  |  |  |  |  | f |
| 2026-09-20 21:33:56.51824+00 | system | consent.presentation_computed | contact |  |  |  |  |  | f |
| 2026-09-20 21:33:56.518935+00 | system | consent.presentation_computed | contact |  |  |  |  |  | f |
| 2026-09-20 21:36:34.047568+00 | client | contact.self_updated | contact |  |  |  |  |  | t |
| 2026-09-20 21:37:20.838683+00 | system | consent.presentation_computed | contact |  |  |  |  |  | f |
| 2026-09-20 21:37:23.109804+00 | system | consent.presentation_computed | contact |  |  |  |  |  | f |
| 2026-09-20 21:37:23.109921+00 | system | consent.presentation_computed | contact |  |  |  |  |  | f |
| 2026-09-20 21:37:23.119247+00 | system | consent.presentation_computed | contact |  |  |  |  |  | f |
| 2026-09-20 21:42:58.580423+00 | staff | contact.viewed | contact |  |  |  |  |  | t |
| 2026-09-20 21:42:58.674773+00 | staff | documents.listed | contact |  |  |  |  |  | t |
