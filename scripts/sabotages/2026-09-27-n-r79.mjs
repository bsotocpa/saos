/*
 * The 2026-09-27 batch 9, item N: R79, the "already has an active Schedule" prompt fires only on a
 * live engagement under that schedule. The live filter is removed from coveredSchedules, so every
 * schedule ever accepted triggers it again (Brian's Schedule A with no live 1040): the R79 test red.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-27-n-r79.mjs
 */
export const date = '2026-09-27';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R79 the active-Schedule prompt fires only on a live engagement under that schedule: the live filter removed',
    file: 'apps/api/src/modules/pricing/quote-coverage.ts',
    change: '`return accepted.filter((code) => live.includes(code));` replaced by `return accepted;`: a schedule signed once, with no live engagement under it, triggers the prompt again',
    test: { kind: 'api', spec: 'test/quote-consequence.spec.ts' },
    apply: (t) => {
      const a = 'return accepted.filter((code) => live.includes(code));';
      must(t, a);
      return t.replace(a, 'return accepted;');
    },
    expectRed: /R79/,
  },
];
