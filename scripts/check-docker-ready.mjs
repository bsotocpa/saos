#!/usr/bin/env node
/*
 * DOCKER ANSWERS BEFORE A RECEIPT STARTS (Brian, 2026-10-03, R120).
 *
 * On 2026-10-02 Docker Desktop was not running (it had stopped at start, after a Windows restart, on
 * socket entries it could not rename), and the first sign was every API test failing on ECONNREFUSED.
 * A receipt needs Docker's engine, the test database and the test object store; this check asks each of
 * them, first thing in the root `npm test`, and stops the receipt in seconds when one does not answer,
 * with a sentence naming the likely cause and the repair recorded in tasks/lessons.md.
 *
 * It only ASKS: `docker info`, `docker ps`, one Postgres SSLRequest, one MinIO health GET. It never
 * starts, stops, resets or removes anything, and never touches a volume. The repair is a person's.
 *
 *   node scripts/check-docker-ready.mjs      (npm run check:docker-ready; first in the root suite)
 *
 * The probes test themselves first (a port nothing listens on, an engine pipe that does not exist, a
 * local server that answers as Postgres does), so a probe that had gone blind cannot read green.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LESSON = 'tasks/lessons.md, "Docker Desktop will not start after a Windows restart"';

/** Where the tests connect: the repo-root .env the API's config loads (host and port only, never printed whole). */
function targets() {
  const env = { ...process.env };
  const file = resolve(root, '.env');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(DATABASE_URL|MINIO_ENDPOINT|MINIO_PORT)\s*=\s*([^#\s]+)/);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  let pg = { host: 'localhost', port: 5432 };
  try { const u = new URL(env.DATABASE_URL ?? ''); pg = { host: u.hostname || 'localhost', port: Number(u.port || 5432) }; } catch { /* the default */ }
  return { pg, minio: { host: env.MINIO_ENDPOINT || 'localhost', port: Number(env.MINIO_PORT || 9000) } };
}

/** `docker <args>` with a deadline; ok when it exits 0. Extra engine arguments let the self-test aim it at nothing. */
export function docker(args, engineArgs = []) {
  const r = spawnSync('docker', [...engineArgs, ...args], { encoding: 'utf8', timeout: 10_000 });
  const err = ((r.stderr ?? '') + (r.error ? ` ${r.error.message}` : '')).trim().split(/\r?\n/)[0] ?? '';
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: r.error?.code === 'ETIMEDOUT' ? 'no answer in 10 s' : err.slice(0, 160) };
}

/** Postgres answers an SSLRequest with one byte, S or N. A relay that accepts the socket and says nothing is not an answer. */
export function postgresAnswers(host, port, ms = 3000) {
  return new Promise((done) => {
    const s = connect({ host, port });
    const end = (ok, why) => { s.destroy(); done({ ok, why }); };
    s.setTimeout(ms, () => end(false, `no answer in ${ms / 1000} s`));
    s.once('error', (e) => end(false, e.code ?? e.message));
    s.once('connect', () => s.write(Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f])));
    s.once('data', (b) => end(b[0] === 0x53 || b[0] === 0x4e, `answered ${JSON.stringify(String.fromCharCode(b[0]))}`));
    s.once('close', () => done({ ok: false, why: 'the connection closed with no answer' }));
  });
}

/** MinIO's own liveness route answers 200. */
export async function minioAnswers(host, port, ms = 3000) {
  try {
    const r = await fetch(`http://${host}:${port}/minio/health/live`, { signal: AbortSignal.timeout(ms) });
    return { ok: r.status === 200, why: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, why: e.cause?.code ?? e.name ?? 'no answer' };
  }
}

/** The running container for one compose service of this project, by its labels (never by a guessed name). */
function serviceContainer(service) {
  const r = docker(['ps', '-a', '--filter', 'label=com.docker.compose.project=saos', '--filter', `label=com.docker.compose.service=${service}`, '--format', '{{.Names}}|{{.State}}|{{.Status}}']);
  const [name, state, status] = (r.out.split(/\r?\n/)[0] ?? '').split('|');
  return { name: name || null, running: state === 'running', status: status || 'no such container' };
}

async function selfTest() {
  const bad = [];
  // A port nothing listens on must read as not answering.
  const closed = await new Promise((done) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => done(p)); }); });
  if ((await postgresAnswers('127.0.0.1', closed, 1500)).ok) bad.push('a port nothing listens on read as Postgres answering');
  if ((await minioAnswers('127.0.0.1', closed, 1500)).ok) bad.push('a port nothing listens on read as MinIO answering');
  // A listener that accepts and says nothing (the relay with no database behind it) must read as not answering.
  const mute = createServer(() => undefined);
  await new Promise((r) => mute.listen(0, '127.0.0.1', r));
  if ((await postgresAnswers('127.0.0.1', mute.address().port, 1000)).ok) bad.push('a silent listener read as Postgres answering');
  mute.close();
  // A server that answers as Postgres does must read as answering.
  const pgLike = createServer((c) => c.once('data', () => c.end('N')));
  await new Promise((r) => pgLike.listen(0, '127.0.0.1', r));
  if (!(await postgresAnswers('127.0.0.1', pgLike.address().port, 1500)).ok) bad.push('a server answering as Postgres does read as not answering');
  pgLike.close();
  // An engine that is not there must read as not answering.
  if (docker(['info', '--format', '{{.ServerVersion}}'], ['-H', process.platform === 'win32' ? 'npipe:////./pipe/saos-no-such-engine' : 'unix:///nonexistent/saos-no-such-engine.sock']).ok) bad.push('an engine pipe that does not exist read as the engine answering');
  for (const b of bad) console.error(`RED check-docker-ready self-test: ${b}`);
  return bad.length === 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const started = Date.now();
  if (!(await selfTest())) process.exit(1);
  const problems = [];

  const engine = docker(['info', '--format', '{{.ServerVersion}}']);
  if (!engine.ok) {
    problems.push(
      `Docker's engine does not answer (${engine.err || 'docker info failed'}). Likely cause: Docker Desktop is not running, or it stopped while starting on socket entries ` +
      `left from before the last Windows restart ("The file cannot be accessed by the system" in its error window). Repair (${LESSON}): quit Docker Desktop, rename ` +
      `%LOCALAPPDATA%\\Docker\\run and %LOCALAPPDATA%\\docker-secrets-engine aside, start Docker Desktop and wait for the engine. Never "Reset to factory defaults": it erases the local database volumes.`
    );
  } else {
    const { pg, minio } = targets();
    const checks = [
      { service: 'postgres', what: 'the test database (Postgres)', at: pg, probe: () => postgresAnswers(pg.host, pg.port) },
      { service: 'minio', what: 'the test object store (MinIO)', at: minio, probe: () => minioAnswers(minio.host, minio.port) },
    ];
    for (const c of checks) {
      const box = serviceContainer(c.service);
      if (!box.running) {
        problems.push(
          `${c.what} is not running: compose service "${c.service}" reads "${box.status}". Likely cause: Docker Desktop started without the SAOS containers, or one was stopped. ` +
          `Repair: from the repo root, \`docker compose up -d postgres minio\` (it starts the containers on their existing volumes; it creates and removes nothing else), then run the receipt again.`
        );
        continue;
      }
      const a = await c.probe();
      if (!a.ok) {
        problems.push(
          `${c.what} does not answer on ${c.at.host}:${c.at.port} (${a.why}) though its container ${box.name} reads "${box.status}". Likely cause: it is still starting ` +
          `(wait for "healthy"), or the Docker Desktop relay is not passing the port. Repair: wait a minute and run the receipt again; if it still does not answer, quit and start Docker Desktop ` +
          `(tasks/lessons.md, "The Docker Desktop relay resets new connections under load"). No reset, no volume touched.`
        );
      }
    }
  }

  for (const p of problems) console.error(`RED ${p}`);
  if (problems.length) { console.error(`check-docker-ready: the receipt stops here, ${((Date.now() - started) / 1000).toFixed(1)} s in. Nothing was started, stopped or reset.`); process.exit(1); }
  console.log(`check-docker-ready: the engine (${engine.out}), the test database and the test object store answer (${((Date.now() - started) / 1000).toFixed(1)} s).`);
}
