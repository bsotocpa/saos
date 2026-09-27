/*
 * The 2026-09-27 batch 7, item I: receipt run 21's harness red, explained and fixed.
 *
 *   run 21  ops-edit-doors (phone): Create Task refused "Subject is required." with the box empty. The task
 *           form was filled by its useState initializer and refilled by an effect on mount, after paint; on
 *           the loaded phone run the refill landed after the typing. The effect now refills only when the
 *           record or the person changes. The sabotage: the guard removed, the source test red.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-27-i-run21h.mjs
 */
export const date = '2026-09-27';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'Run 21 harness: the task form keeps what was typed; the refill guard removed so the form refills on mount again',
    file: 'apps/internal/app/tasks/task-form.tsx',
    change: '`if (shownFor.current.task === props.task && shownFor.current.meId === props.meId) return;` removed: the effect refills the form after paint on mount, wiping a subject typed in that gap',
    test: { kind: 'internal', spec: 'test/task-form-reset.spec.ts' },
    apply: (t) => {
      const a = '    if (shownFor.current.task === props.task && shownFor.current.meId === props.meId) return;\n';
      must(t, a);
      return t.replace(a, '');
    },
    expectRed: /refills only when/,
  },
];
