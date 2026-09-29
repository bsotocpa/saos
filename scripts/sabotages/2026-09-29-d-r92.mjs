/*
 * The 2026-09-29 batch 10, step 3: R92, the pair door. The survivor is the record with the portal
 * user, else the most engagements. The portal rule inverted: the record a client signs in with is
 * retired; merge-pair.spec.ts is red.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-29-d-r92.mjs
 */
export const date = '2026-09-29';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R92 the pair door keeps the record with the portal sign-in: the portal rule inverted',
    file: 'apps/api/src/modules/crm/merge.ts',
    change: "`x.portal ? { survivor: a, retired: b` replaced by `x.portal ? { survivor: b, retired: a`: the merge retires the record the client signs in with",
    test: { kind: 'api', spec: 'test/merge-pair.spec.ts' },
    apply: (t) => {
      const a = "if (x.portal !== y.portal) return x.portal ? { survivor: a, retired: b, rule: 'portal_user' } : { survivor: b, retired: a, rule: 'portal_user' };";
      must(t, a);
      return t.replace(a, "if (x.portal !== y.portal) return x.portal ? { survivor: b, retired: a, rule: 'portal_user' } : { survivor: a, retired: b, rule: 'portal_user' };");
    },
    expectRed: /portal user/,
  },
];
