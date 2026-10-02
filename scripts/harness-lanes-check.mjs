#!/usr/bin/env node
/*
 * THE LANES, PROVED (Brian, 2026-10-02, R115). Runs one walk (the R117 walk) in chromium-375 and
 * webkit-375 through apps/e2e/run-harness.mjs twice and reads the summary each run writes:
 *
 *   parallel   memory floor 0: two lanes, chromium-375 in lane 0 and webkit-375 in lane 1, running at
 *              the same time (each starts before the other ends), both green, no fallback;
 *   fallback   a memory floor no machine meets: the runner falls back to one lane, stops lane 1's
 *              project, runs it again in lane 0, and both end green; the summary says it fell back.
 *
 *   node scripts/harness-lanes-check.mjs        (npm run check:harness-lanes; not in the root suite:
 *                                                it boots the harness four times)
 * A failed expectation prints RED and exits 1.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const e2e = resolve(root, 'apps', 'e2e');
const problems = [];

function run(label, floorGb) {
  const r = spawnSync('node', ['run-harness.mjs', 'tests/batch16-withdrawals.spec.ts', 'chromium-375', 'webkit-375'], {
    cwd: e2e, encoding: 'utf8', shell: true, env: { ...process.env, E2E_MEMORY_FLOOR_GB: String(floorGb) },
  });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const summary = JSON.parse(readFileSync(resolve(e2e, '.artifacts', 'harness-summary.json'), 'utf8'));
  console.log(`${label}: exit ${r.status}; ${out.match(/^harness: memory.*$/m)?.[0] ?? 'no memory line'}`);
  return { status: r.status, summary, out };
}

const par = run('parallel', 0);
const [c, w] = ['chromium-375', 'webkit-375'].map((p) => par.summary.projects.find((x) => x.project === p));
if (par.status !== 0) problems.push(`parallel: the run exited ${par.status}`);
if (par.summary.lanes !== 2) problems.push(`parallel: ${par.summary.lanes} lane(s), not 2`);
if (par.summary.fellBack) problems.push('parallel: fell back with a floor of 0');
if (!c || c.lane !== 0 || c.status !== 0) problems.push('parallel: chromium-375 did not pass in lane 0');
if (!w || w.lane !== 1 || w.status !== 0) problems.push('parallel: webkit-375 did not pass in lane 1');
if (c && w && !(c.startedAt < w.startedAt + w.seconds && w.startedAt < c.startedAt + c.seconds)) problems.push('parallel: the two lanes did not overlap in time');

const fb = run('fallback', 1000);
const wf = fb.summary.projects.find((x) => x.project === 'webkit-375');
if (fb.status !== 0) problems.push(`fallback: the run exited ${fb.status}`);
if (!fb.summary.fellBack) problems.push('fallback: the runner did not fall back under a floor no machine meets');
if (!/FELL BACK TO ONE LANE/.test(fb.out)) problems.push('fallback: the summary does not say it fell back');
if (!wf || wf.lane !== 0 || wf.status !== 0) problems.push('fallback: webkit-375 did not run again, green, in lane 0');

for (const p of problems) console.error(`RED ${p}`);
if (problems.length) process.exit(1);
console.log(`harness-lanes-check: green — parallel (lanes overlapped; chromium ${c.seconds}s from ${c.startedAt}s, webkit ${w.seconds}s from ${w.startedAt}s) and fallback (webkit-375 run again in lane 0).`);
