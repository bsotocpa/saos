/*
 * Batch 15 step 5 (Brian, 2026-09-30, R106 "Sabotage the check"): each of the layout check's four
 * failures put back into a page it was fixed on, one at a time, in the project where it bites. The audit
 * (tests/layout-audit.spec.ts) must go red, and the failure log must carry that page with that check: red
 * for any other reason (a gap, a build) is not the sabotage caught.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-10-01-h-layout-check.mjs
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
/** The failures logged for a page and a check (key prefix match), as evidence, or null when none. */
const found = (key, check) => () => {
  if (!existsSync(LOG)) return null;
  const rows = readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((r) => r.key.startsWith(key) && r.check === check);
  return rows.length ? `${rows.length} ${check} on ${key} (${rows[0].element.slice(0, 50)})` : null;
};
const TITLE = /every Ops page and every portal page passes the layout check/;

export const items = [
  {
    item: 'overflow: the Tasks grid columns back to 1fr, its children without min-width 0',
    file: 'apps/internal/app/globals.css',
    change: 'the task layout grows to its widest row at 768; the check must report the page wider than the screen',
    test: audit(['chromium-768']),
    apply: swap(
      ['@media (max-width: 900px) { .task-layout { grid-template-columns: minmax(0, 1fr); } }', '@media (max-width: 900px) { .task-layout { grid-template-columns: 1fr; } }'],
      ['.task-layout > * { min-width: 0; }', '.task-layout > * { }'],
    ),
    before: clear,
    evidence: found('ops-tasks', 'overflow'),
    expectRed: TITLE,
  },
  {
    item: 'word-broken: phone cards and cells back to overflow-wrap anywhere',
    file: 'apps/internal/app/globals.css',
    change: 'text in a narrow card may break between any two letters at 375; the check must report a word split',
    test: audit(['webkit-375']),
    apply: swap(['  .card, .list li, td, th { overflow-wrap: break-word; }', '  .card, .list li, td, th { overflow-wrap: anywhere; }']),
    before: clear,
    evidence: found('ops-', 'word-broken'),
    expectRed: TITLE,
  },
  {
    item: 'tap-target: the Tasks view tabs clip their hit extension again (overflow hidden)',
    file: 'apps/internal/app/globals.css',
    change: 'the view tabs are 30px drawn and their 44px extension is cut by the strip; the check must report them at 1440',
    test: audit(['chromium-1440']),
    apply: swap(['.viewtabs { display: inline-flex; border: 1px solid var(--line); border-radius: 9px; }', '.viewtabs { display: inline-flex; border: 1px solid var(--line); border-radius: 9px; overflow: hidden; }']),
    before: clear,
    evidence: found('ops-tasks', 'tap-target'),
    expectRed: TITLE,
  },
  {
    item: 'clipped: the portal "counts as" select squeezed to 64px',
    file: 'apps/portal/app/globals.css',
    change: "the select beside a file can no longer show its chosen item; the check must report it clipped at 375",
    test: audit(['webkit-375']),
    // In the phone rule itself: a squeeze in the base rule is overridden below 768 by this flex-basis:
    // 100% (the first run of this item, 2026-10-01, did not go red for that reason).
    apply: swap(['  .doc-match select { flex-basis: 100%; }', '  .doc-match select { flex: 0 0 64px; }']),
    before: clear,
    evidence: found('portal-documents', 'clipped'),
    expectRed: TITLE,
  },
];
