/*
 * The 2026-09-26 batch, item C (R49): the portal Documents page crash, reintroduced.
 *
 * Brian's account crashed the page because each row was labelled with `t(\`cat_${category}\`)`: a
 * key assembled from the row and asserted to the compiler, which translate() dereferenced with no
 * entry behind it for the staff-filed categories ("Cannot read properties of undefined (reading
 * '0')"). The fix labels every row through docCategoryLabel(), which never throws, and gives the
 * dictionary every enum value. The sabotage puts the asserted-key call back on the category label,
 * on a key no dictionary carries (`cat_${category}_row`): the same exception, on the same rows, at
 * the same place in the render. The harness spec must be red at both viewports, G1 on its first
 * row and G2 after the Reload.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-26-c.mjs
 */
export const date = '2026-09-26';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 70)); };

export const items = [
  {
    item: 'R49 the Documents page crash reintroduced: the category label through t() on an asserted key the dictionary lacks',
    file: 'apps/portal/app/documents/page.tsx',
    change: '{docCategoryLabel(lang, d.category)} replaced by {t(`cat_${d.category}_row` as DictKey)}: translate() throws on the first row, the page dies before the client reads a file name',
    test: { kind: 'harness', spec: 'tests/portal-documents.spec.ts' },
    apply: (t) => {
      const a = '                  {docCategoryLabel(lang, d.category)}\n';
      must(t, a);
      return t.replace(a, '                  {t(`cat_${d.category}_row` as DictKey)}\n');
    },
    expectRed: /three kinds of row/,
  },
];
