/*
 * The 2026-09-29 batch 10, step 4: R89, one engagement with one return per year. Two sabotages, as
 * ruled: the key change and the surcharge.
 *
 *   1  The key back to engagement_id alone (and the migration's own guard against exactly that
 *      removed, so the key itself is what is tested): a two-year acceptance cannot open its second
 *      return; multi-year.spec.ts is red.
 *   2  The surcharge boundary moved one year: a return three years back no longer carries the
 *      prior-year surcharge; multi-year.spec.ts is red.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-29-e-r89.mjs
 */
export const date = '2026-09-29';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R89 tax_engagements is keyed by (engagement_id, tax_year): the key back to engagement_id alone',
    file: 'packages/db/migrations/0134_multi_year_engagements.js',
    change: 'the new key UNIQUE (engagement_id, tax_year) written as UNIQUE (engagement_id), and the migration\'s guard against a lone engagement_id key removed',
    test: { kind: 'api', spec: 'test/multi-year.spec.ts' },
    apply: (t) => {
      const key = 'ADD CONSTRAINT tax_engagements_engagement_year_key UNIQUE (engagement_id, tax_year)';
      const guard = "if (left.rows.length > 0) throw new Error(`0134: engagement_id is still unique alone (${left.rows.map((r) => r.conname).join(', ')})`);";
      must(t, key);
      must(t, guard);
      return t.replace(key, 'ADD CONSTRAINT tax_engagements_engagement_year_key UNIQUE (engagement_id)').replace(guard, '');
    },
    // Matched against the failing tests' names: the two-year acceptance and the key test.
    expectRed: /one return per year|two returns/,
  },
  {
    item: 'R89 the prior-year surcharge applies once per quoted year more than two back',
    file: 'apps/api/src/modules/pricing/quote-years.ts',
    change: '`surchargeApplies(y, today)` replaced by `surchargeApplies(y + 1, today)`: a return three years back reads as two back and carries no surcharge',
    test: { kind: 'api', spec: 'test/multi-year.spec.ts' },
    apply: (t) => {
      const a = 'return years.filter((y) => surchargeApplies(y, today));';
      must(t, a);
      return t.replace(a, 'return years.filter((y) => surchargeApplies(y + 1, today));');
    },
    expectRed: /PRIOR_YEAR_SURCHARGE|surcharge/,
  },
];
