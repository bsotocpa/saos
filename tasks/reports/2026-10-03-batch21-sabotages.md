# batch21-sabotages (2026-10-03)

Generated 2026-10-03T17:01:41.985Z by scripts/report-table.mjs from the log sabotage-b21.log; 9 row(s).

```sql
node scripts/sabotage-run.mjs scripts/sabotages/2026-10-03-p-r130-r131.mjs (rows read from tasks/sabotage/2026-10-03.log)
```

| date | item | file | change | test | on the harness | red | restored green |
|---|---|---|---|---|---|---|---|
| 2026-10-03 | R130: the status host back in the Caddy file | deploy/Caddyfile | the block removed by R130 is appended again | guard: check:public-hosts | no | RED as expected (2 failed: status.sotoaccounting.com is a public host the list does not name (a first-run or setup page must never be reachable from outside); the Caddy file proxies to uptime-kuma: Kuma has no public address (R130)) | green (1 passed) |
| 2026-10-03 | R130: Kuma reachable behind another public name | deploy/Caddyfile | the vault host proxies to uptime-kuma | guard: check:public-hosts | no | RED as expected (1 failed: the Caddy file proxies to uptime-kuma: Kuma has no public address (R130)) | green (1 passed) |
| 2026-10-03 | R131: the ntfy host's log keeps the request headers | deploy/Caddyfile | the filter no longer drops request headers | guard: check:public-hosts | no | RED as expected (1 failed: the ntfy host's log keeps what it must drop: request>headers delete) | green (1 passed) |
| 2026-10-03 | R131: the ntfy host's log keeps the query string | deploy/Caddyfile | the filter no longer cuts the path at the question mark | guard: check:public-hosts | no | RED as expected (1 failed: the ntfy host's log keeps what it must drop: request>uri regexp "\?.*$" "") | green (1 passed) |
| 2026-10-03 | R131: the access log kept a year | deploy/logrotate-ntfy-access | rotate 365 and maxage 365 | guard: check:public-hosts | no | RED as expected (2 failed: the rotation lacks "rotate 90": the log is kept 90 days, rotated daily; the rotation lacks "maxage 90": the log is kept 90 days, rotated daily) | green (1 passed) |
| 2026-10-03 | R131: the audit row of a push carries the push's text | apps/api/src/notify/push.ts | details gains a third field | guard: check:push-payload | no | RED as expected (1 failed: the audit row of a push holds something other than the server and the outcome) | green (1 passed) |
| 2026-10-03 | R131: a push is sent and no audit row is written | apps/api/src/notify/push.ts | the row for a sent push is skipped | api: test/push-payload.spec.ts | no | RED as expected (5 failed: R127: an alert that names a client is pushed as the fixed text; the alert's own words never leave; R127: with push on and no token, or no topic, nothing is sent, and the alert waits for the next sweep; R127: a refusal from the server) | green (7 passed) |
| 2026-10-03 | R131: the audit row names the topic | apps/api/src/notify/push.ts | the pusher's server is the address with the topic appended | api: test/push-payload.spec.ts | no | RED as expected (3 failed: R127: an alert that names a client is pushed as the fixed text; the alert's own words never leave; R127: a refusal from the server; R131: a server that does not answer is one request and one row, and the sweep stops there) | green (7 passed) |
| 2026-10-03 | R130: the check goes blind to a host nobody named | scripts/check-public-hosts.mjs | a host off the list is accepted; the self-test must refuse the check | guard: check:public-hosts | no | RED as expected (1 failed: check-public-hosts self-test: "a new public host nobody named" was accepted) | green (1 passed) |
