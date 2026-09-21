/*
 * The 2026-09-20 batch, item J: the Trello importer's two amended rules, one sabotage each, and the
 * review-file reconciliation that has nothing to break.
 *
 *   R31  a "filed, awaiting ack" card whose tax year is in the paper lane is declared PAPER by the
 *        year's lane, flagged, with no mailing invented. The sabotage pins the method to e-file —
 *        the shape the first version of R23 would have written had it not refused — and the spec's
 *        old-year test is red: an old year e-filed by an import is the CLAUDE.md hard rule broken.
 *   R33  a sales-tax or payroll fact lands on an engagement through import-facts.ts, and a CLOSED
 *        service creates nothing. The sabotage removes the liveness check, so a closed sales-tax row
 *        creates an active engagement for a service the card says is over; the spec's closed test
 *        is red on the first assertion.
 *   R34  the review-file reconciliation is a count over the matcher's own output files; the script
 *        asserts its own sums and there is no guard in the application to break. Logged as none.
 *
 * Run through scripts/sabotage-run.mjs so the report table is read from tasks/sabotage/2026-09-20.log:
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-20-j.mjs
 */
export const date = '2026-09-20';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R31 the paper lane on an imported filed-awaiting-ack return: the method pinned to e-file regardless of the year',
    file: 'apps/api/src/modules/tax/import.ts',
    change: "the year-derived lane replaced by the constant 'efile'; an old year is declared e-file, which CLAUDE.md forbids",
    test: { kind: 'api', spec: 'test/trello-import.spec.ts' },
    apply: (t) => {
      const a = "const filingMethod: 'efile' | 'paper' = filingLane(row.tax_year) === 'efile' ? 'efile' : 'paper';";
      must(t, a);
      return t.replace(a, "const filingMethod: 'efile' | 'paper' = 'efile';");
    },
    expectRed: /R31: an OLD year declares PAPER/,
  },
  {
    item: 'R33 a closed sales-tax or payroll service: the liveness check removed, so a closed service gets an active engagement',
    file: 'apps/api/src/modules/engagements/import-facts.ts',
    change: 'the isLiveServiceFact gate before the find-or-create replaced by a constant false; a row the card marks closed creates an active sales_tax engagement',
    test: { kind: 'api', spec: 'test/trello-import.spec.ts' },
    apply: (t) => {
      const a = '  if (!isLiveServiceFact(line, input.values)) {\n    await ledger(null, 0);';
      must(t, a);
      return t.replace(a, '  if (false) {\n    await ledger(null, 0);');
    },
    expectRed: /R33: a CLOSED service creates nothing/,
  },
  {
    item: 'R34 the review-file reconciliation (150 names against 89 review rows)',
    file: 'scripts/review-file-reconciliation.mjs',
    none: 'a count over the matcher\'s own output files with no guard in the application to break; the script asserts that its classes sum from 150 to 89 and exits non-zero when they do not',
  },
];
