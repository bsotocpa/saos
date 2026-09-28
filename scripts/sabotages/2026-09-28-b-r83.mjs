/*
 * The 2026-09-28 batch 9, item R83: the document checklist from the quoted lines, two sabotages.
 *
 *   R83a  acceptance opens the return's checklist. The call removed: an accepted 1040 has no
 *         checklist, the portal shows no slots and the Ops row no counts; path B's B7b is red.
 *   R83b  "Request documents" goes through document_checklist_request, seeded off. The gate read as
 *         always armed: the email leaves while the automation is off; the API spec's OFF test is red.
 *
 * Hold the harness lock: node scripts/sabotage-run.mjs scripts/sabotages/2026-09-28-b-r83.mjs
 */
export const date = '2026-09-28';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R83 acceptance opens the return\'s document checklist from its lines: the call removed',
    file: 'apps/api/src/modules/pricing/quotes.ts',
    change: '`await openChecklistRequest(app, {` replaced by `void (async (..._a) => undefined)(app, {`: an accepted 1040 opens no checklist, so the portal has no slots and the Ops row no counts',
    test: { kind: 'harness', spec: 'tests/ops-path-b.spec.ts' },
    apply: (t) => {
      const a = 'await openChecklistRequest(app, {';
      must(t, a);
      return t.replace(a, 'void openChecklistRequest; void (async (..._a: unknown[]) => undefined)(app, {');
    },
    expectRed: /1040 on extension/,
  },
  {
    item: 'R83 "Request documents" emails through document_checklist_request, seeded off: the gate read as armed',
    file: 'apps/api/src/modules/documents/checklist.ts',
    change: "`if (!(await isAutomationEnabled(app, 'document_checklist_request'))) {` replaced by `if (false) {`: the missing-items email leaves while the automation is off",
    test: { kind: 'api', spec: 'test/document-checklist.spec.ts' },
    apply: (t) => {
      const a = "if (!(await isAutomationEnabled(app, 'document_checklist_request'))) {";
      must(t, a);
      return t.replace(a, 'if ((await isAutomationEnabled(app, \'document_checklist_request\')) && false) {');
    },
    expectRed: /automation OFF/,
  },
];
