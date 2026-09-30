/*
 * Batch 13 (Brian, 2026-09-30): R100, the queue heading reads "My Queue" as the top bar does (path O
 * and path T read it); R102, returns with no preparer are visible — one predicate for the executive
 * count, its list and the CEO alert (no-preparer.spec.ts), the count a link to the list (path J).
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-30-c-r100-r102.mjs
 */
export const date = '2026-09-30';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };
const swap = (from, to) => (t) => { must(t, from); return t.replace(from, to); };

export const items = [
  {
    item: 'R100: the queue heading back to "My queue"',
    file: 'apps/internal/app/queue/page.tsx',
    change: "the preparer's heading reads 'My queue' again; path O reads **My Queue** from the handover doc and must refuse the page",
    test: { kind: 'harness', spec: 'tests/ops-handover-rehearsal.spec.ts' },
    apply: swap("<h1>{scoped ? 'My Queue' : everyone ? 'Every open return' : 'My Queue'}</h1>", "<h1>{scoped ? 'My queue' : everyone ? 'Every open return' : 'My queue'}</h1>"),
    expectRed: /O1–O4/,
  },
  {
    item: 'R102: a withdrawn return counted as open with no preparer',
    file: 'apps/api/src/modules/tax/queue.ts',
    change: "NO_PREPARER_SQL drops 'withdrawn' from the stages that are not open (the batch 12 miscount); the count and the list must refuse it",
    test: { kind: 'api', spec: 'test/no-preparer.spec.ts' },
    apply: swap("export const NO_PREPARER_SQL = `te.stage NOT IN ('completed', 'withdrawn')", "export const NO_PREPARER_SQL = `te.stage NOT IN ('completed')"),
    expectRed: /the executive count and the list it opens are the same returns/,
  },
  {
    item: 'R102: the CEO alert on the third business day instead of the second',
    file: 'apps/api/src/modules/tax/queue.ts',
    change: 'NO_PREPARER_ALERT_BUSINESS_DAYS 2 → 3; the clock spec must refuse it',
    test: { kind: 'api', spec: 'test/no-preparer.spec.ts' },
    apply: swap('export const NO_PREPARER_ALERT_BUSINESS_DAYS = 2;', 'export const NO_PREPARER_ALERT_BUSINESS_DAYS = 3;'),
    expectRed: /two business days after it opened with no preparer/,
  },
  {
    item: 'R102: the executive count no longer opens the list of returns with no preparer',
    file: 'apps/internal/app/page.tsx',
    change: 'the count links to /returns (no filter) instead of /returns?preparer=none; path J must refuse it',
    test: { kind: 'harness', spec: 'tests/ops-no-preparer.spec.ts' },
    apply: swap('<Link href="/returns?preparer=none" data-testid="no-preparer-count"', '<Link href="/returns" data-testid="no-preparer-count"'),
    expectRed: /J1–J3/,
  },
];
