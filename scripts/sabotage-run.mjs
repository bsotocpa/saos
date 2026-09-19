#!/usr/bin/env node
/*
 * SABOTAGE RUNNER WITH A LOG (Brian, 2026-09-19, report item 7).
 *
 * A sabotage is one guard broken on purpose, its test run and expected red, the file restored
 * byte for byte, the test run again and expected green. Until now each batch ran from a scratch
 * script whose output lived only in the session; the reconciliation table then had to be composed,
 * which the standing rule forbids ("a table in a report is read from the log"). This runner takes
 * a manifest and appends one row per item to tasks/sabotage/<date>.log, so the table is read.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-19-walk.mjs [--only <item substring>]
 *
 * A manifest exports `items`: [{ item, file, change, apply(text) -> text, test: { kind: 'api'|'harness'|'guard', spec },
 * expectRed: RegExp on failed test names (api) or /x\s+\d+/ style (harness) }]. An item with
 * `none: 'why'` and no apply is logged as having no sabotage, with the reason, and never fails the run.
 * Log row: date | item | file | change | test | on the harness | red | restored green
 */
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const manifestPath = process.argv[2];
if (!manifestPath) { console.error('usage: sabotage-run.mjs <manifest.mjs> [--only <substring>]'); process.exit(2); }
const onlyIx = process.argv.indexOf('--only');
const only = onlyIx > 0 ? process.argv[onlyIx + 1] : null;
const { items, date } = await import(pathToFileURL(resolve(root, manifestPath)).href);
const logDir = resolve(root, 'tasks', 'sabotage');
mkdirSync(logDir, { recursive: true });
const logFile = resolve(logDir, `${date}.log`);
if (!existsSync(logFile)) writeFileSync(logFile, 'date | item | file | change | test | on the harness | red | restored green\n');

function runApi(spec) {
  const r = spawnSync('node', ['--test', '--test-timeout=300000', '--test-force-exit', spec], { cwd: resolve(root, 'apps', 'api'), encoding: 'utf8', shell: true });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const failed = [...out.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1]).filter((n) => !n.startsWith('C:'));
  return { pass: /ℹ pass (\d+)/.exec(out)?.[1] ?? '?', fail: /ℹ fail (\d+)/.exec(out)?.[1] ?? '?', failed: [...new Set(failed)] };
}
function runHarness(spec) {
  let out = '';
  // The harness boots two Next apps and the API on fixed ports; a run that starts before the previous
  // one's servers have let go prints no result line at all. One retry after a pause, then the truth.
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = spawnSync('npx', ['playwright', 'test', spec], { cwd: resolve(root, 'apps', 'e2e'), encoding: 'utf8', shell: true });
    out = (r.stdout ?? '') + (r.stderr ?? '');
    if (/\d+ (passed|failed)/.test(out)) break;
    spawnSync('node', ['-e', 'setTimeout(() => {}, 15000)'], { shell: true });
  }
  const failed = [...out.matchAll(/^\s+(?:x|✘)\s+\d+\s+\[(\w+)\][^\n]*›\s*([^\n]+)/gm)].map((m) => `${m[2].trim()} [${m[1]}]`);
  return { pass: /(\d+) passed/.exec(out)?.[1] ?? '0', fail: /(\d+) failed/.exec(out)?.[1] ?? '0', failed: [...new Set(failed)] };
}
/** A build guard: an npm script that must exit non-zero once the guarded shape is back in the tree. */
function runGuard(script) {
  const r = spawnSync('npm', ['run', '-s', script], { cwd: root, encoding: 'utf8', shell: true });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const failed = [...out.matchAll(/^RED\s+(.+)$/gm)].map((m) => m[1].trim());
  return { pass: r.status === 0 ? '1' : '0', fail: r.status === 0 ? '0' : String(Math.max(1, failed.length)), failed };
}
const run = (t) => (t.kind === 'harness' ? runHarness(t.spec) : t.kind === 'guard' ? runGuard(t.spec) : runApi(t.spec));
const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
const log = (cols) => { const line = [date, ...cols].map(cell).join(' | '); appendFileSync(logFile, line + '\n'); console.log(line); };

let failedRun = false;
for (const s of items) {
  if (only && !s.item.includes(only)) continue;
  if (s.none) { log([s.item, s.file ?? '', 'no sabotage: ' + s.none, s.test ? `${s.test.kind}: ${s.test.spec}` : '', s.test?.kind === 'harness' ? 'yes' : 'no', 'n/a', 'n/a']); continue; }
  const f = resolve(root, s.file);
  const original = readFileSync(f, 'utf8');
  let red;
  try { writeFileSync(f, s.apply(original)); red = run(s.test); } finally { writeFileSync(f, original); }
  const hit = red.failed.some((n) => s.expectRed.test(n)) || (s.test.kind === 'harness' && red.fail !== '0' && s.expectRed.test(red.failed.join('\n')));
  const green = run(s.test);
  const restored = readFileSync(f, 'utf8') === original;
  log([s.item, s.file, s.change, `${s.test.kind}: ${s.test.spec}`, s.test.kind === 'harness' ? 'yes' : 'no',
    hit ? `RED as expected (${red.fail} failed: ${red.failed.slice(0, 3).join('; ')})` : `NOT RED (${red.fail} failed: ${red.failed.slice(0, 3).join('; ')})`,
    restored && green.fail === '0' ? `green (${green.pass} passed)` : `NOT GREEN (${green.fail} failed${restored ? '' : '; file not byte-identical'})`]);
  if (!hit || green.fail !== '0' || !restored) failedRun = true;
}
process.exit(failedRun ? 1 : 0);
