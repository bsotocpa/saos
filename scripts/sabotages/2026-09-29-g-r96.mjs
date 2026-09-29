/*
 * The 2026-09-29 batch 11: R96, "counts as". An item already received (or waived) keeps the file it
 * was answered with. The guard removed: a second file overwrites the first on a received item;
 * counts-as.spec.ts is red.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-29-g-r96.mjs
 */
export const date = '2026-09-29';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R96 a checklist item already received keeps the file it was answered with',
    file: 'apps/api/src/modules/documents/counts-as.ts',
    change: "the `item.status !== 'pending'` refusal removed: a second file overwrites a received item's document",
    test: { kind: 'api', spec: 'test/counts-as.spec.ts' },
    apply: (t) => {
      const a = "if (item.status !== 'pending') throw new AppError(409, 'item_already_received', 'That item is already received or waived.');";
      must(t, a);
      return t.replace(a, '');
    },
    expectRed: /Ops: a document on file counts as/,
  },
];
