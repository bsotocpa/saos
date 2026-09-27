/*
 * The 2026-09-26 batch, item H: R64, the role-aware navigation. One sabotage, on the harness, in the
 * shell — because the ruling is about what the screen shows a role:
 *
 *   R64  the top navigation shows only pages the session can open. Feed the filter the wildcard
 *        instead of the session's permissions and every session sees all 25 items; the preparer's
 *        day is red at T2, where the rendered count must equal the tax_preparer row of the
 *        nav-items-by-role record (11), at both viewports.
 *
 * Run through scripts/sabotage-run.mjs so the report table is read from tasks/sabotage/2026-09-26.log:
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-26-h.mjs
 */
export const date = '2026-09-26';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R64 the role filter on the navigation removed: the shell feeds visibleNav the wildcard instead of the session',
    file: 'apps/internal/app/shell.tsx',
    change: "`visibleNav(me.permissions)` replaced by `visibleNav(['*'])`; every signed-in session sees all 25 items, Staff and Settings included, and the preparer's day fails T2 (11 expected)",
    test: { kind: 'harness', spec: 'tests/ops-preparer-day.spec.ts' },
    apply: (t) => {
      const a = 'const items = me ? visibleNav(me.permissions) : [];';
      must(t, a);
      return t.replace(a, "const items = me ? visibleNav(['*']) : [];");
    },
    expectRed: /home is the queue/,
  },
];
