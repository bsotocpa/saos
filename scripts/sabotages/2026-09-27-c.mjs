/*
 * The 2026-09-27 batch, item C: R40, the business page's per-card permissions are the server's.
 * One sabotage, on the harness, in the aggregate GET /businesses/:id:
 *
 *   R40  the Invoices card is billing.manage, decided in the handler. The check is replaced by
 *        `true`, so the bookkeeper's session (contacts.read, no billing.manage) receives invoice rows
 *        she may not read; the page then renders the Invoices card with a count instead of "Not
 *        available to your role", and U3 (the role proof, ops-business-page.spec.ts) is red on the
 *        card's sentence and on the aggregate's `refused`.
 *
 * Run through scripts/sabotage-run.mjs so the report table is read from tasks/sabotage/2026-09-27.log
 * (hold the harness lock: the runner boots the harness twice):
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-27-c.mjs
 */
export const date = '2026-09-27';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R40 the Invoices card on the business page is billing.manage: the per-card check removed so the bookkeeper reads invoices she cannot',
    file: 'apps/api/src/modules/crm/routes.ts',
    change: "the handler's `const canInvoices = holds(actor, 'billing.manage')` replaced by `const canInvoices = true`: the aggregate sends invoice rows to every contacts.read session and the card renders them",
    test: { kind: 'harness', spec: 'tests/ops-business-page.spec.ts' },
    apply: (t) => {
      const a = "const canInvoices = holds(actor, 'billing.manage');";
      must(t, a);
      return t.replace(a, 'const canInvoices = true;');
    },
    expectRed: /U3/,
  },
];
