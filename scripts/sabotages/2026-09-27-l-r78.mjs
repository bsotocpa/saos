/*
 * The 2026-09-27 batch 8, item L: R78, "first engagement" is the first that carries an eligible line.
 *
 *   R78  priorEligibleEngagement counts an earlier engagement only on a line the rule reaches (tax,
 *        entity), never a withdrawn one. The line condition is made always true (the R75 rule as first
 *        built: any engagement not withdrawn consumes it), so a bookkeeping-only client loses the discount
 *        and the R78 test in price-book-v6.spec.ts is red.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-27-l-r78.mjs
 */
export const date = '2026-09-27';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R78 a prior engagement consumes the Hilo discount only on a line the rule reaches: the line condition made always true',
    file: 'apps/api/src/modules/pricing/referral-discount.ts',
    change: "`AND service_line::text = ANY($2::text[])` replaced by `AND ($2::text[] IS NOT NULL)`: any engagement not withdrawn, bookkeeping included, consumes the first engagement",
    test: { kind: 'api', spec: 'test/price-book-v6.spec.ts' },
    apply: (t) => {
      const a = "AND service_line::text = ANY($2::text[])";
      must(t, a);
      return t.replace(a, 'AND ($2::text[] IS NOT NULL)');
    },
    expectRed: /R78/,
  },
];
