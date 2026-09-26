# container-task-closed (2026-09-26)

Generated 2026-09-26T22:21:06.943Z by scripts/report-table.mjs from production; 1 row(s).

R52: the same task after the one-off closed it through setTaskStatus (the Ops close door) inside the api container, actor label 'one-off: close-stale-source-task'. Counts only; compare tasks/reports/2026-09-26-container-task-before-close.md (not_started 1 before). close_audit_rows counts the task.status_changed row that close wrote. The deployed door predates the reason parameter (R43, this batch, undeployed), so that row carries from/status and the actor label and not the reason; the reason lands on such rows once this batch deploys.

```sql
SELECT t.status::text AS status, count(*)::int AS tasks, count(*) FILTER (WHERE t.completed_at IS NOT NULL)::int AS with_completed_at, (SELECT count(*)::int FROM audit_log a WHERE a.action = 'task.status_changed' AND a.object_id = t.id::text AND a.actor_label = 'one-off: close-stale-source-task' AND a.details->>'status' = 'completed' AND a.details->>'from' = 'not_started') AS close_audit_rows FROM tasks t WHERE t.source_type = 'container_unhealthy' AND t.source_id = 'saos-trello-rehearsal' GROUP BY t.status, t.id ORDER BY t.status
```

| status | tasks | with_completed_at | close_audit_rows |
|---|---|---|---|
| completed | 1 | 1 | 1 |
