/*
 * Batch 12, R99 (Brian, 2026-09-30): the handover doc walked by a new tax_preparer (path O). The walk
 * reads every bold label it taps from docs/handover/2026-10-19-ana-maria.md, so the doc and the screen
 * are held to each other. Each sabotage puts one of the rehearsal's disagreements back into the doc.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-30-b-r99.mjs
 */
export const date = '2026-09-30';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };
const swap = (from, to) => (t) => { must(t, from); return t.replace(from, to); };

export const items = [
  {
    item: 'R99 handover doc: the estimate fields named as before the rehearsal (Low end, High end)',
    file: 'docs/handover/2026-10-19-ana-maria.md',
    change: '**Low end (dollars)** and **High end (dollars)** back to **Low end** and **High end**; the walk must refuse a doc that names fields the screen does not print',
    test: { kind: 'harness', spec: 'tests/ops-handover-rehearsal.spec.ts' },
    apply: swap('(enter the **Low end (dollars)** and **High end (dollars)**)', '(enter the **Low end** and **High end**)'),
    expectRed: /O1–O4/,
  },
  {
    item: 'R99 handover doc: the queue page named My Queue again',
    file: 'docs/handover/2026-10-19-ana-maria.md',
    change: 'the landing sentence back to "You land on **My Queue**" with no **My queue**; the walk must refuse it',
    test: { kind: 'harness', spec: 'tests/ops-handover-rehearsal.spec.ts' },
    apply: swap('You land on your queue, headed **My queue** (**My Queue** in the top bar).', 'You land on **My Queue**.'),
    expectRed: /O1–O4/,
  },
];
