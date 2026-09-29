/*
 * The 2026-09-29 batch 10, step 2: R91 (the checklist backfill) and R93 (past deadlines), one each.
 *
 *   R91  the door reads the return's quoted lines from its engagement's scope snapshot. The lines read
 *        as none: every pre-checklist return is refused "no quoted lines"; the R91 spec is red.
 *   R93  a passed deadline with no filing reads "Overdue since". The rule answers never: the row, the
 *        queue and the portal card fall back to a bare past date; the overdue spec is red.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-29-c-r91-r93.mjs
 */
export const date = '2026-09-29';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R91 the checklist backfill builds from the quoted lines: the lines read as none',
    file: 'apps/api/src/modules/documents/checklist.ts',
    change: "the scope query's `WHERE engagement_id = $1 AND source_quote_id IS NOT NULL` given `AND false`: a pre-checklist return from an accepted quote is refused as if opened by hand",
    test: { kind: 'api', spec: 'test/document-checklist.spec.ts' },
    apply: (t) => {
      const a = 'WHERE engagement_id = $1 AND source_quote_id IS NOT NULL AND item_code IS NOT NULL';
      must(t, a);
      return t.replace(a, a + ' AND false');
    },
    expectRed: /R91/,
  },
  {
    item: 'R93 a passed deadline with no filing reads "Overdue since": the rule answers never',
    file: 'apps/api/src/modules/tax/deadlines.ts',
    change: '`return deadline < today ? deadline : null;` replaced by `return null;`: the queue and the portal card print a bare past date again',
    test: { kind: 'api', spec: 'test/overdue.spec.ts' },
    apply: (t) => {
      const a = 'return deadline < today ? deadline : null;';
      must(t, a);
      return t.replace(a, 'return deadline === today.slice(0, 0) ? deadline : null;');
    },
    expectRed: /overdue since/,
  },
];
