/*
 * The 2026-09-27 batch 7, item D: R73, the send gate reads the business as the database index does.
 *
 *   R73  activeEngagementsFor matches business_id IS NOT DISTINCT FROM the quote's business. The
 *        condition is made always true (the parameter kept typed), so the gate reads (contact, line, period) alone again: an S corporation
 *        owner's plain 1040 quote is refused as a change order of the corporation's 1120-S, and the
 *        owner-and-entity test in engagement-period.spec.ts is red.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-27-d-r73.mjs
 */
export const date = '2026-09-27';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R73 the change-order send gate reads the business: the business condition in activeEngagementsFor removed',
    file: 'apps/api/src/modules/engagements/period.ts',
    change: "`AND business_id IS NOT DISTINCT FROM $4::uuid` replaced by `AND ($4::uuid IS NULL OR $4::uuid IS NOT NULL)` in activeEngagementsFor (the parameter still typed, the condition always true); the gate matches (contact, line, period) alone and refuses an S corporation owner's own 1040 as a change order of the 1120-S",
    test: { kind: 'api', spec: 'test/engagement-period.spec.ts' },
    apply: (t) => {
      const a = '        AND business_id IS NOT DISTINCT FROM $4::uuid\n';
      must(t, a);
      return t.replace(a, '        AND ($4::uuid IS NULL OR $4::uuid IS NOT NULL)\n');
    },
    expectRed: /THE OWNER AND THE ENTITY/,
  },
];
