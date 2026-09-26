# ack-upload-persistence (2026-09-26)

Generated 2026-09-26T22:00:57.691Z by scripts/report-table.mjs from production; 20 row(s).

R43 step 1, read-only: what the 2026-09-20 E-Files.csv upload persisted. Counts and booleans only; the regex counts standalone nine-digit runs (word-bounded, so hashes and E-file IDs do not count).

```sql
WITH rep AS (
  SELECT id, raw_text, row_count, task_count, matched_count, released_at, filename
    FROM efile_ack_reports WHERE uploaded_at::date = '2026-09-20'
), p AS (SELECT '(?<![0-9A-Za-z])[0-9]{9}(?![0-9A-Za-z])'::text AS re),
t AS (
  SELECT t.* FROM tasks t WHERE t.source_type = 'efile_ack_review' AND EXISTS (SELECT 1 FROM rep WHERE t.source_id LIKE rep.id::text || ':%')
)
SELECT item, value FROM (
  SELECT 1 AS o, 'report rows uploaded 2026-09-20 (the E-Files.csv upload)' AS item, count(*)::text AS value FROM rep
  UNION ALL SELECT 2, 'the filename is E-Files.csv', bool_and(filename ILIKE '%E-Files%')::text FROM rep
  UNION ALL SELECT 3, 'rows parsed (row_count)', sum(row_count)::text FROM rep
  UNION ALL SELECT 4, 'acknowledgment rows persisted (efile_acknowledgments)', count(*)::text FROM efile_acknowledgments a JOIN rep ON rep.id = a.report_id
  UNION ALL SELECT 5, 'rows matched to an SAOS return', count(*)::text FROM efile_acknowledgments a JOIN rep ON rep.id = a.report_id WHERE a.tax_engagement_id IS NOT NULL
  UNION ALL SELECT 6, 'rows whose client_name_raw is empty (the parser read "Client #" as the name)', count(*)::text FROM efile_acknowledgments a JOIN rep ON rep.id = a.report_id WHERE a.client_name_raw = ''
  UNION ALL SELECT 7, 'tasks raised (task_count)', sum(task_count)::text FROM rep
  UNION ALL SELECT 8, 'tasks from the upload (rows in tasks)', count(*)::text FROM t
  UNION ALL SELECT 9, 'tasks from the upload still open', count(*)::text FROM t WHERE status NOT IN ('completed', 'cancelled')
  UNION ALL SELECT 10, 'report released (any client send queued)', bool_or(released_at IS NOT NULL)::text FROM rep
  UNION ALL SELECT 11, 'raw file stored: efile_ack_reports.raw_text, characters', sum(length(raw_text))::text FROM rep
  UNION ALL SELECT 12, 'raw file holds full nine-digit identifiers', bool_or(raw_text ~ (SELECT re FROM p))::text FROM rep
  UNION ALL SELECT 13, 'raw file: count of nine-digit identifier runs', sum((SELECT count(*) FROM regexp_matches(rep.raw_text, (SELECT re FROM p), 'g')))::text FROM rep
  UNION ALL SELECT 14, 'ack rows with a nine-digit run in any text column', count(*)::text FROM efile_acknowledgments a JOIN rep ON rep.id = a.report_id WHERE concat_ws(' ', a.client_name_raw, a.disposition_note, a.status_raw, a.submission_id, a.reject_code, a.reject_reason) ~ (SELECT re FROM p)
  UNION ALL SELECT 15, 'tasks with a nine-digit run in title or description', count(*)::text FROM t WHERE concat_ws(' ', title, description) ~ (SELECT re FROM p)
  UNION ALL SELECT 16, 'tasks whose text carries an export-style name ("LAST, FIRST 2025")', count(*)::text FROM t WHERE concat_ws(' ', title, description) ~ '[A-Z]{2,}, [A-Z][A-Z ]* (19|20)[0-9]{2}'
  UNION ALL SELECT 17, 'tasks whose text carries any export name (client_name_raw was empty, so the title quotes "")', count(*)::text FROM t WHERE title LIKE '%: "" %'
  UNION ALL SELECT 18, 'audit rows on the report or its rows', count(*)::text FROM audit_log al WHERE (al.object_type = 'efile_ack_report' AND al.object_id IN (SELECT id::text FROM rep)) OR (al.object_type = 'efile_ack' AND al.object_id IN (SELECT a.id::text FROM efile_acknowledgments a JOIN rep ON rep.id = a.report_id))
  UNION ALL SELECT 19, 'audit rows on the report or its rows with a nine-digit run in details', count(*)::text FROM audit_log al WHERE ((al.object_type = 'efile_ack_report' AND al.object_id IN (SELECT id::text FROM rep)) OR (al.object_type = 'efile_ack' AND al.object_id IN (SELECT a.id::text FROM efile_acknowledgments a JOIN rep ON rep.id = a.report_id))) AND al.details::text ~ (SELECT re FROM p)
  UNION ALL SELECT 20, 'object storage (MinIO) keys written by the ack module', '0 (the module writes no object: raw_text is its only file store)'
) x ORDER BY o
```

| item | value |
|---|---|
| report rows uploaded 2026-09-20 (the E-Files.csv upload) | 1 |
| the filename is E-Files.csv | true |
| rows parsed (row_count) | 500 |
| acknowledgment rows persisted (efile_acknowledgments) | 500 |
| rows matched to an SAOS return | 0 |
| rows whose client_name_raw is empty (the parser read "Client #" as the name) | 500 |
| tasks raised (task_count) | 500 |
| tasks from the upload (rows in tasks) | 500 |
| tasks from the upload still open | 500 |
| report released (any client send queued) | false |
| raw file stored: efile_ack_reports.raw_text, characters | 93461 |
| raw file holds full nine-digit identifiers | true |
| raw file: count of nine-digit identifier runs | 500 |
| ack rows with a nine-digit run in any text column | 0 |
| tasks with a nine-digit run in title or description | 0 |
| tasks whose text carries an export-style name ("LAST, FIRST 2025") | 0 |
| tasks whose text carries any export name (client_name_raw was empty, so the title quotes "") | 500 |
| audit rows on the report or its rows | 1 |
| audit rows on the report or its rows with a nine-digit run in details | 0 |
| object storage (MinIO) keys written by the ack module | 0 (the module writes no object: raw_text is its only file store) |
