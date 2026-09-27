/*
 * The 2026-09-27 batch 7, item H: receipt run 21's red, explained and fixed.
 *
 *   run 21  the pipeline march's stage history read out of order: GET /tax-engagements/:id ordered the
 *           history by entered_at, nine rows written within milliseconds, and the Docker VM's clock steps
 *           back 1 to 2 ms every 30 seconds. Migration 0128 numbers the rows in the order written (seq); the
 *           read orders by it. The sabotage: the read orders by the clock again, and the run-21 test (two
 *           rows whose clock readings run backward) is red.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-27-h-run21.mjs
 */
export const date = '2026-09-27';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'Run 21: the stage history reads in the order written (seq); the read ordered by the clock again',
    file: 'apps/api/src/modules/tax/routes.ts',
    change: "`ORDER BY h.seq` replaced by `ORDER BY h.entered_at` in the GET /tax-engagements/:id history read: rows written within a clock step read out of order",
    test: { kind: 'api', spec: 'test/tax.spec.ts' },
    apply: (t) => {
      const a = 'WHERE h.tax_engagement_id = $1 ORDER BY h.seq`';
      must(t, a);
      return t.replace(a, 'WHERE h.tax_engagement_id = $1 ORDER BY h.entered_at`');
    },
    expectRed: /RECEIPT RUN 21/,
  },
];
