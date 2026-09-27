/*
 * The 2026-09-27 batch 7, item J: the clock-step audit after receipt runs 20 to 22.
 *
 *   drain    the outbox drain claims a row due within a second of its clock (a row queued just before a
 *            backward step read as due in the future, and the drain right behind it claimed nothing). The
 *            allowance removed: the clock-step test in outbox.spec.ts is red.
 *   db tag   each checkout has its own test databases (the receipt worktree and the main checkout shared
 *            them, and a spec's DROP ... WITH (FORCE) took the other checkout's database mid-run). The tag
 *            removed: the importer spec's own-name assertion still reads the tagged name and is red.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-27-j-clock.mjs
 */
export const date = '2026-09-27';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'Clock step: the outbox drain claims a row due within a second; the allowance removed',
    file: 'apps/api/src/outbox.ts',
    change: "`next_attempt_at <= now() + interval '1 second'` replaced by `next_attempt_at <= now()`: a row queued just before a backward clock step is skipped by the drain right behind it",
    test: { kind: 'api', spec: 'test/outbox.spec.ts' },
    apply: (t) => {
      const a = "next_attempt_at <= now() + interval '1 second'";
      must(t, a);
      return t.replace(a, 'next_attempt_at <= now()');
    },
    expectRed: /THE CLOCK STEP/,
  },
  {
    item: 'Each checkout its own test databases: the checkout tag removed from testDatabaseName',
    file: 'apps/api/test/helpers.ts',
    change: '`saos_api_test_${CHECKOUT_TAG}_${dbSuffix}` replaced by `saos_api_test_${dbSuffix}` while the spec expects the tagged name the helper also reports: the two diverge only if the tag is dropped from one side, so the sabotage drops it from the database the connection names',
    test: { kind: 'api', spec: 'test/trello-import.spec.ts' },
    apply: (t) => {
      const a = 'const testDb = testDatabaseName(dbSuffix);';
      must(t, a);
      return t.replace(a, 'const testDb = `saos_api_test_${dbSuffix}`;');
    },
    expectRed: /./,
  },
];
