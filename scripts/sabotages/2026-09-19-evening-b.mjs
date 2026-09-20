/*
 * The 2026-09-19 EVENING-B batch (R3, R4 and BUILD 5): one sabotage per item, run through
 * scripts/sabotage-run.mjs so the report table is read from tasks/sabotage/2026-09-19.log.
 *
 * BUILD 5 runs backwards, and that is the point. The other two break a guard and expect red; this
 * one PUTS BACK the thing that was removed — the period badge on a non-tax engagement line — and
 * expects the harness to notice. A removal nothing asserts is not a fix, it is a coincidence.
 */
export const date = '2026-09-19';
const api = (spec) => ({ kind: 'api', spec });
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  { item: 'R3 e-file acks: efile.manage taken off the tax preparer', file: 'packages/db/seeds/data/roles.mjs',
    change: "the 'efile.manage' grant removed from the tax_preparer role, so the seed no longer gives the preparer her own screen",
    test: api('test/roles-grants.spec.ts'),
    apply: (t) => { const a = "      'efile.manage',\n"; must(t, a); return t.replace(a, ''); },
    expectRed: /efile\.manage/ },

  { item: 'R4 add a business: businesses.write no longer accepted on the route', file: 'apps/api/src/modules/crm/routes.ts',
    change: "the businesses route narrowed back to requirePermission('contacts.write'), so the entity VA's narrow grant opens nothing",
    test: api('test/roles-grants.spec.ts'),
    apply: (t) => { const a = "requireAnyPermission('contacts.write', 'businesses.write')"; must(t, a); return t.replace(a, "requirePermission('contacts.write')"); },
    expectRed: /businesses\.write/ },

  { item: 'BUILD 5 defect 4 (reversed): the period badge restored on non-tax engagement lines', file: 'apps/internal/app/clients/[id]/page.tsx',
    change: 'the tax-only guard removed from the period badge, so a bookkeeping line carries "period not recorded" and its set-period control again',
    test: { kind: 'harness', spec: 'tests/ops-client-page.spec.ts' },
    apply: (t) => { const a = "{e.service_line !== 'tax' ? null : e.period_key ? ("; must(t, a); return t.replace(a, '{e.period_key ? ('); },
    expectRed: /reads the way a person would/ },
];
