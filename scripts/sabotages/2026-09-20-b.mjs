/*
 * THE 2026-09-20 BATCH B (rulings 13 and 15): one sabotage per ruling, run through
 * scripts/sabotage-run.mjs so the reconciliation table is read from tasks/sabotage/2026-09-20.log
 * rather than composed.
 *
 *   R13 the accepted quote's lines ignored — the quoted range falls back to the BASE return line
 *       alone, which is the defect this ruling fixed: a quote carrying a schedule reads low, so the
 *       exact figure the client accepted lands "outside the quoted range" and the preparer is asked
 *       to justify quoted scope as if it were scope creep;
 *   R15 the paper mailing no longer satisfies its jurisdiction — a recorded mailing stops counting
 *       and only an acknowledgment does, so a return declared on paper waits forever on an
 *       acceptance that can never arrive and never completes.
 */
export const date = '2026-09-20';
const api = (spec) => ({ kind: 'api', spec });
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'ruling 13 quoted range: the accepted quote\'s lines ignored, the base line alone',
    file: 'apps/api/src/modules/tax/routes.ts',
    change:
      'the accepted quote\'s summed lines discarded, so the range falls back to the base return item and every quote with a schedule on it reads low',
    test: api('test/return-controls.spec.ts'),
    apply: (t) => {
      const a = 'const quoted = await acceptedQuoteRange(app, te.engagement_id);';
      must(t, a);
      return t.replace(a, 'const quoted = null;');
    },
    expectRed: /quoted range|schedule|quote/i,
  },
  {
    item: 'ruling 15 paper filing: a recorded mailing no longer satisfies its jurisdiction',
    file: 'apps/api/src/modules/tax/pipeline.ts',
    change:
      'the satisfied filter reads accepted_on for every row, so a paper jurisdiction waits on an acknowledgment that never comes and the return never completes',
    test: api('test/completion.spec.ts'),
    apply: (t) => {
      const a = ".filter((d) => (d.filingMethod === 'paper' ? d.mailedOn !== null : d.acceptedOn !== null))";
      must(t, a);
      return t.replace(a, '.filter((d) => d.acceptedOn !== null)');
    },
    expectRed: /paper|mailing|jurisdiction/i,
  },
];
