/*
 * The 2026-09-26 batch, item D (Brian's rulings R53 and R50): one sabotage each.
 *
 *   R53  The date-after-today refusal removed. record8879Sent (tax/f8879-sent.ts) refuses a sent day
 *        after today in Chicago; take the comparison out and a return can be recorded as having sent
 *        its 8879 tomorrow. test/f8879-sent.spec.ts is red on the refusal test.
 *
 *   R50  The current step's control removed from the stepper. return-stepper.tsx renders the one
 *        control on the current step of the open phase for a session holding engagements.tax.manage
 *        (v2, 2026-09-27: five phases, the anchor one level deeper); make that branch unreachable and
 *        the rail shows its phases and steps with nothing to tap. ops-return-stepper-switch.spec.ts
 *        (S1) is red at both viewports: no letter upload on the current step. Harness kind: the run
 *        boots the API and both Next apps, so hold the harness lock while this item runs.
 *
 * Run through scripts/sabotage-run.mjs so the report table is read from tasks/sabotage/2026-09-26.log:
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-26-d.mjs
 *
 * Every replacement is a replacer FUNCTION (the standing lesson): a string replacement reads `$'`
 * and friends as patterns, whatever the content looks like today.
 */
export const date = '2026-09-26';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R53 the 8879 sent day is never after today: the comparison in record8879Sent made unreachable',
    file: 'apps/api/src/modules/tax/f8879-sent.ts',
    change: "`if (day > today)` replaced by `if (false)`; a return can be recorded as having its 8879 sent on a day that has not happened",
    test: { kind: 'api', spec: 'test/f8879-sent.spec.ts' },
    apply: (t) => {
      const a = "  if (day > today) {\n    throw new AppError(409, 'f8879_sent_in_future'";
      must(t, a);
      return t.replace(a, () => "  if (false as boolean) { // SABOTAGE: the after-today rule removed\n    throw new AppError(409, 'f8879_sent_in_future'");
    },
    expectRed: /a day after today is refused/,
  },
  {
    item: 'R50 the current step carries its one control: the branch that renders it made unreachable',
    file: 'apps/internal/components/return-stepper.tsx',
    change: "`{s.state === 'current' && canManage ? (` replaced by `{false ? (`; the rail shows five phases, the open one its steps, and no control to tap",
    test: { kind: 'harness', spec: 'tests/ops-return-stepper-switch.spec.ts' },
    apply: (t) => {
      const a = "                    {s.state === 'current' && canManage ? (";
      must(t, a);
      return t.replace(a, () => '                    {false ? ( // SABOTAGE: the current step’s control removed');
    },
    expectRed: /off renders the row with its control grid/,
  },
];
