/*
 * Batch 16 (Brian, 2026-10-02): R117, portal withdrawals, and the walk-path guard. Each item undoes one
 * piece; the named test must go red for that reason, then green once the file is restored.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-10-02-j-r117.mjs
 */
export const date = '2026-10-02';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };
const swap = (from, to) => (t) => { must(t, from); return t.replace(from, to); };
const api = { kind: 'api', spec: 'test/withdrawal-kind.spec.ts' };
const walk = { kind: 'harness', spec: 'tests/batch16-withdrawals.spec.ts', projects: ['webkit-375', 'chromium-1440'] };

export const items = [
  {
    item: "R117: the portal's engagements list shows the firm's own record again",
    file: 'apps/api/src/modules/portal/routes.ts',
    change: 'the hidden-return filter dropped from /portal/engagements; the duplicate reaches the client as a withdrawn line',
    test: api,
    apply: swap('          AND NOT COALESCE(${HIDDEN_FROM_PORTAL_SQL}, false)\n', ''),
    expectRed: /firm's own record withdrawn is gone from the portal/,
  },
  {
    item: "R117: the portal Documents list groups a file under the firm's own record",
    file: 'apps/api/src/modules/portal/routes.ts',
    change: "the hidden-return filter dropped from the Documents grouping; the client's file names the duplicate return",
    test: api,
    apply: swap('            AND NOT ${HIDDEN_FROM_PORTAL_SQL}\n       ) rt ON true', '       ) rt ON true'),
    expectRed: /firm's own record withdrawn is gone from the portal/,
  },
  {
    item: "R117: a document request on the firm's own record still asks the client",
    file: 'apps/api/src/modules/documents/routes.ts',
    change: 'the hidden-return filter dropped from /portal/document-requests',
    test: api,
    apply: swap("         AND NOT EXISTS (SELECT 1 FROM tax_engagements te WHERE te.id = dr.tax_engagement_id AND ${HIDDEN_FROM_PORTAL_SQL})\n", ''),
    expectRed: /firm's own record withdrawn is gone from the portal/,
  },
  {
    item: 'R117: a return withdrawn with no kind is not refused in words',
    file: 'apps/api/src/modules/tax/pipeline.ts',
    change: "the pipeline's withdrawal_kind_required check removed; the request reaches the database",
    test: api,
    apply: swap("  if (toStage === 'withdrawn' && !opts.withdrawalKind) {", "  if (toStage === 'withdrawn' && false && !opts.withdrawalKind) {"),
    expectRed: /a withdrawal without its kind is refused/,
  },
  {
    item: "R117: Ops' two withdraw buttons both record the client's kind",
    file: 'apps/internal/app/clients/[id]/page.tsx',
    change: '"Withdraw: our own record" sends withdrawalKind client; the duplicate stays on the portal and Ops does not mark it',
    test: walk,
    apply: swap("body: { outcome: 'withdrawn', withdrawalKind: r.choice, reason: r.reason }", "body: { outcome: 'withdrawn', withdrawalKind: 'client', reason: r.reason }"),
    expectRed: /I6–I7/,
  },
  {
    item: 'the walk-path guard: a walked path with no evidence entry',
    file: 'scripts/walk-evidence-reports.mjs',
    change: "path O's entry removed; check:walk-paths must refuse, naming O",
    test: { kind: 'guard', spec: 'check:walk-paths' },
    apply: (t) => { const i = t.indexOf('  O: '); if (i < 0) throw new Error('anchor missing: O'); const j = t.indexOf('\n', i); return t.slice(0, i) + t.slice(j + 1); },
    expectRed: /walk path O is in walk-steps\.json/,
  },
];
