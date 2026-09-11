/*
 * Boots the two real things the harness walks: the API on a fresh test database (apps/api/
 * scripts/e2e-boot.ts, which prints E2E_READY {…} once its fixtures exist) and the Ops app in
 * dev mode pointed at it. Writes the fixture handles to .artifacts/fixtures.json for the spec,
 * and the pids to .artifacts/pids.json for the teardown.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const artifacts = resolve(here, '.artifacts');
const API_PORT = 3101;
const OPS_PORT = 3105;
const PORTAL_PORT = 3106;

function waitForLine(child: ChildProcess, prefix: string, timeoutMs: number): Promise<string> {
  return new Promise((resolveLine, reject) => {
    const timer = setTimeout(() => reject(new Error(`${prefix} did not appear within ${timeoutMs / 1000}s`)), timeoutMs);
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith(prefix)) { clearTimeout(timer); resolveLine(line.slice(prefix.length)); }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', (c: Buffer) => process.stderr.write(`[api] ${c.toString()}`));
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`the process exited with ${code} before ${prefix}`)); });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(10_000) }); if (r.status < 500) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${url} did not answer within ${timeoutMs / 1000}s`);
}

// Next dev rewrites next-env.d.ts and tsconfig.json to reference its distDir — here a path on
// this machine, which must never reach the repo. The setup snapshots both; the teardown (and a
// failed setup) puts them back byte for byte.
export const NEXT_TOUCHED_FILES = ['next-env.d.ts', 'tsconfig.json'];

/**
 * Puts those two files back exactly as they were. `prefix` picks which app's snapshot to use:
 * Ops stores its copies under the bare filename, the portal under `portal/<filename>`, because
 * both apps have files of the same name and both get rewritten.
 */
export function restoreNextFiles(artifactsDir: string, appDir: string, prefix = ''): void {
  const snapshot = resolve(artifactsDir, 'next-files.json');
  if (!existsSync(snapshot)) return;
  const files = JSON.parse(readFileSync(snapshot, 'utf8')) as Record<string, string>;
  for (const [name, content] of Object.entries(files)) {
    if (!name.startsWith(prefix)) continue;
    const bare = name.slice(prefix.length);
    if (prefix === '' && bare.includes('/')) continue; // a prefixed entry, not Ops's own
    writeFileSync(resolve(appDir, bare), content);
  }
}


/*
 * THE HARNESS WALKS WHAT PRODUCTION SERVES (2026-09-10, Brian's ruling after the phone walk).
 *
 * It used to run `next dev`. Dev and production are different artifacts: dev compiles per
 * request with no minification, no chunk splitting and React in development mode. A guard that
 * green-lights an artifact nobody ships is not a guard — the phone found a dead Withdraw button
 * on production while page one was green five runs out of five.
 *
 * So: `next build`, then `next start`. Slower by a minute; it is the only version that means
 * anything. Build output goes outside the repo for the same Dropbox reason as before.
 */
async function buildAndStart(
  label: string,
  appDir: string,
  distDir: string,
  port: number,
  nextBin: string,
  apiPort: number
): Promise<ChildProcess> {
  const distRel = relative(appDir, distDir);
  const env = { ...process.env, API_URL: `http://localhost:${apiPort}`, NEXT_DIST_DIR: distRel };

  await new Promise<void>((done, fail) => {
    const build = spawn(process.execPath, [nextBin, 'build'], {
      cwd: appDir,
      env: { ...env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const keep = (c: Buffer) => {
      tail = (tail + c.toString()).slice(-4000);
      if (process.env.E2E_VERBOSE) process.stderr.write(`[${label} build] ${c.toString()}`);
    };
    build.stdout?.on('data', keep);
    build.stderr?.on('data', keep);
    build.on('exit', (code) => (code === 0 ? done() : fail(new Error(`${label} failed to build (${code}):\n${tail}`))));
  });

  const server = spawn(process.execPath, [nextBin, 'start', '-p', String(port)], {
    cwd: appDir,
    env: { ...env, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (c: Buffer) => { if (process.env.E2E_VERBOSE) process.stderr.write(`[${label}] ${c.toString()}`); });
  server.stderr?.on('data', (c: Buffer) => process.stderr.write(`[${label}] ${c.toString()}`));
  return server;
}

export default async function globalSetup(): Promise<void> {
  mkdirSync(artifacts, { recursive: true });

  const api = spawn(process.execPath, ['scripts/e2e-boot.ts'], {
    cwd: resolve(root, 'apps', 'api'),
    env: { ...process.env, E2E_API_PORT: String(API_PORT), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = JSON.parse(await waitForLine(api, 'E2E_READY ', 120_000));

  // Next rewrites its manifests on every compile. Inside a synced folder (Dropbox) on Windows
  // the sync client locks them mid-write (errno -4094, roughly one run in three), so the harness
  // builds OUTSIDE the repo — LocalAppData on Windows, the temp dir elsewhere — with a junction
  // to the repo's node_modules beside the build, which is how the compiled chunks find Next at
  // runtime. The developer's .next is never touched.
  const opsDir = resolve(root, 'apps', 'internal');
  const e2eHome = resolve(process.platform === 'win32' ? (process.env.LOCALAPPDATA ?? tmpdir()) : tmpdir(), 'saos-e2e');
  const distDir = resolve(e2eHome, 'next');
  mkdirSync(distDir, { recursive: true });
  const modulesLink = resolve(e2eHome, 'node_modules');
  if (!existsSync(modulesLink)) symlinkSync(resolve(root, 'node_modules'), modulesLink, 'junction');
  // Next joins distDir onto the project directory, so it is handed the relative path.
  const distRel = relative(opsDir, distDir);
  const snapshot: Record<string, string> = {};
  for (const name of NEXT_TOUCHED_FILES) snapshot[name] = readFileSync(resolve(opsDir, name), 'utf8');
  writeFileSync(resolve(artifacts, 'next-files.json'), JSON.stringify(snapshot));

  const nextBin = resolve(root, 'node_modules', 'next', 'dist', 'bin', 'next');
  void distRel;
  const ops = await buildAndStart('ops', opsDir, distDir, OPS_PORT, nextBin, API_PORT);
  const opsExited = new Promise<never>((_, reject) => ops.on('exit', (code) => reject(new Error(`the Ops dev server exited with ${code} before answering`))));
  try {
    await Promise.race([waitForHttp(`http://localhost:${OPS_PORT}/login`, 240_000), opsExited]);
  } catch (err) {
    restoreNextFiles(artifacts, opsDir);
    ops.kill(); api.kill();
    throw err;
  }

  // PAGE TWO (2026-09-10): the portal, on its own port and its own build directory, so the two
  // dev servers never share a manifest.
  const portalDir = resolve(root, 'apps', 'portal');
  const portalDist = resolve(e2eHome, 'next-portal');
  mkdirSync(portalDist, { recursive: true });
  for (const name of NEXT_TOUCHED_FILES) snapshot[`portal/${name}`] = readFileSync(resolve(portalDir, name), 'utf8');
  writeFileSync(resolve(artifacts, 'next-files.json'), JSON.stringify(snapshot));

  const portal = await buildAndStart('portal', portalDir, portalDist, PORTAL_PORT, nextBin, API_PORT);
  const portalExited = new Promise<never>((_, reject) => portal.on('exit', (code) => reject(new Error(`the portal dev server exited with ${code} before answering`))));
  try {
    await Promise.race([waitForHttp(`http://localhost:${PORTAL_PORT}/login`, 240_000), portalExited]);
  } catch (err) {
    restoreNextFiles(artifacts, opsDir);
    restoreNextFiles(artifacts, portalDir, 'portal/');
    portal.kill(); ops.kill(); api.kill();
    throw err;
  }

  writeFileSync(resolve(artifacts, 'fixtures.json'), JSON.stringify({ ...ready, opsPort: OPS_PORT, portalPort: PORTAL_PORT }, null, 2));
  writeFileSync(resolve(artifacts, 'pids.json'), JSON.stringify({ api: api.pid, ops: ops.pid, portal: portal.pid }));
}
