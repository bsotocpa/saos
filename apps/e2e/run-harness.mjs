#!/usr/bin/env node
/*
 * THE HARNESS, SIX TIMES (Brian, 2026-09-30, R106): every walk and the layout audit at 375, 768 and
 * 1440 in Chromium and WebKit. Each project is its own Playwright run against its own fresh harness
 * (global-setup boots a new API and test database), so a walk that consumes its fixture state finds it
 * whole in every project. Every project runs even after one fails (a red is read whole, R7). The six
 * JSON reports are merged into .artifacts/last-run.json for the walk-evidence scripts, and each
 * project's wall time is printed, with the total.
 *
 * TWO LANES AT ONCE (Brian, 2026-10-02, R115). The Chromium projects run in lane 0 and the WebKit
 * projects in lane 1, at the same time, each lane with its own ports, test database, Next build
 * folders and artifacts (E2E_LANE; global-setup.ts). Within a lane the first project builds and the
 * rest start that build (E2E_REUSE_BUILD=1). Every walk still runs at 375, 768 and 1440 in both
 * browsers; only the order in time changes.
 *   Memory: free memory is sampled every 2 s; the peak in use and the lowest free are printed. If free
 *   memory falls below 2 GB while both lanes run, the runner falls back to one lane for this run: lane
 *   1's current project is stopped (its servers with it) and it and the rest of lane 1 run in lane 0
 *   afterwards, from the start. The summary says so. E2E_LANES=1 runs one lane from the start.
 *   Next's two rewritten files (tsconfig.json, next-env.d.ts in each app) are snapshotted once before
 *   any lane starts and restored once after the last (E2E_NEXT_FILES_BY_RUNNER=1); a lane's build
 *   waits for the other's (global-setup.ts, the build lock).
 *
 *   node run-harness.mjs                 all six
 *   node run-harness.mjs webkit-375 ...  just those
 *   node run-harness.mjs tests/x.spec.ts webkit-375 chromium-1440   those walks, in those projects
 */
import { execSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { freemem, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECTS = ['chromium-375', 'chromium-768', 'chromium-1440', 'webkit-375', 'webkit-768', 'webkit-1440'];
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const artifactsRoot = resolve(here, '.artifacts');
mkdirSync(artifactsRoot, { recursive: true });
const args = process.argv.slice(2);
const chosen = args.filter((a) => !a.startsWith('-') && !a.endsWith('.ts'));
// Spec files (…/x.spec.ts) narrow every project's run to those walks: a sabotage, or a rerun of a few.
const extra = [...args.filter((a) => a.endsWith('.ts')), ...args.filter((a) => a.startsWith('-'))];
const projects = chosen.length ? chosen : PROJECTS;

const GB = 1024 ** 3;
// R115's floor is 2 GB. E2E_MEMORY_FLOOR_GB exists for scripts/harness-lanes-check.mjs alone, which
// proves both paths on one walk: 0 (never falls back) and a floor no machine meets (falls back at once).
const FLOOR = (process.env.E2E_MEMORY_FLOOR_GB !== undefined ? Number(process.env.E2E_MEMORY_FLOOR_GB) : 2) * GB;
const laneArtifacts = (lane) => (lane ? `.artifacts/lane-${lane}` : '.artifacts');
const lanePorts = (lane) => [3101, 3105, 3106].map((p) => p + lane * 10);

// The queues: Chromium in lane 0, WebKit in lane 1; one browser alone, or E2E_LANES=1, is one lane.
const oneLane = process.env.E2E_LANES === '1';
const queues = [[], []];
for (const p of projects) queues[!oneLane && p.startsWith('webkit') ? 1 : 0].push(p);
if (!queues[0].length) { queues[0] = queues[1]; queues[1] = []; }
const lanesUsed = queues[1].length ? 2 : 1;

// Next's rewritten files, as they are before any lane builds.
const NEXT_FILES = ['next-env.d.ts', 'tsconfig.json'];
const appDirs = [resolve(root, 'apps', 'internal'), resolve(root, 'apps', 'portal')];
const nextSnapshot = appDirs.flatMap((d) => NEXT_FILES.map((f) => [resolve(d, f), readFileSync(resolve(d, f), 'utf8')]));
function restoreNextFiles() {
  for (const [path, content] of nextSnapshot) {
    if (readFileSync(path, 'utf8') === content) continue;
    for (let attempt = 1; ; attempt++) {
      try { writeFileSync(path, content); break; } catch (e) {
        if (attempt > 4 || !['UNKNOWN', 'EBUSY', 'EPERM'].includes(e.code)) throw e;
        console.warn(`harness: ${path} refused (${e.code}); retry ${attempt} of 4`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      }
    }
  }
}

// Memory, sampled through the whole run.
const total = totalmem();
let lowestFree = freemem();
let fellBack = null;
const running = new Map(); // lane -> { project, child }
const moved = [];
const sampler = setInterval(() => {
  const free = freemem();
  if (free < lowestFree) lowestFree = free;
  if (free < FLOOR && !fellBack && running.has(0) && running.has(1)) fallBack(free);
}, 2000);

function fallBack(free) {
  const current = running.get(1);
  fellBack = { at: Math.round((Date.now() - started) / 1000), free, project: current.project };
  console.log(`\nharness: free memory ${(free / GB).toFixed(2)} GB is under ${(FLOOR / GB).toFixed(0)} GB with two lanes running; falling back to one lane. ` +
    `${current.project} is stopped and runs again in lane 0 with the rest of lane 1.`);
  current.stopped = true;
  try {
    if (process.platform === 'win32') execSync(`taskkill /PID ${current.child.pid} /T /F`, { stdio: 'ignore' });
    else process.kill(-current.child.pid, 'SIGKILL');
  } catch { /* already gone */ }
  moved.push(current.project, ...queues[1].splice(0));
}

function portFree(port) {
  return new Promise((done) => {
    const s = createServer();
    s.once('error', () => done(false));
    s.listen(port, () => s.close(() => done(true)));
  });
}
async function waitForPorts(ports, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await Promise.all(ports.map(portFree))).every(Boolean)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Forward a child's output a whole line at a time, so two lanes never split a line between them. */
function forward(stream, out) {
  let buf = '';
  stream.on('data', (c) => {
    buf += c.toString();
    const cut = buf.lastIndexOf('\n');
    if (cut < 0) return;
    out.write(buf.slice(0, cut + 1));
    buf = buf.slice(cut + 1);
  });
  stream.on('end', () => { if (buf) out.write(buf + '\n'); });
}

const results = new Map(); // project -> result (a project run again replaces its stopped run)
const started = Date.now();
function runProject(lane, project, first) {
  const runFile = resolve(artifactsRoot, `run-${project}.json`);
  const t0 = Date.now();
  return new Promise((done) => {
    const child = spawn('npx', ['playwright', 'test', ...extra, '--project', project], {
      cwd: here, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, E2E_LANE: String(lane), E2E_ARTIFACTS: laneArtifacts(lane), E2E_RUN_FILE: runFile,
        E2E_REUSE_BUILD: first ? '0' : '1', E2E_NEXT_FILES_BY_RUNNER: '1',
      },
    });
    const entry = { project, child, stopped: false };
    running.set(lane, entry);
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
    child.on('exit', (code) => {
      running.delete(lane);
      const result = { project, lane, status: code ?? 1, startedAt: Math.round((t0 - started) / 1000), seconds: Math.round((Date.now() - t0) / 1000), runFile, stopped: entry.stopped };
      if (!entry.stopped) results.set(project, result);
      done(result);
    });
  });
}

async function runLane(lane) {
  let first = true;
  while (queues[lane].length) {
    const project = queues[lane].shift();
    const r = await runProject(lane, project, first);
    first = false;
    if (r.stopped) { await waitForPorts(lanePorts(lane), 20_000); return; }
  }
}

console.log(`harness: ${lanesUsed} lane${lanesUsed === 1 ? '' : 's'} — lane 0: ${queues[0].join(', ')}${lanesUsed === 2 ? `; lane 1: ${queues[1].join(', ')}` : ''}.`);
try {
  await Promise.all([runLane(0), lanesUsed === 2 ? runLane(1) : Promise.resolve()]);
  // The fallback: lane 1's stopped project and the rest of lane 1, in lane 0, after lane 0's own.
  if (moved.length) {
    queues[0].push(...moved.splice(0));
    let first = false;
    while (queues[0].length) { await runProject(0, queues[0].shift(), first); first = false; }
  }
} finally {
  clearInterval(sampler);
  restoreNextFiles();
}

// One report for the evidence scripts: every project's suites, the stats summed.
const ordered = projects.map((p) => results.get(p)).filter(Boolean);
const merged = { config: null, suites: [], errors: [], stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0, duration: 0 } };
for (const r of ordered) {
  if (!existsSync(r.runFile)) continue;
  const j = JSON.parse(readFileSync(r.runFile, 'utf8'));
  merged.config ??= j.config;
  merged.suites.push(...(j.suites ?? []));
  merged.errors.push(...(j.errors ?? []));
  for (const k of Object.keys(merged.stats)) merged.stats[k] += j.stats?.[k] ?? 0;
}
writeFileSync(resolve(artifactsRoot, 'last-run.json'), JSON.stringify(merged));
// The layout audit's logs, one per lane, into the one the tables read.
for (const f of ['layout-failures.jsonl', 'layout-pages.jsonl']) {
  const laneLog = resolve(artifactsRoot, 'lane-1', f);
  if (existsSync(laneLog)) { appendFileSync(resolve(artifactsRoot, f), readFileSync(laneLog, 'utf8')); rmSync(laneLog); }
}

const wall = Math.round((Date.now() - started) / 1000);
const mmss = (s) => `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
const peakUsed = total - lowestFree;
const memory = { totalGb: +(total / GB).toFixed(2), peakInUseGb: +(peakUsed / GB).toFixed(2), lowestFreeGb: +(lowestFree / GB).toFixed(2) };
console.log('\nharness by project:');
for (const r of ordered) console.log(`  ${r.project.padEnd(14)} ${r.status === 0 ? 'green' : 'RED  '} ${mmss(r.seconds)}  (lane ${r.lane})`);
console.log(`harness: memory — peak in use ${memory.peakInUseGb} GB of ${memory.totalGb} GB, lowest free ${memory.lowestFreeGb} GB (sampled every 2 s).`);
if (fellBack) console.log(`harness: FELL BACK TO ONE LANE at ${mmss(fellBack.at)}: free memory ${(fellBack.free / GB).toFixed(2)} GB, under ${(FLOOR / GB).toFixed(0)} GB; ${fellBack.project} was stopped and run again in lane 0.`);
else console.log(`harness: ${lanesUsed} lane${lanesUsed === 1 ? '' : 's'} throughout${lanesUsed === 2 ? `; free memory never under ${(FLOOR / GB).toFixed(0)} GB` : ''}.`);
const green = ordered.filter((r) => r.status === 0).length;
console.log(`harness: ${green}/${projects.length} projects green; wall ${mmss(wall)} (passed ${merged.stats.expected}, failed ${merged.stats.unexpected}, flaky ${merged.stats.flaky}, skipped ${merged.stats.skipped}).`);
writeFileSync(resolve(artifactsRoot, 'harness-summary.json'), JSON.stringify({
  lanes: lanesUsed, floorGb: FLOOR / GB, fellBack, wallSeconds: wall, memory, projects: ordered.map(({ runFile, ...r }) => r),
}, null, 2));
process.exit(ordered.length === projects.length && ordered.every((r) => r.status === 0) ? 0 : 1);
