# batch20-sabotages (2026-10-03)

Generated 2026-10-03T10:03:05.489Z by scripts/report-table.mjs from the log sabotage-b20.log; 7 row(s).

```sql
node scripts/sabotage-run.mjs scripts/sabotages/2026-10-03-o-r127.mjs (rows read from tasks/sabotage/2026-10-03.log)
```

| date | item | file | change | test | on the harness | red | restored green |
|---|---|---|---|---|---|---|---|
| 2026-10-03 | R127: the alert's title is sent as the push (the root check) | apps/api/src/notify/push.ts | the sweep selects the alert's title and hands it to the pusher, which sends it as the body | guard: check:push-payload | no | RED as expected (5 failed: the Pusher interface hands push() an argument (it must take none); a push() is declared or called with an argument; the request body is not the fixed text constant) | green (1 passed) |
| 2026-10-03 | R127: the alert's title is sent as the push (the request itself) | apps/api/src/notify/push.ts | the same change; the recorded request must show the client name and the test must refuse it | api: test/push-payload.spec.ts | no | RED as expected (2 failed: R127: an alert that names a client is pushed as the fixed text; the alert's own words never leave; R127: a refusal from the server) | green (5 passed) |
| 2026-10-03 | R127: a header built from something other than the fixed title | apps/api/src/notify/push.ts | the Title header is no longer the constant | guard: check:push-payload | no | RED as expected (1 failed: a request header is not one of the three fixed ones: Title: target.url,) | green (1 passed) |
| 2026-10-03 | R127: a different fixed text | apps/api/src/notify/push.ts | the text is reworded to say what kind of alert it is | guard: check:push-payload | no | RED as expected (1 failed: the fixed text is not the plain constant '1 new alert in Ops') | green (1 passed) |
| 2026-10-03 | R127: a second sender outside the push file | apps/api/src/jobs/daily.ts | the daily job posts to the push server on its own, with a title | guard: check:push-payload | no | RED as expected (1 failed: apps/api/src/jobs/daily.ts reaches the push server on its own (only apps/api/src/notify/push.ts may)) | green (1 passed) |
| 2026-10-03 | R127: a push sent without the token | apps/api/src/notify/push.ts | the pusher no longer stops when no token is set | api: test/push-payload.spec.ts | no | RED as expected (2 failed: R127: with push on and no token, or no topic, nothing is sent, and the alert waits for the next sweep; R127: a refusal from the server) | green (5 passed) |
| 2026-10-03 | R127: the check goes blind to interpolation | scripts/check-push-payload.mjs | any ${…} in the push file is accepted; the self-test must refuse the check | guard: check:push-payload | no | RED as expected (1 failed: check-push-payload self-test: "an interpolated client name" was accepted) | green (1 passed) |
