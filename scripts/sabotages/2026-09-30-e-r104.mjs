/*
 * Batch 14, R104 (Brian, 2026-09-30): every SQL "today" is Chicago's. One sabotage per class the
 * sweep fixed, (c) a site that could refuse, misdate or misfile tax work and (b) a site wrong in
 * display or a non-tax record, each caught by chicago-day.spec.ts at any hour (the database at UTC+14
 * and at UTC-12); and the root check that refuses the server-clock forms.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-30-e-r104.mjs
 */
export const date = '2026-09-30';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };
const swap = (from, to) => (t) => { must(t, from); return t.replace(from, to); };

export const items = [
  {
    item: 'R104 (c): the price book in force read on the server\'s UTC day again',
    file: 'apps/api/src/chicago-day.ts',
    change: 'priceBookInForce compares effective_from and effective_to with CURRENT_DATE; a version effective tomorrow in Chicago comes into force at 19:00 the evening before',
    test: { kind: 'api', spec: 'test/chicago-day.spec.ts' },
    apply: swap('return `${p}effective_from <= ${CHICAGO_TODAY} AND (${p}effective_to IS NULL OR ${p}effective_to > ${CHICAGO_TODAY})`;', 'return `${p}effective_from <= CURRENT_DATE AND (${p}effective_to IS NULL OR ${p}effective_to > CURRENT_DATE)`;'),
    expectRed: /the price book in force/,
  },
  {
    item: 'R104 (b): an hour logged without a day dated on the server\'s UTC day again',
    file: 'apps/api/src/modules/tasks/routes.ts',
    change: 'POST /time-entries defaults entry_date to CURRENT_DATE; an hour logged after 19:00 Chicago is dated tomorrow',
    test: { kind: 'api', spec: 'test/chicago-day.spec.ts' },
    apply: swap('COALESCE($6, ${CHICAGO_TODAY})', 'COALESCE($6, CURRENT_DATE)'),
    expectRed: /an hour logged without a day/,
  },
  {
    item: 'R104 guard: a server-clock day written back into the API',
    file: 'apps/api/src/modules/notices/service.ts',
    change: 'the notice escalation window reads CURRENT_DATE again; check:chicago-dates must refuse it in the root chain',
    test: { kind: 'guard', spec: 'check:chicago-dates' },
    apply: swap('response_deadline <= ${CHICAGO_TODAY} + $1::int', 'response_deadline <= CURRENT_DATE + $1::int'),
    expectRed: /notices\/service\.ts:\d+ CURRENT_DATE/,
  },
];
