/*
 * Batch 11, receipt run 47 (Brian, 2026-09-29): every outward adapter in a test process is a stub or a
 * test target whatever the local .env says, a root-chain check fails if a test process can reach a
 * live target, and a new MinIO connection the relay resets is replaced once. Each guard broken once.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-30-a-test-targets.mjs
 */
export const date = '2026-09-30';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };
const drop = (line) => (t) => { must(t, line); return t.replace(line, ''); };

export const items = [
  {
    item: 'test targets: push no longer forced to its stub (the run 47 finding)',
    file: 'apps/api/test/test-targets.ts',
    change: "PUSH_MODE: 'stub' removed from TEST_OUTWARD_OVERRIDES; a hostile PUSH_MODE=ntfy must survive into the test configuration and the check must name it",
    test: { kind: 'guard', spec: 'check:test-targets' },
    apply: drop("  PUSH_MODE: 'stub',\n"),
    expectRed: /push: ntfy/,
  },
  {
    item: 'test targets: the object store no longer forced local',
    file: 'apps/api/test/test-targets.ts',
    change: "MINIO_ENDPOINT: 'localhost' removed from TEST_OUTWARD_OVERRIDES; a remote object store must be named",
    test: { kind: 'guard', spec: 'check:test-targets' },
    apply: drop("  MINIO_ENDPOINT: 'localhost',\n"),
    expectRed: /object store: minio\.example\.com/,
  },
  {
    item: 'test targets: mail no longer forced to the console',
    file: 'apps/api/test/test-targets.ts',
    change: "MAIL_TRANSPORT: 'console' removed; the SES relay from a hostile environment must be named",
    test: { kind: 'guard', spec: 'check:test-targets' },
    apply: drop("  MAIL_TRANSPORT: 'console',\n"),
    expectRed: /mail: smtp/,
  },
  {
    item: 'test targets: Stripe no longer forced to its stub',
    file: 'apps/api/test/test-targets.ts',
    change: "STRIPE_MODE: 'stub' removed; a hostile STRIPE_MODE=live must be named",
    test: { kind: 'guard', spec: 'check:test-targets' },
    apply: drop("  STRIPE_MODE: 'stub',\n"),
    expectRed: /Stripe: live/,
  },
  {
    item: 'test targets: a remote database no longer refused',
    file: 'apps/api/test/test-targets.ts',
    change: 'the refusal after loadConfig removed; a test configuration over a remote DATABASE_URL must be caught being built',
    test: { kind: 'guard', spec: 'check:test-targets' },
    apply: drop("    if (live.length) throw new Error(`refusing: a test process's configuration would reach a live target (${live.join('; ')})`);\n"),
    expectRed: /remote DATABASE_URL was built instead of refused/,
  },
  {
    item: 'test targets: a spec sets push live on its own config without being named',
    file: 'apps/api/test/dashboards.spec.ts',
    change: "config = { ...config, PUSH_MODE: 'ntfy' } added after createTestConfig in the alert-center spec; the scan must name the file",
    test: { kind: 'guard', spec: 'check:test-targets' },
    apply: (t) => { const a = "  config = await createTestConfig('dash');\n"; must(t, a); return t.replace(a, a + "  config = { ...config, PUSH_MODE: 'ntfy' };\n"); },
    expectRed: /dashboards\.spec\.ts:\d+ sets an outward adapter live/,
  },
  {
    item: 'test targets: the environment no longer copied before process.env is emptied (receipt run 48)',
    file: 'apps/api/test/test-targets.ts',
    change: 'Object.assign(process.env, source) back to Object.assign(process.env, env): over process.env itself the harness settings are lost',
    test: { kind: 'guard', spec: 'check:test-targets' },
    apply: (t) => { const a = 'Object.assign(process.env, source);'; must(t, a); return t.replace(a, 'Object.assign(process.env, env);'); },
    expectRed: /lost a setting that is not an adapter/,
  },
  {
    item: 'MinIO connect retry: a reset new connection no longer replaced',
    file: 'apps/api/test/minio-connect-retry.ts',
    change: 'the one fresh connection removed: a reset before MinIO answers goes straight to the request',
    test: { kind: 'api', spec: 'test/minio-connect-retry.spec.ts' },
    apply: (t) => { const a = "if (!isRetry) { recordConnectRetry(`minio ${err.code ?? 'timeout'}`); open(true); return; }"; must(t, a); return t.replace(a, ''); },
    expectRed: /reset before MinIO answers is replaced once|not answered within 10 s is replaced once/,
  },
];
