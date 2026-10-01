/*
 * Batch 15 step 3 (Brian, 2026-09-30), the walk halves (path I, batch15-documents.spec.ts): R105 on the
 * portal checklist, R110 the list by return, R108 the withdrawn return in Ops, R107 the final fee in
 * Details. Each is run on the narrow WebKit and the wide Chromium, each on its own fresh harness.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-30-g-batch15-walks.mjs
 */
export const date = '2026-09-30';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };
const swap = (from, to) => (t) => { must(t, from); return t.replace(from, to); };
const walk = { kind: 'harness', spec: 'tests/batch15-documents.spec.ts', projects: ['webkit-375', 'chromium-1440'] };

export const items = [
  {
    item: 'R105: the checklist Upload control back in the row, beside the name',
    file: 'apps/portal/app/globals.css',
    change: '.cl-upload is no longer a full-width block beneath the name; I1 must refuse it',
    test: walk,
    apply: swap('.cl-upload { display: block; width: 100%; text-align: center; margin-top: 8px; }', '.cl-upload { display: inline-block; margin-top: 8px; }'),
    expectRed: /I1–I5/,
  },
  {
    item: 'R110: every file listed as "Not tied to a return"',
    file: 'apps/portal/app/documents/page.tsx',
    change: 'the page ignores the return each file belongs to; I2 must refuse the single group',
    test: walk,
    apply: swap("const key = d.return_id ?? 'none';", "const key = 'none';"),
    expectRed: /I1–I5/,
  },
  {
    item: 'R108: the withdrawn return rendered as a full row with its stepper in Ops',
    file: 'apps/internal/app/clients/[id]/page.tsx',
    change: "the client page's Returns card no longer renders a withdrawn return as one line; I4 must refuse it",
    test: walk,
    apply: swap("returns.map((t) => t.stage === 'withdrawn' ? (", "returns.map((t) => t.stage === 'never' ? ("),
    expectRed: /I1–I5/,
  },
  {
    item: 'R107: "Set final fee" gone from Details',
    file: 'apps/internal/components/return-stepper.tsx',
    change: 'the Details control is not rendered; I5 must refuse a return in Engage without it',
    test: walk,
    // (A literal `false &&` changes TypeScript's narrowing below it and fails the build, so no walk runs;
    // a condition that never holds beside preFiled keeps the build whole.)
    apply: swap("{preFiled && current?.key !== 'final_fee' ? (", "{preFiled && stage === 'filed' ? ("),
    expectRed: /I1–I5/,
  },
];
