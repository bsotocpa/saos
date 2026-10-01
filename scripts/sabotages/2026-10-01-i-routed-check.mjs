/*
 * Batch 15 step 5, after receipt run 59 (2026-10-01): the layout check measures a tap where the browser
 * routes it, and gained two checks (spill, crowded). Each fix that run forced is undone in turn, in the
 * project where it bites; the audit must go red with that page and that failure in its log.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-10-01-i-routed-check.mjs
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const date = '2026-10-01';
const LOG = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps', 'e2e', '.artifacts', 'layout-failures.jsonl');
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };
const swap = (...pairs) => (t) => { for (const [from, to] of pairs) { must(t, from); t = t.replace(from, to); } return t; };
const audit = (projects) => ({ kind: 'harness', spec: 'tests/layout-audit.spec.ts', projects });
const clear = () => rmSync(LOG, { force: true });
/** The failures logged for a page, a check and (optionally) a detail, as evidence, or null when none. */
const found = (key, check, detail = /./) => () => {
  if (!existsSync(LOG)) return null;
  const rows = readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => r.key.startsWith(key) && r.check === check && detail.test(r.detail));
  return rows.length ? `${rows.length} ${check} on ${key} (${rows[0].element.slice(0, 40)}: ${rows[0].detail.slice(0, 50)})` : null;
};
const TITLE = /every Ops page and every portal page passes the layout check/;

export const items = [
  {
    item: 'spill: a stacked cell held to 44px again (the Staff actions over the next card)',
    file: 'apps/internal/app/globals.css',
    change: "the stacked cell's height: auto removed; R114's 44px clamps the Staff actions cell at 375 and its buttons lie over the next person",
    test: audit(['webkit-375']),
    apply: swap(['  table.stack td { height: auto; }', '  table.stack td { }']),
    before: clear,
    evidence: found('ops-admin-staff', 'spill'),
    expectRed: TITLE,
  },
  {
    item: 'crowded: the Tasks header without its More menu',
    file: 'apps/internal/app/tasks/page.tsx',
    change: 'Project boards, Workload and Create Task side by side again at 375; the check must ask for the primary and More',
    test: audit(['chromium-375']),
    apply: swap(
      ['        <MoreActions>\n          <Link className="btn ghost" href="/tasks/boards">Project boards</Link>', '        <>\n          <Link className="btn ghost" href="/tasks/boards">Project boards</Link>'],
      ["Workload</button>\n        </MoreActions>", 'Workload</button>\n        </>'],
    ),
    before: clear,
    evidence: found('ops-tasks', 'crowded'),
    expectRed: TITLE,
  },
  {
    item: "tap-target: a field under its own label's extension again (run 59's walk failure)",
    file: 'apps/internal/app/globals.css',
    change: "fields inside a label lose position and z-index; the label's ::after covers the Asked for tick, and a tap on its face reaches the label",
    test: audit(['chromium-1440']),
    apply: swap(['label input:not([type=hidden]), label select, label textarea { position: relative; z-index: 1; }', 'label input:not([type=hidden]), label select, label textarea { }']),
    before: clear,
    evidence: found('ops-admin-document-checklist', 'tap-target', /centre reaches label/),
    expectRed: TITLE,
  },
  {
    item: 'tap-target: the Tasks filter rail sticky with its own scroll at 768 again',
    file: 'apps/internal/app/globals.css',
    change: 'at 900 and below the rail is sticky over the list and cuts off its last filters; a tap on them lands on the list',
    test: audit(['chromium-768']),
    apply: swap(['@media (max-width: 900px) { .task-layout > .rail { position: static; max-height: none; overflow: visible; } }', '@media (max-width: 900px) { .task-layout > .rail { } }']),
    before: clear,
    evidence: found('ops-tasks', 'tap-target', /centre reaches/),
    expectRed: TITLE,
  },
];
