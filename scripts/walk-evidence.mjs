#!/usr/bin/env node
/*
 * WALK EVIDENCE (Brian, 2026-09-19, report items 6 and 11).
 *
 * One row per live-walk step, from the harness's own run record: apps/e2e/walk-steps.json names
 * the steps; apps/e2e/.artifacts/last-run.json (Playwright's JSON reporter) carries, per test and
 * per project, the annotations a spec pushed while it ran. A spec clears a step by pushing
 *
 *   testInfo.annotations.push({ type: 'walk-step', description: 'A6|Documents page, input[type=file] + signedOn + PTIN select|tax_preparer, ceo|tap' })
 *
 * The columns: path | step | control (page + selector) | roles | test (file:line) | viewport |
 * last run | how. "how" is tap, api or fixture; only a passing tap clears a step. A step no spec
 * annotated prints one row with empty cells: not cleared. For scripts/report-table.mjs --from-log:
 *
 *   node scripts/walk-evidence.mjs A [--run <last-run.json copy>] > walk-a.log
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const which = process.argv[2] ?? 'A';
const manifest = JSON.parse(readFileSync(resolve(root, 'apps', 'e2e', 'walk-steps.json'), 'utf8'));
// --run <file>: a kept copy of a run record, for a run another run has since overwritten (2026-09-20).
const runIx = process.argv.indexOf('--run');
const runFile = runIx > 0 ? resolve(process.argv[runIx + 1]) : resolve(root, 'apps', 'e2e', '.artifacts', 'last-run.json');
const run = JSON.parse(readFileSync(runFile, 'utf8'));
const path = manifest.paths[which];
if (!path) { console.error(`no path ${which}`); process.exit(2); }

const found = new Map(); // step id -> rows
function visit(suite, file) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const status = test.results?.[test.results.length - 1]?.status ?? test.status;
      for (const a of test.annotations ?? []) {
        if (a.type !== 'walk-step') continue;
        const [id, control, roles, how] = String(a.description).split('|').map((s) => s.trim());
        if (!found.has(id)) found.set(id, []);
        found.get(id).push({ control, roles, test: `${file}:${spec.line}`, viewport: test.projectName, result: status, how: how ?? '' });
      }
    }
  }
  for (const s of suite.suites ?? []) visit(s, file);
}
for (const s of run.suites ?? []) visit(s, `apps/e2e/tests/${s.file}`);

const rows = [['step', 'what', 'device', 'control (page + selector)', 'roles', 'harness test', 'viewport', 'last run', 'how', 'cleared']];
for (const step of path.steps) {
  const hits = found.get(step.id) ?? [];
  if (hits.length === 0) { rows.push([step.id, step.text, step.device, '', '', '', '', '', '', 'NO']); continue; }
  for (const h of hits) {
    const cleared = h.how === 'tap' && h.result === 'passed' ? 'yes' : 'NO';
    rows.push([step.id, step.text, step.device, h.control, h.roles, h.test, h.viewport, h.result, h.how, cleared]);
  }
}
process.stdout.write(rows.map((r) => r.map((c) => String(c ?? '').replace(/\|/g, '/')).join(' | ')).join('\n') + '\n');
