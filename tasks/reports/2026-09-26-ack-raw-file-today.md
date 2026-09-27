# ack-raw-file-today (2026-09-26)

Generated 2026-09-27T04:22:14.473Z by scripts/report-table.mjs from production; 6 row(s).

R63: what a new ack upload stores. The ingest writes raw_text through maskIdentifiers before the row exists (apps/api/src/modules/tax/efile-ack.ts:432); the ack rows carry taxpayer_last4 only.

```sql
SELECT * FROM (SELECT 'ack reports uploaded 2026-09-26 (after the deploy)' AS item, count(*)::text AS value FROM efile_ack_reports WHERE (uploaded_at AT TIME ZONE 'America/Chicago')::date = DATE '2026-09-26' UNION ALL SELECT 'of those, raw files holding a full nine-digit identifier', count(*)::text FROM efile_ack_reports WHERE (uploaded_at AT TIME ZONE 'America/Chicago')::date = DATE '2026-09-26' AND raw_text ~ '(^|[^0-9])[0-9]{9}([^0-9]|$)' UNION ALL SELECT 'of those, raw files with masked identifiers (*****dddd)', count(*)::text FROM efile_ack_reports WHERE (uploaded_at AT TIME ZONE 'America/Chicago')::date = DATE '2026-09-26' AND raw_text LIKE '%*****%' UNION ALL SELECT 'ack reports, any date, whose raw file holds a full nine-digit identifier', count(*)::text FROM efile_ack_reports WHERE raw_text ~ '(^|[^0-9])[0-9]{9}([^0-9]|$)' UNION ALL SELECT 'acknowledgment rows, any date, with a nine-digit run in any text column', count(*)::text FROM efile_acknowledgments WHERE concat_ws(' ', client_name_raw, disposition_note, status_raw, submission_id, reject_code, reject_reason) ~ '(^|[^0-9])[0-9]{9}([^0-9]|$)' UNION ALL SELECT 'acknowledgment rows carrying taxpayer_last4 only (length 4 or null)', count(*)::text FROM efile_acknowledgments WHERE taxpayer_last4 IS NULL OR length(taxpayer_last4) = 4) t
```

| item | value |
|---|---|
| ack reports uploaded 2026-09-26 (after the deploy) | 0 |
| of those, raw files holding a full nine-digit identifier | 0 |
| of those, raw files with masked identifiers (*****dddd) | 0 |
| ack reports, any date, whose raw file holds a full nine-digit identifier | 0 |
| acknowledgment rows, any date, with a nine-digit run in any text column | 0 |
| acknowledgment rows carrying taxpayer_last4 only (length 4 or null) | 500 |
