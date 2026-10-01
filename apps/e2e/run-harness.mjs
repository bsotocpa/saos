#!/usr/bin/env node
/*
 * THE HARNESS, SIX TIMES (Brian, 2026-09-30, R106): every walk and the layout audit at 375, 768 and
 * 1440 in Chromium and WebKit. Each project is its own Playwright run against its own fresh harness
 * (global-setup boots a new API and test database), so a walk that consumes its fixture state finds it
 * whole in every project. The first run builds the two Next apps; the others reuse that build
 * (E2E_REUSE_BUILD=1, one tree per receipt). Every project runs even after one fails (a red is read
 * whole, R7). The six JSON reports are merged into .artifacts/last-run.json for the walk-evidence
 * scripts, and each project's wall time is printed, with the total.
 *
 *   node run-harness.mjs                 all six
 *   node run-harness.mjs webkit-375 ...  just those
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECTS = ['chromium-375', 'chromium-768', 'chromium-1440', 'webkit-375', 'webkit-768', 'webkit-1440'];
const here = dirname(fileURLToPath(import.meta.url));
const chosen = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const extra = process.argv.slice(2).filter((a) => a.startsWith('-'));
const projects = chosen.length ? chosen : PROJECTS;
const results = [];
const started = Date.now();
for (const [i, project] of projects.entries()) {
  const runFile = resolve(here, '.artifacts', `run-${project}.json`);
  const t0 = Date.now();
  const r = spawnSync('npx', ['playwright', 'test', '--project', project, ...extra], {
    cwd: here, stdio: 'inherit', shell: true,
    env: { ...process.env, E2E_RUN_FILE: runFile, E2E_REUSE_BUILD: i === 0 ? '0' : '1' },
  });
  results.push({ project, status: r.status ?? 1, seconds: Math.round((Date.now() - t0) / 1000), runFile });
}

// One report for the evidence scripts: every project's suites, the stats summed.
const merged = { config: null, suites: [], errors: [], stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0, duration: 0 } };
for (const r of results) {
  if (!existsSync(r.runFile)) continue;
  const j = JSON.parse(readFileSync(r.runFile, 'utf8'));
  merged.config ??= j.config;
  merged.suites.push(...(j.suites ?? []));
  merged.errors.push(...(j.errors ?? []));
  for (const k of Object.keys(merged.stats)) merged.stats[k] += j.stats?.[k] ?? 0;
}
writeFileSync(resolve(here, '.artifacts', 'last-run.json'), JSON.stringify(merged));

const total = Math.round((Date.now() - started) / 1000);
const mmss = (s) => `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
console.log('\nharness by project:');
for (const r of results) console.log(`  ${r.project.padEnd(14)} ${r.status === 0 ? 'green' : 'RED  '} ${mmss(r.seconds)}`);
console.log(`harness: ${results.filter((r) => r.status === 0).length}/${results.length} projects green; wall ${mmss(total)} (passed ${merged.stats.expected}, failed ${merged.stats.unexpected}, flaky ${merged.stats.flaky}, skipped ${merged.stats.skipped}).`);
process.exit(results.every((r) => r.status === 0) ? 0 : 1);
