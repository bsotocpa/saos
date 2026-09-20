/*
 * THE 2026-09-19 EVENING BATCH A (rulings 1, 2 and 5): one sabotage per ruling, run through
 * scripts/sabotage-run.mjs so the reconciliation table is read from tasks/sabotage/2026-09-19.log
 * rather than composed.
 *
 *   R1  the scope-creep category requirement disabled — a fee above the locked estimate lands with
 *       a reason alone, which is exactly the shape this ruling replaced;
 *   R2  the awaiting check narrowed to federal — every declared state is ignored and federal alone
 *       completes the return, the defect item 4 fixed, reintroduced one level deeper;
 *   R5  the year-end gate made unreachable — an 8879 signed before the tax year closed authorizes
 *       the return.
 */
export const date = '2026-09-19';
const api = (spec) => ({ kind: 'api', spec });
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'evening ruling 1 final fee: the scope-creep category requirement disabled',
    file: 'apps/api/src/modules/tax/routes.ts',
    change: "the category half of the above-a-locked-estimate check made unreachable, so a reason alone passes and nothing records WHAT put the fee over",
    test: api('test/return-controls.spec.ts'),
    apply: (t) => {
      const a = "if (!scopeCreepReason) missing.push('a scope-creep category');";
      must(t, a);
      return t.replace(a, "if (false && !scopeCreepReason) missing.push('a scope-creep category');");
    },
    expectRed: /category|locked estimate/i,
  },
  {
    item: 'evening ruling 2 completion: the awaiting check narrowed to federal',
    file: 'apps/api/src/modules/tax/pipeline.ts',
    change: 'the awaiting filter keeps only federal, so every declared state is dropped and federal alone completes the return',
    test: api('test/completion.spec.ts'),
    apply: (t) => {
      const a = 'const awaiting = expected.filter((j) => !accepted.includes(j));';
      must(t, a);
      return t.replace(a, "const awaiting = expected.filter((j) => j === 'federal' && !accepted.includes(j));");
    },
    expectRed: /federal|state|jurisdiction/i,
  },
  {
    item: 'evening ruling 5 signed 8879: the tax-year-end gate made unreachable',
    file: 'apps/api/src/modules/tax/signed-8879.ts',
    change: 'the signed_before_year_end branch never taken, so a date before the tax year closed authorizes the return',
    test: api('test/sept19-walk.spec.ts'),
    apply: (t) => {
      const a = "if (calendarDay(input.signedOn, 'signedOn') < calendarDay(yearEnd, 'taxYearEnd')) {";
      must(t, a);
      return t.replace(a, "if (false && calendarDay(input.signedOn, 'signedOn') < calendarDay(yearEnd, 'taxYearEnd')) {");
    },
    expectRed: /backfill|year ended|8879/i,
  },
];
