/*
 * Batch 15 step 3 (Brian, 2026-09-30), the API halves: R109 (a locked estimate names the version it was
 * locked under), R110 (a superseded file never reaches the client), R108 (the staff's words never reach
 * the client). The walk halves (path I) are sabotaged in 2026-09-30-g.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-30-f-batch15-api.mjs
 */
export const date = '2026-09-30';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };
const swap = (from, to) => (t) => { must(t, from); return t.replace(from, to); };

export const items = [
  {
    item: 'R109: the locked range reads the book in force again',
    file: 'apps/api/src/modules/tax/routes.ts',
    change: 'quotedRangeFor ignores estimate_price_book_version_id and names the version in force; the spec must refuse it',
    test: { kind: 'api', spec: 'test/estimate-version.spec.ts' },
    apply: swap('price_book_version: locked ?? version.versionNumber', 'price_book_version: version.versionNumber'),
    expectRed: /a locked estimate names the version it was locked under/,
  },
  {
    item: 'R110: a superseded file reaches the client again',
    file: 'apps/api/src/modules/portal/routes.ts',
    change: 'GET /portal/documents drops "AND d.superseded_by IS NULL"; the spec must refuse it',
    test: { kind: 'api', spec: 'test/batch15.spec.ts' },
    apply: swap(' AND d.withdrawn_at IS NULL AND d.superseded_by IS NULL', ' AND d.withdrawn_at IS NULL'),
    expectRed: /R110: each file names its return/,
  },
  {
    item: 'R108: the client reads the staff\'s withdrawal note',
    file: 'apps/api/src/modules/portal/routes.ts',
    change: 'GET /portal/engagements returns WITHDRAWN_REASON_SQL (the staff note) as withdrawn_kind; the spec must refuse it',
    test: { kind: 'api', spec: 'test/batch15.spec.ts' },
    apply: (t) => {
      const a = '${WITHDRAWN_ON_SQL} AS withdrawn_on, ${WITHDRAWN_KIND_SQL} AS withdrawn_kind';
      must(t, a);
      return t.replace(a, '${WITHDRAWN_ON_SQL} AS withdrawn_on, ${WITHDRAWN_KIND_SQL} AS withdrawn_kind, ${(await import(\'../tax/withdrawn.ts\')).WITHDRAWN_REASON_SQL} AS withdrawn_note');
    },
    expectRed: /R108: a withdrawn return carries its day and reason/,
  },
];
