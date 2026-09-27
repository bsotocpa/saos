/*
 * The 2026-09-27 batch 7, item F: R72, a 1041 defaults to the 8879-F.
 *
 *   R72  f8879VariantFor returns '8879-F' for a 1041. The line is removed, so a 1041 falls through to
 *        the bare '8879' again (the R66 behaviour): the R72 test in f8879-variant.spec.ts is red.
 *        No fixture: no 1041 client exists yet (Brian's ruling); the unit test covers the default.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-27-f-r72.mjs
 */
export const date = '2026-09-27';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R72 a 1041 defaults to the 8879-F: the 1041 line in f8879VariantFor removed',
    file: 'apps/api/src/modules/tax/signed-8879.ts',
    change: "`if (t === '1041') return '8879-F';` removed from f8879VariantFor; a 1041's signed authorization defaults to the bare 8879 again",
    test: { kind: 'api', spec: 'test/f8879-variant.spec.ts' },
    apply: (t) => {
      const a = "  if (t === '1041') return '8879-F';\n";
      must(t, a);
      return t.replace(a, '');
    },
    expectRed: /R72/,
  },
];
