/*
 * The 2026-09-26 batch, item B (Brian's ruling on the filed day and the filing corrected): one
 * sabotage on the API, on the rule the two doors share.
 *
 *   The before-8879 refusal made unreachable. assertFiledOn (tax/pipeline.ts) is the one place both
 *   Mark filed and the correction door hold a filed day to "not before the signed 8879". Take the
 *   comparison out and a return can be filed — or corrected to have been filed — before anyone
 *   signed its authorization. test/filing-corrections.spec.ts is red in three places: the Mark
 *   filed refusal, the correction refusal, and the walk step F4 rehearses in the API.
 *
 * Run through scripts/sabotage-run.mjs so the report table is read from tasks/sabotage/2026-09-26.log:
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-26-b.mjs
 */
export const date = '2026-09-26';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R44 the filed day is never before the signed 8879: the comparison in assertFiledOn made unreachable',
    file: 'apps/api/src/modules/tax/pipeline.ts',
    change: "`if (f8879SignedOn && day < calendarDay(...))` replaced by `if (false)`; a return can be marked filed, or corrected to have been filed, on a day before its authorization was signed",
    test: { kind: 'api', spec: 'test/filing-corrections.spec.ts' },
    apply: (t) => {
      const a = "  if (f8879SignedOn && day < calendarDay(f8879SignedOn, 'f8879SignedOn')) {";
      must(t, a);
      return t.replace(a, "  if (false as boolean) { // SABOTAGE: the before-8879 rule removed");
    },
    expectRed: /before the signed 8879|filed date correction/,
  },
];
