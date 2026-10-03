/*
 * Batch 17 (Brian, 2026-10-02): R118, correcting a withdrawal's kind, and R119, absence checks wait for
 * the page (scripts/check-absence-waits.mjs). Each item undoes one piece; the named test must go red for
 * that reason, then green once the file is restored.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-10-02-l-r118-r119.mjs
 */
export const date = '2026-10-02';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };
const swap = (from, to) => (t) => { must(t, from); return t.replace(from, to); };
const api = { kind: 'api', spec: 'test/withdrawal-kind-correct.spec.ts' };
const walk = { kind: 'harness', spec: 'tests/batch16-withdrawals.spec.ts', projects: ['webkit-375', 'chromium-1440'] };
const check = { kind: 'guard', spec: 'check:absence-waits' };

export const items = [
  {
    item: "R118: the kind correction open to anyone who manages returns",
    file: 'apps/api/src/modules/tax/routes.ts',
    change: "the route's permission is engagements.tax.manage, not the CEO's explicit-only one; a preparer corrects a kind",
    test: api,
    apply: swap("{ preHandler: [app.authenticate, requirePermission(CORRECT_WITHDRAWAL_KIND_PERMISSION)] },", "{ preHandler: [app.authenticate, requirePermission('engagements.tax.manage')] },"),
    expectRed: /only the CEO, only with a reason/,
  },
  {
    item: 'R118: the audit row carries no "before"',
    file: 'apps/api/src/modules/tax/withdrawal-kind.ts',
    change: 'the correction is audited with the new kind only; the kind it replaced is lost',
    test: api,
    apply: swap('details: { before, after: kind, reason,', 'details: { after: kind, reason,'),
    expectRed: /audited with before and after/,
  },
  {
    item: 'R118: the correction answers "ok" and changes nothing',
    file: 'apps/api/src/modules/tax/withdrawal-kind.ts',
    change: "the UPDATE is aimed at no row; the portal never follows",
    test: api,
    apply: swap("WHERE id = $1 AND stage = 'withdrawn'`, [taxEngagementId, kind]);", "WHERE id = $1 AND stage = 'filed'`, [taxEngagementId, kind]);"),
    expectRed: /the portal follows/,
  },
  {
    item: "R118: Ops' correction sends the kind the return already has",
    file: 'apps/internal/components/withdrawn-return.tsx',
    change: '"Correct the kind…" posts the current kind; the server refuses it as unchanged and the line never changes',
    test: walk,
    apply: swap("const to = hidden ? 'client' : 'firm_record';", "const to = hidden ? 'firm_record' : 'client';"),
    expectRed: /I6–I7/,
  },
  {
    item: 'R119: a fixed wait put back before an absence (the Reopen proof)',
    file: 'apps/e2e/tests/ops-reopen-return.spec.ts',
    change: "a waitForTimeout between the row's anchor and \"no Reopen control\"; the check must refuse it",
    test: check,
    apply: swap("\"the completed return's row is on her page\").toBeVisible();\n", "\"the completed return's row is on her page\").toBeVisible();\n    await page.waitForTimeout(800);\n"),
    expectRed: /ops-reopen-return\.spec\.ts:\d+: an absence after a fixed wait/,
  },
  {
    item: 'R119: a navigation followed straight by an absence (the paid invoice)',
    file: 'apps/e2e/tests/ops-path-b.spec.ts',
    change: '"Paid" moved back after "no Pay button": the absence is read right after the reload',
    test: check,
    apply: (t) => {
      const paid = "      await expect(page.getByText(COPY.paid, { exact: true }).first(), 'the client reads it as paid').toBeVisible();\n";
      must(t, paid);
      return t.replace(paid, '').replace("'the paid invoice offers no way to pay it again').toHaveCount(0);\n", "'the paid invoice offers no way to pay it again').toHaveCount(0);\n" + paid);
    },
    expectRed: /ops-path-b\.spec\.ts:\d+: an absence after a navigation/,
  },
  {
    item: 'R119: the check blind to fixed waits',
    file: 'scripts/check-absence-waits.mjs',
    change: 'a fixed wait no longer opens a window; with the Reopen proof given its fixed wait back, the check must still refuse it',
    test: check,
    apply: (t) => {
      must(t, "if (OPEN_WAIT.test(t)) next = { kind: 'fixed wait', line: ev.line };");
      return t.replace("if (OPEN_WAIT.test(t)) next = { kind: 'fixed wait', line: ev.line };", "if (false) next = null;");
    },
    // The walks are clean, so a blind check stays green: this item proves the check's own test does.
    expectRed: /check-absence-waits self-test/,
  },
];
