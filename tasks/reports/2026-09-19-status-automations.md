# status-automations (2026-09-19)

Generated 2026-09-19T18:07:35.021Z by scripts/report-table.mjs from production; 19 row(s).

Every registered automation and whether Brian has armed it.

```sql
SELECT key, enabled::text AS armed, updated_at::date::text AS changed FROM automations ORDER BY enabled DESC, key
```

| key | armed | changed |
|---|---|---|
| attachment_acks | true | 2026-08-10 |
| efile_acknowledgment | true | 2026-09-19 |
| payment_receipt | true | 2026-09-10 |
| portal_upload_acks | true | 2026-08-13 |
| refund_receipt | true | 2026-09-10 |
| schedule_added_notice | true | 2026-09-12 |
| void_notice | true | 2026-09-10 |
| annual_report_client_reminders | false | 2026-08-09 |
| ar_dunning | false | 2026-08-09 |
| booking_confirmations | false | 2026-08-14 |
| document_chase | false | 2026-08-09 |
| escalation_ladder | false | 2026-08-09 |
| estimate_reminders | false | 2026-08-09 |
| event_reminders | false | 2026-08-10 |
| extension_notices | false | 2026-08-09 |
| late_fees | false | 2026-08-09 |
| review_requests | false | 2026-08-10 |
| session_recaps | false | 2026-08-10 |
| sos_adverse_client_notice | false | 2026-09-06 |
