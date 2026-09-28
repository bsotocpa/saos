/*
 * The 2026-09-28 step 4 deploy: the display-name seed failed on production's grandfathered v4 rows.
 * The fix skips a row R55's NOT VALID deposit rule would refuse. The skip removed: the seed updates
 * the grandfathered row, the CHECK refuses it, and display-names.spec.ts is red.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-28-d-seed.mjs
 */
export const date = '2026-09-28';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R81 the display-name seed skips a retired version\'s grandfathered row: the skip removed',
    file: 'packages/db/seeds/data/price_book_display_names.mjs',
    change: '`AND ${PASSES_DEPOSIT_RULE}` dropped from the UPDATE: the grandfathered v4 row is touched, re-checked, and the whole seed fails, as it did on the box',
    test: { kind: 'api', spec: 'test/display-names.spec.ts' },
    apply: (t) => {
      const a = 'AND display_name_en IS NULL AND display_name_es IS NULL AND ${PASSES_DEPOSIT_RULE}`';
      must(t, a);
      return t.replace(a, 'AND display_name_en IS NULL AND display_name_es IS NULL`');
    },
    expectRed: /grandfathered/,
  },
];
