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

export function restoreNextFiles(artifactsDir: string, opsDir: string): void {
  const snapshot = resolve(artifactsDir, 'next-files.json');
  if (!existsSync(snapshot)) return;
  const files = JSON.parse(readFileSync(snapshot, 'utf8')) as Record<string, string>;
  for (const [name, content] of Object.entries(files)) writeFileSync(resolve(opsDir, name), content);
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
  const ops = spawn(process.execPath, [nextBin, 'dev', '-p', String(OPS_PORT)], {
    cwd: opsDir,
    env: { ...process.env, API_URL: `http://localhost:${API_PORT}`, NODE_ENV: 'development', NEXT_DIST_DIR: distRel },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ops.stdout?.on('data', (c: Buffer) => { if (process.env.E2E_VERBOSE) process.stderr.write(`[ops] ${c.toString()}`); });
  ops.stderr?.on('data', (c: Buffer) => process.stderr.write(`[ops] ${c.toString()}`));
  const opsExited = new Promise<never>((_, reject) => ops.on('exit', (code) => reject(new Error(`the Ops dev server exited with ${code} before answering`))));
  try {
    await Promise.race([waitForHttp(`http://localhost:${OPS_PORT}/login`, 240_000), opsExited]);
  } catch (err) {
    restoreNextFiles(artifacts, opsDir);
    ops.kill(); api.kill();
    throw err;
  }

  writeFileSync(resolve(artifacts, 'fixtures.json'), JSON.stringify({ ...ready, opsPort: OPS_PORT }, null, 2));
  writeFileSync(resolve(artifacts, 'pids.json'), JSON.stringify({ api: api.pid, ops: ops.pid }));
}
