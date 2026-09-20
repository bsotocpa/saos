// Stops the API and the Ops dev server the setup started. The pids live in .artifacts/pids.json.
import { execSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { restoreNextFiles } from './global-setup.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pidsFile = resolve(here, '.artifacts', 'pids.json');

function kill(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    else process.kill(-pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

// A killed process releases its port a moment later; the next run must not race it.
function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createServer();
    s.once('error', () => done(false));
    // Next binds every interface; a port is free only when both loopbacks answer.
    s.listen(port, () => s.close(() => done(true)));
  });
}

async function waitForPorts(ports: number[], timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const free = await Promise.all(ports.map(portFree));
    if (free.every(Boolean)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

export default async function globalTeardown(): Promise<void> {
  // The servers die first, whatever else fails: a restore that throws (Dropbox holding a file, seen
  // 2026-09-19) used to leave the three processes alive and the next run dead on EADDRINUSE.
  let restoreError: unknown = null;
  try {
    if (existsSync(pidsFile)) {
      const pids = JSON.parse(readFileSync(pidsFile, 'utf8')) as { api?: number; ops?: number; portal?: number };
      kill(pids.portal);
      kill(pids.ops);
      kill(pids.api);
      unlinkSync(pidsFile);
      await waitForPorts([3101, 3105, 3106], 15_000);
    }
  } finally {
    try {
      restoreNextFiles(resolve(here, '.artifacts'), resolve(here, '..', 'internal'));
      restoreNextFiles(resolve(here, '.artifacts'), resolve(here, '..', 'portal'), 'portal/');
    } catch (err) {
      restoreError = err;
    }
  }
  if (restoreError) throw restoreError;
}
