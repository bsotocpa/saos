/*
 * Batch 18 (Brian, 2026-10-03): R120, the pre-receipt Docker check (scripts/check-docker-ready.mjs,
 * npm run check:docker-ready). Docker itself is never stopped to prove it: each item aims the check at
 * something that is not there, and the check must go red with the sentence for that case; the last item
 * blinds a probe, and the check's self-test must refuse it.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-10-03-m-r120.mjs
 */
export const date = '2026-10-03';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };
const swap = (from, to) => (t) => { must(t, from); return t.replace(from, to); };
const check = { kind: 'guard', spec: 'check:docker-ready' };
const file = 'scripts/check-docker-ready.mjs';

export const items = [
  {
    item: 'R120: the engine does not answer',
    file,
    change: 'the check asks an engine pipe that does not exist (what a stopped Docker Desktop looks like); it must stop with the cause and the repair',
    test: check,
    apply: swap("const engine = docker(['info', '--format', '{{.ServerVersion}}']);", "const engine = docker(['info', '--format', '{{.ServerVersion}}'], ['-H', 'npipe:////./pipe/saos-no-such-engine']);"),
    expectRed: /Docker's engine does not answer .*Likely cause: Docker Desktop is not running.*Repair \(tasks\/lessons\.md/,
  },
  {
    item: 'R120: the test database container is not there',
    file,
    change: 'the check looks for a compose service that has no container; it must say the database is not running and how to start it',
    test: check,
    apply: swap("{ service: 'postgres', what: 'the test database (Postgres)'", "{ service: 'postgres-gone', what: 'the test database (Postgres)'"),
    expectRed: /the test database \(Postgres\) is not running: compose service "postgres-gone" reads "no such container".*docker compose up -d postgres minio/,
  },
  {
    item: 'R120: the test database does not answer on its port',
    file,
    change: 'the check asks Postgres on a port nothing answers on, its container running; it must say so and name the relay',
    test: check,
    apply: swap("pg = { host: u.hostname || 'localhost', port: Number(u.port || 5432) };", "pg = { host: u.hostname || 'localhost', port: 5439 };"),
    expectRed: /the test database \(Postgres\) does not answer on [\w.]+:5439 .*though its container/,
  },
  {
    item: 'R120: a probe that reads silence as an answer',
    file,
    change: 'the Postgres probe treats a timeout as answering; the self-test must refuse the check before it reads anything',
    test: check,
    apply: swap("s.setTimeout(ms, () => end(false, `no answer in ${ms / 1000} s`));", "s.setTimeout(ms, () => end(true, `no answer in ${ms / 1000} s`));"),
    expectRed: /check-docker-ready self-test: a silent listener read as Postgres answering/,
  },
];
