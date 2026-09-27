/*
 * The 2026-09-27 batch 7, item G: receipt run 20's red, explained and fixed (R67 freshness).
 *
 *   run 20  a paper jurisdiction's second mailing, recorded after the reopen, read as stale: R67 compared
 *           answered_at > reopened_at, and the database clock in the Docker VM steps back 1 to 2 ms every
 *           30 seconds (host time sync). Migration 0128 makes staleness a flag the reopen sets and the
 *           next answer clears. The sabotage: the mailing no longer clears it, so the paper row stays
 *           stale after its new mailing and both paper tests in reopen-return.spec.ts are red.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-27-g-run20.mjs
 */
export const date = '2026-09-27';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'Run 20 (R67): a new mailing clears the stale flag the reopen set; the clear removed from the mailing',
    file: 'apps/api/src/modules/tax/pipeline.ts',
    change: "`answer_stale = false` removed from the mailing's UPDATE: a paper row reopened stays stale after its new mailing, and the return can never complete on it",
    test: { kind: 'api', spec: 'test/reopen-return.spec.ts' },
    apply: (t) => {
      const a = 'receipt_document_id = $6, answered_at = now(),\n            answer_stale = false\n';
      must(t, a);
      return t.replace(a, 'receipt_document_id = $6, answered_at = now()\n');
    },
    expectRed: /RECEIPT RUN 20|paper jurisdiction reopened/,
  },
];
