# ack-upload-cleanup (2026-09-26)

Generated 2026-09-26T22:03:30.058Z by scripts/report-table.mjs from production; 16 row(s).

R43 step 2: the 2026-09-20 upload cleaned through the doors (setTaskStatus with the standalone reason; purgeReportIdentifiers), run as the system actor from a sidecar container of the API image with this checkout's apps/api/src mounted. Before-values are the door audit rows and the persistence table; after-values are read now. Withdraw waits for migration 0118 (the withdrawn_at column) to reach the box.

```sql
WITH rep AS (
  SELECT id, raw_text FROM efile_ack_reports WHERE uploaded_at::date = '2026-09-20'
), p AS (SELECT '(?<![0-9A-Za-z])[0-9]{9}(?![0-9A-Za-z])'::text AS re),
t AS (
  SELECT t.* FROM tasks t WHERE t.source_type = 'efile_ack_review' AND EXISTS (SELECT 1 FROM rep WHERE t.source_id LIKE rep.id::text || ':%')
),
closes AS (
  SELECT al.* FROM audit_log al WHERE al.action = 'task.status_changed' AND al.actor_type = 'system'
     AND al.details->>'reason' = 'Raised in error by an acknowledgment parser that could not read the ATX export. No action is needed.'
     AND al.object_id IN (SELECT id::text FROM t)
),
purge AS (
  SELECT al.details FROM audit_log al WHERE al.action = 'efile_ack.identifiers_purged' AND al.object_id IN (SELECT id::text FROM rep) ORDER BY al.occurred_at LIMIT 1
)
SELECT item, before, after FROM (
  SELECT 1 AS o, 'tasks from the upload' AS item, count(*)::text AS before, count(*)::text AS after FROM t
  UNION ALL SELECT 2, 'tasks from the upload open', (SELECT count(*) FROM closes WHERE details->>'from' <> 'completed')::text, (SELECT count(*) FROM t WHERE status NOT IN ('completed', 'cancelled'))::text
  UNION ALL SELECT 3, 'tasks closed through setTaskStatus as the system actor, with the verbatim reason on the audit row', '0', (SELECT count(*) FROM closes)::text
  UNION ALL SELECT 4, 'closed tasks carrying completed_at', '0', (SELECT count(*) FROM t WHERE status = 'completed' AND completed_at IS NOT NULL)::text
  UNION ALL SELECT 5, 'audit rows for those closes with actor_type system and no actor_id', '0', (SELECT count(*) FROM closes WHERE actor_id IS NULL)::text
  UNION ALL SELECT 6, 'raw file nine-digit identifiers', (SELECT details->>'raw_file_identifiers_masked' FROM purge), (SELECT sum((SELECT count(*) FROM regexp_matches(rep.raw_text, (SELECT re FROM p), 'g'))) FROM rep)::text
  UNION ALL SELECT 7, 'raw file masked identifiers (*****dddd)', '0', (SELECT sum((SELECT count(*) FROM regexp_matches(rep.raw_text, '\*\*\*\*\*[0-9]{4}', 'g'))) FROM rep)::text
  UNION ALL SELECT 8, 'raw file characters', '93461', (SELECT sum(length(raw_text)) FROM rep)::text
  UNION ALL SELECT 9, 'ack rows with a nine-digit run in any text column', '0', (SELECT count(*) FROM efile_acknowledgments a JOIN rep ON rep.id = a.report_id WHERE concat_ws(' ', a.client_name_raw, a.disposition_note, a.status_raw, a.submission_id, a.reject_code, a.reject_reason) ~ (SELECT re FROM p))::text
  UNION ALL SELECT 10, 'ack rows the purge rewrote (audit)', '', (SELECT details->>'ack_rows_rewritten' FROM purge)
  UNION ALL SELECT 11, 'tasks with a nine-digit run in title or description', '0', (SELECT count(*) FROM t WHERE concat_ws(' ', title, description) ~ (SELECT re FROM p))::text
  UNION ALL SELECT 12, 'tasks the purge rewrote (audit)', '', (SELECT details->>'tasks_rewritten' FROM purge)
  UNION ALL SELECT 13, 'audit rows on the report or its rows with a nine-digit run in details', '0', (SELECT count(*) FROM audit_log al WHERE al.object_id IN (SELECT id::text FROM rep) AND al.details::text ~ (SELECT re FROM p))::text
  UNION ALL SELECT 14, 'purge audit rows (efile_ack.identifiers_purged) on the report', '0', (SELECT count(*) FROM audit_log al WHERE al.action = 'efile_ack.identifiers_purged' AND al.object_id IN (SELECT id::text FROM rep))::text
  UNION ALL SELECT 15, 'report withdrawn (efile_ack_reports.withdrawn_at present on this database)', 'false', (SELECT count(*) > 0 FROM information_schema.columns WHERE table_name = 'efile_ack_reports' AND column_name = 'withdrawn_at')::text
  UNION ALL SELECT 16, 'report released (any client send queued)', 'false', (SELECT bool_or(released_at IS NOT NULL) FROM efile_ack_reports WHERE id IN (SELECT id FROM rep))::text
) x ORDER BY o
```

| item | before | after |
|---|---|---|
| tasks from the upload | 500 | 500 |
| tasks from the upload open | 500 | 0 |
| tasks closed through setTaskStatus as the system actor, with the verbatim reason on the audit row | 0 | 500 |
| closed tasks carrying completed_at | 0 | 500 |
| audit rows for those closes with actor_type system and no actor_id | 0 | 500 |
| raw file nine-digit identifiers | 500 | 0 |
| raw file masked identifiers (*****dddd) | 0 | 500 |
| raw file characters | 93461 | 93449 |
| ack rows with a nine-digit run in any text column | 0 | 0 |
| ack rows the purge rewrote (audit) |  | 0 |
| tasks with a nine-digit run in title or description | 0 | 0 |
| tasks the purge rewrote (audit) |  | 0 |
| audit rows on the report or its rows with a nine-digit run in details | 0 | 0 |
| purge audit rows (efile_ack.identifiers_purged) on the report | 0 | 1 |
| report withdrawn (efile_ack_reports.withdrawn_at present on this database) | false | false |
| report released (any client send queued) | false | false |
