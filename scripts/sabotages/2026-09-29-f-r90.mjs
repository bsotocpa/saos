/*
 * The 2026-09-29 batch 10, step 5: R90, the Trello cutover facts and the internal task ladder.
 *
 *   1  client_self_files falls through to the firm-files path: the import opens a sales-tax
 *      engagement for a client who files their own ST-1; cutover-facts.spec.ts is red.
 *   2  the unconfirmed write loses its guard: an unconfirmed import replaces a month a person
 *      confirmed; cutover-facts.spec.ts is red.
 *   3  the ladder's alert threshold goes to thirty business days: a task three business days past
 *      due raises no CEO alert; cutover-facts.spec.ts is red.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-29-f-r90.mjs
 */
export const date = '2026-09-29';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R90 a client who files their own ST-1 gets no sales-tax engagement',
    file: 'apps/api/src/modules/engagements/import-facts.ts',
    change: "`const selfFiles = stStatus === 'client_self_files' && ...` replaced by `const selfFiles = false && ...`: a self-filer's card opens a sales-tax engagement",
    test: { kind: 'api', spec: 'test/cutover-facts.spec.ts' },
    apply: (t) => {
      const a = "const selfFiles = stStatus === 'client_self_files' && isLiveServiceFact(line, input.values);";
      must(t, a);
      return t.replace(a, "const selfFiles = false && stStatus === 'client_self_files' && isLiveServiceFact(line, input.values);");
    },
    expectRed: /client_self_files/,
  },
  {
    item: 'R90 an unconfirmed import never replaces a value that is not itself unconfirmed',
    file: 'apps/api/src/modules/engagements/import-facts.ts',
    change: '`WHERE id = $1 AND (books_current_through IS NULL OR books_current_through_unconfirmed)` loses its guard: an unconfirmed month overwrites a confirmed one',
    test: { kind: 'api', spec: 'test/cutover-facts.spec.ts' },
    apply: (t) => {
      const a = 'WHERE id = $1 AND (books_current_through IS NULL OR books_current_through_unconfirmed)';
      must(t, a);
      return t.replace(a, 'WHERE id = $1 AND (true OR books_current_through_unconfirmed)');
    },
    expectRed: /books current through/,
  },
  {
    item: 'R90 three business days past due raises a CEO alert on an internal task',
    file: 'apps/api/src/modules/tasks/service.ts',
    change: '`INTERNAL_TASK_ALERT_BUSINESS_DAYS = 3` raised to 30: a task three business days overdue raises nothing',
    test: { kind: 'api', spec: 'test/cutover-facts.spec.ts' },
    apply: (t) => {
      const a = 'export const INTERNAL_TASK_ALERT_BUSINESS_DAYS = 3;';
      must(t, a);
      return t.replace(a, 'export const INTERNAL_TASK_ALERT_BUSINESS_DAYS = 30;');
    },
    expectRed: /internal task ladder/,
  },
];
