/*
 * The 2026-09-29 batch 10, step 1: R50 v3 approved with one follow-up: only the five phases are
 * numbered; a step inside the open phase carries no number. The numbers put back: S1 in
 * ops-return-stepper-switch.spec.ts reads "2Preparer assigned" and is red.
 *
 * Hold the harness lock: node scripts/sabotage-run.mjs scripts/sabotages/2026-09-29-a-r50.mjs
 */
export const date = '2026-09-29';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R50 v3 only the five phases are numbered: a step inside the open phase numbered again',
    file: 'apps/internal/components/return-stepper.tsx',
    change: "the step mark `{s.state === 'done' ? '✓' : ''}` back to `{s.state === 'done' ? '✓' : j + 1}`: the open phase's steps read 1, 2, 3 beside the phases' own numbers",
    test: { kind: 'harness', spec: 'tests/ops-return-stepper-switch.spec.ts' },
    apply: (t) => {
      const a = "{p.steps.map((s) => (";
      const b = "<span className=\"step-mark\" aria-hidden=\"true\">{s.state === 'done' ? '✓' : ''}</span>";
      must(t, a); must(t, b);
      return t.replace(a, '{p.steps.map((s, j) => (').replace(b, "<span className=\"step-mark\" aria-hidden=\"true\">{s.state === 'done' ? '✓' : j + 1}</span>");
    },
    expectRed: /off renders the row/,
  },
];
