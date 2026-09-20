/*
 * THE 2026-09-20 BATCH A (rulings 10, 11 and 12): one sabotage per ruling, run through
 * scripts/sabotage-run.mjs so the reconciliation table is read from tasks/sabotage/2026-09-20.log
 * rather than composed.
 *
 *   R10 the portal stamp removed — the client signs the packet and no return is stamped, which is
 *       exactly the gap this ruling closed: gate 1 reads the RETURN's timestamp, so every return
 *       stays blocked at Scheduled behind a letter the client has already signed;
 *   R11 the preparer gate made unreachable — preparation starts on a return assigned to nobody, so
 *       the work sits in no queue and the first person to notice is the client;
 *   R12 the future-date refusal made unreachable — an extension "filed" tomorrow buys a deadline
 *       off a filing that has not happened.
 */
export const date = '2026-09-20';
const api = (spec) => ({ kind: 'api', spec });
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'ruling 10 engagement letter: the portal stamp removed',
    file: 'apps/api/src/modules/engagements/packet.ts',
    change: 'the master signature stamps no return, so a client who signed the packet in the portal still has every return blocked at Scheduled',
    test: api('test/return-controls.spec.ts'),
    apply: (t) => {
      const a = 'const stamped = await stampEngagementLetterOnContactReturns(app, p.contact_id);';
      must(t, a);
      return t.replace(a, 'const stamped = [];');
    },
    expectRed: /engagement_letter|stamp|signature/i,
  },
  {
    item: 'ruling 11 preparer assignment: the preparer_required gate made unreachable',
    file: 'apps/api/src/modules/tax/pipeline.ts',
    change: 'the gate branch never taken, so preparation starts on a return assigned to nobody',
    test: api('test/return-controls.spec.ts'),
    apply: (t) => {
      const a = "if (toStage === 'in_preparation' && !row.preparer_id) {";
      must(t, a);
      return t.replace(a, "if (false && toStage === 'in_preparation' && !row.preparer_id) {");
    },
    expectRed: /preparer_required|preparer/i,
  },
  {
    item: 'ruling 12 extension: the future-date refusal made unreachable',
    file: 'apps/api/src/modules/tax/extension.ts',
    change: "the filed-date-in-future branch never taken, so an extension recorded as filed tomorrow buys a deadline off a filing nobody has made",
    test: api('test/return-controls.spec.ts'),
    apply: (t) => {
      const a = "if (calendarDay(filedOn, 'filedOn') > calendarDay(today, 'today')) {";
      must(t, a);
      return t.replace(a, "if (false && calendarDay(filedOn, 'filedOn') > calendarDay(today, 'today')) {");
    },
    expectRed: /future|filed date|extension/i,
  },
];
