#!/usr/bin/env node
/*
 * SPEC CITATIONS FOR A REPORT (Brian, 2026-09-19 evening, report item 7): for each named control,
 * the spec that proves it (file:line and the test's title) and how that test fared in a given run
 * log (the root suite's output, kept from the receipt run). A control with no matching spec prints
 * a row that says so: a door defect, not a citation.
 *
 *   node scripts/spec-citations.mjs <run.log> "refund-record control=refund row|refunded" "void control=void" ...
 *
 * Each argument after the log is "<control>=<regex over test titles>"; the first matching test per
 * spec file is cited (one row per file). Rows: control | spec | title | last run.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const [logPath, ...pairs] = process.argv.slice(2);
if (!logPath || pairs.length === 0) { console.error('usage: spec-citations.mjs <run.log> "<control>=<regex>" ...'); process.exit(2); }
const log = readFileSync(logPath, 'utf8');
const passed = new Set([...log.matchAll(/^✔ (.+?) \(\d/gm)].map((m) => m[1]));
const failed = new Set([...log.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]));
const harnessOk = new Set([...log.matchAll(/^\s+ok\s+\d+\s+\[(\w+)\][^\n]*›\s*([^\n]+?) \(\d/gm)].map((m) => `${m[2]} [${m[1]}]`));

const dirs = [resolve(root, 'apps', 'api', 'test'), resolve(root, 'apps', 'e2e', 'tests'), resolve(root, 'apps', 'internal', 'test')];
const specs = dirs.flatMap((d) => readdirSync(d).filter((f) => /\.spec\.ts$/.test(f)).map((f) => resolve(d, f)));
const rows = [['control', 'spec', 'test title', 'last run']];
for (const pair of pairs) {
  const eq = pair.indexOf('=');
  const control = pair.slice(0, eq); const re = new RegExp(pair.slice(eq + 1), 'i');
  let hits = 0;
  for (const f of specs) {
    const lines = readFileSync(f, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*test\((['"`])(.+?)\1/.exec(lines[i]);
      if (!m || !re.test(m[2])) continue;
      const title = m[2].replace(/\\'/g, "'");
      const rel = relative(root, f).replace(/\\/g, '/');
      const last = passed.has(title) ? 'passed' : failed.has(title) ? 'FAILED' : [...harnessOk].some((h) => h.startsWith(title)) ? 'passed (harness)' : 'not in this run';
      rows.push([control, `${rel}:${i + 1}`, title, last]);
      hits++;
      break;
    }
  }
  if (hits === 0) rows.push([control, '', 'no spec asserts it: door defect', '']);
}
process.stdout.write(rows.map((r) => r.map((c) => String(c).replace(/\|/g, '/')).join(' | ')).join('\n') + '\n');
