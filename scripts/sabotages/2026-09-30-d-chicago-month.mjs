/*
 * Receipt run 54 (2026-09-30): the executive view's MTD and YTD, and the Hilo sessions this month,
 * counted from the database's UTC month; in the last evening of a Chicago month MTD read the next one.
 * They now count from the first instant of the month and year in Chicago. The UTC month put back.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-30-d-chicago-month.mjs
 */
export const date = '2026-09-30';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'Receipt run 54: MTD counted from the UTC month again',
    file: 'apps/api/src/modules/dashboards/service.ts',
    change: "CHICAGO_MONTH_START back to date_trunc('month', now()); the boundary spec must refuse an invoice paid a minute before the Chicago month counted in it",
    test: { kind: 'api', spec: 'test/dashboards.spec.ts' },
    apply: (t) => {
      const a = "const CHICAGO_MONTH_START = `(date_trunc('month', now() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago')`;";
      must(t, a);
      return t.replace(a, "const CHICAGO_MONTH_START = `date_trunc('month', now())`;");
    },
    expectRed: /MTD and YTD count from the first instant of the month in Chicago/,
  },
];
