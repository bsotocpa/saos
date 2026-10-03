# r127-access-log-counts (2026-10-03)

Generated 2026-10-03T10:03:05.378Z by scripts/report-table.mjs from the log r127-access-log-counts.log; 30 row(s).

```sql
read-only on the box: docker logs -t saos-ntfy-1 (statistics lines), docker logs saos-caddy-1 (grep http.log.access; grep the ntfy host), and SELECT pushed_at::date, count(*) FROM notifications WHERE pushed_at IS NOT NULL GROUP BY 1; summed by scratchpad/b20_counts.py. Counts and dates only.
```

| measure | value | first date | last date |
|---|---|---|---|
| ntfy: per-request access-log lines (subscribe or publish) | none kept: the server logs one statistics line a minute and no requests |  |  |
| proxy (Caddy): access-log entries, all hosts | 0 (no access log is configured) |  |  |
| proxy (Caddy): request lines naming the ntfy host (errors only; certificate upkeep lines not counted) | 1 |  |  |
| ntfy: statistics lines read | 126978 | 2026-07-07 | 2026-10-03 |
| ntfy: days covered | 89 | 2026-07-07 | 2026-10-03 |
| ntfy: messages published, total | 87 | 2026-07-07 | 2026-09-20 |
| ntfy: days with a publish | 13 | 2026-07-07 | 2026-09-20 |
| ntfy: subscribers connected at a minute sample, highest | 0 |  |  |
| ntfy: topics in use at once, highest | 7 |  |  |
| ntfy: days with more than one topic in use | 13 | 2026-07-07 | 2026-09-16 |
| ntfy: visitors at once, highest (every outside client counts as the proxy) | 2 |  |  |
| ntfy: days with a visitor and no publish | 76 | 2026-07-09 | 2026-10-03 |
| distinct client addresses | cannot be produced: no log holds a client address |  |  |
| database: alerts stamped pushed (pushes were never audited; older alerts were removed in the summer clean-ups) | 10 | 2026-07-08 | 2026-10-03 |
| database: of those, stamped by the switched-off sender on 2026-10-03 (the step 1 test; nothing was sent) | 1 |  |  |
| ntfy: messages published that a stamped alert accounts for | 9 | 2026-07-08 | 2026-09-20 |
| ntfy: messages published with no record of what sent them | 78 |  |  |
| ntfy: published on 2026-07-07 (stamped alerts that day: 0) | 5 | 2026-07-07 | 2026-07-07 |
| ntfy: published on 2026-07-08 (stamped alerts that day: 1) | 2 | 2026-07-08 | 2026-07-08 |
| ntfy: published on 2026-07-11 (stamped alerts that day: 0) | 56 | 2026-07-11 | 2026-07-11 |
| ntfy: published on 2026-07-23 (stamped alerts that day: 0) | 5 | 2026-07-23 | 2026-07-23 |
| ntfy: published on 2026-08-06 (stamped alerts that day: 0) | 5 | 2026-08-06 | 2026-08-06 |
| ntfy: published on 2026-08-11 (stamped alerts that day: 2) | 2 | 2026-08-11 | 2026-08-11 |
| ntfy: published on 2026-08-12 (stamped alerts that day: 2) | 2 | 2026-08-12 | 2026-08-12 |
| ntfy: published on 2026-08-15 (stamped alerts that day: 1) | 1 | 2026-08-15 | 2026-08-15 |
| ntfy: published on 2026-09-04 (stamped alerts that day: 0) | 5 | 2026-09-04 | 2026-09-04 |
| ntfy: published on 2026-09-09 (stamped alerts that day: 1) | 1 | 2026-09-09 | 2026-09-09 |
| ntfy: published on 2026-09-12 (stamped alerts that day: 1) | 1 | 2026-09-12 | 2026-09-12 |
| ntfy: published on 2026-09-16 (stamped alerts that day: 0) | 1 | 2026-09-16 | 2026-09-16 |
| ntfy: published on 2026-09-20 (stamped alerts that day: 1) | 1 | 2026-09-20 | 2026-09-20 |
