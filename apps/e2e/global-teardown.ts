// Stops the API and the Ops dev server the setup started. The pids live in .artifacts/pids.json.
import { execSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_RETRY_LOG, LANE_PORTS, artifacts, restoreNextFiles } from './global-setup.ts';
import { MAX_CONNECT_RETRIES_PER_SUITE } from '../api/test/connect-retry.ts';

const here = dirname(fileURLToPath(import.meta.url));
// R115: each lane's own artifacts folder and ports (global-setup.ts).
const pidsFile = resolve(artifacts, 'pids.json');

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
      await waitForPorts(LANE_PORTS, 15_000);
    }
  } finally {
    try {
      // Under run-harness.mjs the runner restores Next's files once, after every lane (R115).
      if (process.env.E2E_NEXT_FILES_BY_RUNNER !== '1') {
        restoreNextFiles(resolve(here, '.artifacts'), resolve(here, '..', 'internal'));
        restoreNextFiles(resolve(here, '.artifacts'), resolve(here, '..', 'portal'), 'portal/');
      }
    } catch (err) {
      restoreError = err;
    }
  }
  if (restoreError) throw restoreError;
  // The bounded connect retry (Brian, 2026-09-29): the harness API's count, under the suite's limit.
  const lines = existsSync(HARNESS_RETRY_LOG) ? readFileSync(HARNESS_RETRY_LOG, 'utf8').split('\n').filter(Boolean) : [];
  const byKind: Record<string, number> = {};
  for (const l of lines) { const k = l.split(' ').slice(1).join(' '); byKind[k] = (byKind[k] ?? 0) + 1; }
  const detail = Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(', ');
  console.log(`harness: ${lines.length} connect retr${lines.length === 1 ? 'y' : 'ies'} this run${detail ? ` (${detail})` : ''}; the limit is ${MAX_CONNECT_RETRIES_PER_SUITE}.`);
  if (lines.length > MAX_CONNECT_RETRIES_PER_SUITE) {
    throw new Error(`harness: RED. ${lines.length} connect retries is over the limit of ${MAX_CONNECT_RETRIES_PER_SUITE}; the relay needs a look before the next receipt.`);
  }
}
