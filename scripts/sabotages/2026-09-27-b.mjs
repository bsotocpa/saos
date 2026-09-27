/*
 * The 2026-09-27 batch, item B: R68, the importer's probe on a _copy database only, and the billing
 * hold on imported engagements. Two sabotages, both on the API suite:
 *
 *   R68a  the probe's _copy predicate removed: `if (!isCopyDatabaseName(databaseName))` becomes a check
 *         that the name is non-empty, so the probe runs on the spec database (saos_api_test_trello_import),
 *         files its synthetic return and raises an invoice; the spec's "REFUSES before writing" test is
 *         red on `refused` and on the footprint counts.
 *
 *   R68b  the hold check removed from the filed-return invoice factory: invoiceForFiledEngagement no
 *         longer asks billingHoldRefusal, so a held engagement reaches createInvoice, whose own guard
 *         throws 409 billing_hold inside the stage move; the spec's "COUNTS a held engagement" test is
 *         red because the factory threw instead of counting (no task, no { refused: 'billing_hold' }).
 *
 * Run through scripts/sabotage-run.mjs so the report table is read from tasks/sabotage/2026-09-27.log:
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-27-b.mjs
 */
export const date = '2026-09-27';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R68a the importer probe runs on a _copy database only: the predicate removed so the probe writes on the spec database',
    file: 'apps/api/scripts/trello-probe.ts',
    change: 'the guard `if (!isCopyDatabaseName(databaseName))` replaced by `if (!databaseName)`: any named database passes, the probe files a synthetic return and raises an invoice on saos_api_test_trello_import',
    test: { kind: 'api', spec: 'test/trello-import.spec.ts' },
    apply: (t) => {
      const a = 'if (!isCopyDatabaseName(databaseName)) {';
      must(t, a);
      return t.replace(a, 'if (!databaseName) {');
    },
    expectRed: /REFUSES before writing/,
  },
  {
    item: 'R68b every invoice factory checks the billing hold: the check removed from the filed-return factory',
    file: 'apps/api/src/modules/billing/service.ts',
    change: 'invoiceForFiledEngagement no longer calls billingHoldRefusal (hold = { held: false }); a held engagement reaches createInvoice, whose guard throws 409 inside the stage move instead of the factory counting the refusal and raising the task',
    test: { kind: 'api', spec: 'test/billing-hold.spec.ts' },
    apply: (t) => {
      const a = "const hold = await billingHoldRefusal(app, te.engagement_id, { type: 'system', label: actor.label }, { via: 'invoiceForFiledEngagement' });";
      must(t, a);
      return t.replace(a, 'const hold = { held: false } as Awaited<ReturnType<typeof billingHoldRefusal>>;');
    },
    expectRed: /COUNTS a held engagement/,
  },
];
