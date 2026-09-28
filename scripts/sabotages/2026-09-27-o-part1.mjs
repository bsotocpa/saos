/*
 * The 2026-09-27 batch 9, item O: Report Part 1's three built items, one sabotage each, on the harness.
 *
 *   R86  correctionsApply is filed OR completed. Back to filed alone: a completed return offers no
 *        Correct the filing, and F7 in ops-filing-corrections.spec.ts is red.
 *   R87  the USE consent is asked per open tax engagement. An answer for ANY engagement made to cover
 *        every engagement again: the returning client's new engagement is offered nothing, and B3d in
 *        ops-consent-new-engagement.spec.ts is red.
 *   R88  the portal prints a wet-signed 8879's day as the calendar day (signed_on). Back to the instant
 *        in the reader's zone: Chicago reads the day before, and F9 is red.
 *
 * Hold the harness lock: node scripts/sabotage-run.mjs scripts/sabotages/2026-09-27-o-part1.mjs
 */
export const date = '2026-09-27';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R86 Correct the filing is offered on a completed return: correctionsApply back to filed alone',
    file: 'apps/internal/lib/return-controls.ts',
    change: "`return stage === 'filed' || stage === 'completed';` replaced by `return stage === 'filed';`: Brian's completed 1120S offers no correction",
    test: { kind: 'harness', spec: 'tests/ops-filing-corrections.spec.ts' },
    apply: (t) => {
      const a = "return stage === 'filed' || stage === 'completed';";
      must(t, a);
      return t.replace(a, "return stage === 'filed';");
    },
    expectRed: /F7–F9/,
  },
  {
    item: 'R87 the §7216 consent is asked per open tax engagement: any earlier answer made to cover every engagement',
    file: 'apps/api/src/modules/compliance/consent-presentation.ts',
    change: 'the covered test in useConsentEngagement replaced by "any answer at all": a returning client\'s new engagement is offered nothing, as Brian\'s 1040 was',
    test: { kind: 'harness', spec: 'tests/ops-consent-new-engagement.spec.ts' },
    apply: (t) => {
      const a = 'answers.rows.some((a) => a.engagement_id === e.id || (a.engagement_id === null && a.at.getTime() >= e.opened.getTime()));';
      must(t, a);
      return t.replace(a, 'answers.rows.length > 0 || e.id === null;');
    },
    expectRed: /B3c–B3d/,
  },
  {
    item: 'R88 the portal prints a wet-signed 8879 as its calendar day: the signed_on day ignored',
    file: 'apps/portal/app/sign/page.tsx',
    change: '`e.signed_on ? formatDate(e.signed_on, lang) : dayOf(e.completed_at, lang)` replaced by `dayOf(e.completed_at, lang)`: the midnight-UTC instant read in Chicago prints the day before',
    test: { kind: 'harness', spec: 'tests/ops-filing-corrections.spec.ts' },
    apply: (t) => {
      const a = 'e.signed_on ? formatDate(e.signed_on, lang) : dayOf(e.completed_at, lang)';
      must(t, a);
      return t.replace(a, 'dayOf(e.completed_at, lang) || formatDate(e.signed_on ?? null, lang)');
    },
    expectRed: /F7–F9/,
  },
];
