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
    s.listen(port, '127.0.0.1', () => s.close(() => done(true)));
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
  restoreNextFiles(resolve(here, '.artifacts'), resolve(here, '..', 'internal'));
  if (!existsSync(pidsFile)) return;
  const pids = JSON.parse(readFileSync(pidsFile, 'utf8')) as { api?: number; ops?: number };
  kill(pids.ops);
  kill(pids.api);
  unlinkSync(pidsFile);
  await waitForPorts([3101, 3105], 15_000);
}
