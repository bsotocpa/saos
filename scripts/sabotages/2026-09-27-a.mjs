/*
 * The 2026-09-27 batch, item A: R69, R66 and R67. Three sabotages, all on the API suite:
 *
 *   R69  the corrected 8879 signed day is never AFTER the filed day. The comparison in
 *        assertSignedNotAfterFiled (pipeline.ts) is made unreachable, so a signed date after the
 *        recorded filed date is accepted: the spec's "signed date correction" test, which expects
 *        409 signed_after_filing on a day between the filed day and today, is red.
 *
 *   R66  the 990 family's deadline derivation replaced by the 1120 rule. The four 990 rows in the
 *        authoritative table (deadlines.ts) move from the fifth month to the fourth, so a calendar-year
 *        990/990-EZ/990-PF/990-T derives April 15 / October 15 instead of May 15 / November 15: the
 *        extension spec's table-driven derivation test is red on every 990 row.
 *
 *   R67  a reopened return cannot be re-completed on the acceptance that completed it. answerIsFresh
 *        (pipeline.ts) is made to answer true for every row, so the stale acceptance counts again:
 *        the reopen spec's "re-completion is refused" test is red (the forced completion succeeds).
 *
 * Run through scripts/sabotage-run.mjs so the report table is read from tasks/sabotage/2026-09-27.log:
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-27-a.mjs
 */
export const date = '2026-09-27';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R69 the corrected 8879 signed day is never after the filed day: the comparison in assertSignedNotAfterFiled made unreachable',
    file: 'apps/api/src/modules/tax/pipeline.ts',
    change: "`if (calendarDay(signedOn, 'f8879SignedOn') > calendarDay(filedOn, 'filedOn')) {` replaced by `if (false) {`; a signed date after the recorded filed date is accepted by the correction door, so a return reads as authorized after it was filed",
    test: { kind: 'api', spec: 'test/filing-corrections.spec.ts' },
    apply: (t) => {
      const a = "  if (calendarDay(signedOn, 'f8879SignedOn') > calendarDay(filedOn, 'filedOn')) {";
      must(t, a);
      return t.replace(a, '  if (false) {');
    },
    expectRed: /R69 the 8879 signed date correction/,
  },
  {
    item: 'R66 the 990 family derives its deadline from the fifth month: the four 990 rows moved to the 1120 rule (the fourth)',
    file: 'apps/api/src/modules/tax/deadlines.ts',
    change: "the '990', '990ez', '990pf' and '990t' rows of THE_TABLE changed from `{ monthsAfterYearEnd: 5 }` to `{ monthsAfterYearEnd: 4 }`; a calendar-year 990 derives Apr 15 / Oct 15 instead of May 15 / Nov 15",
    test: { kind: 'api', spec: 'test/extension.spec.ts' },
    apply: (t) => {
      const rows = [
        "  '990':           { monthsAfterYearEnd: 5 },",
        "  '990ez':         { monthsAfterYearEnd: 5 },",
        "  '990pf':         { monthsAfterYearEnd: 5 },",
        "  '990t':          { monthsAfterYearEnd: 5 },",
      ];
      for (const a of rows) must(t, a);
      let out = t;
      for (const a of rows) out = out.replace(a, a.replace('monthsAfterYearEnd: 5', 'monthsAfterYearEnd: 4'));
      return out;
    },
    expectRed: /deadline derivation: table-driven/,
  },
  {
    item: 'R67 a reopened return is not re-completed on its old acceptance: the "after reopened_at" condition in answerIsFresh removed',
    file: 'apps/api/src/modules/tax/pipeline.ts',
    change: '`return row.answeredAt !== null && row.answeredAt.getTime() > row.reopenedAt.getTime();` replaced by `return true;`; the acceptance recorded before the reopen counts again, so a forced transition to completed succeeds and the return closes on an answer the firm had put in doubt',
    test: { kind: 'api', spec: 'test/reopen-return.spec.ts' },
    apply: (t) => {
      const a = '  return row.answeredAt !== null && row.answeredAt.getTime() > row.reopenedAt.getTime();';
      must(t, a);
      return t.replace(a, '  return true;');
    },
    expectRed: /re-completion is refused/,
  },
];
