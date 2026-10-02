/*
 * Batch 16 (Brian, 2026-10-02): R115, parallel receipt lanes. Each item breaks one promise of the runner;
 * scripts/harness-lanes-check.mjs (npm run check:harness-lanes) must go red naming it.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-10-02-k-r115.mjs
 */
export const date = '2026-10-02';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };
const swap = (from, to) => (t) => { must(t, from); return t.replace(from, to); };
const check = { kind: 'guard', spec: 'check:harness-lanes' };

export const items = [
  {
    item: 'R115: the memory floor is never acted on (no fallback)',
    file: 'apps/e2e/run-harness.mjs',
    change: 'the sampler records free memory but never falls back; under a floor no machine meets, both lanes keep running',
    test: check,
    apply: swap('if (free < FLOOR && !fellBack && running.has(0) && running.has(1)) fallBack(free);', 'void FLOOR;'),
    expectRed: /fallback: the runner did not fall back/,
  },
  {
    item: 'R115: the WebKit lane waits for the Chromium lane (no parallel run)',
    file: 'apps/e2e/run-harness.mjs',
    change: 'lane 1 starts only after lane 0 ends: the lanes never overlap in time',
    test: check,
    apply: swap("await Promise.all([runLane(0), lanesUsed === 2 ? runLane(1) : Promise.resolve()]);", "await runLane(0); if (lanesUsed === 2) await runLane(1);"),
    expectRed: /parallel: the two lanes did not overlap in time/,
  },
];
