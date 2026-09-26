# container-task-before-close (2026-09-26)

Generated 2026-09-26T21:48:45.082Z by scripts/report-table.mjs from production; 1 row(s).

R52: the container_unhealthy task for the 2026-09-20 import rehearsal's throwaway container, before it is closed through the task door. Counts by status only.

```sql
SELECT t.status::text AS status, count(*)::int AS tasks, min(t.created_at)::text AS first_created_at, count(*) FILTER (WHERE t.completed_at IS NOT NULL)::int AS with_completed_at FROM tasks t WHERE t.source_type = 'container_unhealthy' AND t.source_id = 'saos-trello-rehearsal' GROUP BY t.status ORDER BY t.status
```

| status | tasks | first_created_at | with_completed_at |
|---|---|---|---|
| not_started | 1 | 2026-09-20 07:10:03.108398+00 | 0 |
