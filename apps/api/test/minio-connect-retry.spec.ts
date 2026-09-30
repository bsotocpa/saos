// THE OBJECT-STORE CONNECT RETRY, BOUNDED (Brian, 2026-09-29, receipt run 47). Against a fake MinIO:
// a new connection that resets, or stays silent for 10 s, before MinIO answers is replaced by one fresh
// connection and counted; a request that already reached MinIO is never sent again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { installConnectRetry, retryLogPath } from './connect-retry.ts';
import { addMinioTarget } from './minio-connect-retry.ts';

// Its own log, so this spec's deliberate retries never count toward the suite's limit (the helpers are not imported here).
const TAG = `selftest-minio-${process.pid}`;
installConnectRetry(TAG);
const counted = () => readFileSync(retryLogPath(TAG), { encoding: 'utf8', flag: 'a+' }).split('\n').filter((l) => l.startsWith(`${process.pid} minio`)).length;

/** A fake MinIO: `onConnection` may take the Nth new connection (reset it, leave it silent); the rest are served over HTTP. */
async function fakeMinio(onConnection: (n: number, socket: Socket) => boolean, onGet?: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  let accepted = 0;
  const gets: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'HEAD' && req.url === '/minio/health/live') { res.writeHead(200); res.end(); return; }
    gets.push(`${req.method} ${req.url}`);
    if (onGet) { onGet(req, res); return; }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('synthetic object');
  });
  const sockets = new Set<Socket>();
  const tcp = createServer((socket) => {
    accepted++;
    sockets.add(socket);
    if (!onConnection(accepted, socket)) server.emit('connection', socket);
  });
  await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', () => r()));
  const port = (tcp.address() as AddressInfo).port;
  addMinioTarget('127.0.0.1', port);
  return { port, accepted: () => accepted, gets, close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); tcp.close(() => r()); }) };
}

const get = (port: number, path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c: string) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    res.on('error', reject);
  });
  req.on('error', reject);
});

test('a new MinIO connection reset before MinIO answers is replaced once, counted, and the request goes out once', async () => {
  const minio = await fakeMinio((n, socket) => { if (n === 1) { socket.resetAndDestroy(); return true; } return false; });
  const before = counted();
  const res = await get(minio.port, '/bucket/object');
  await minio.close();
  assert.equal(res.status, 200);
  assert.equal(res.body, 'synthetic object');
  assert.equal(minio.accepted(), 2, 'the reset connection and one fresh one');
  assert.deepEqual(minio.gets, ['GET /bucket/object'], 'the request reached MinIO exactly once');
  assert.equal(counted() - before, 1, 'the retry is counted for the suite summary');
});

test('two resets in a row surface the error: one retry, never two', async () => {
  const minio = await fakeMinio((_n, socket) => { socket.resetAndDestroy(); return true; });
  const before = counted();
  await assert.rejects(get(minio.port, '/bucket/object'), (e: { code?: string }) => e.code === 'ECONNRESET');
  await minio.close();
  assert.equal(minio.accepted(), 2);
  assert.deepEqual(minio.gets, []);
  assert.equal(counted() - before, 1);
});

test('a request that already reached MinIO is never sent again', async () => {
  const minio = await fakeMinio(() => false, (req) => { req.socket.resetAndDestroy(); });
  const before = counted();
  await assert.rejects(get(minio.port, '/bucket/object'), (e: { code?: string }) => e.code === 'ECONNRESET');
  await minio.close();
  assert.equal(minio.accepted(), 1, 'no fresh connection after MinIO answered');
  assert.deepEqual(minio.gets, ['GET /bucket/object'], 'sent once');
  assert.equal(counted() - before, 0, 'nothing to count: the connect phase had succeeded');
});

test('a new connection MinIO has not answered within 10 s is replaced once', async () => {
  // The first connection is accepted and then left silent: the relay's hang, not its reset.
  const minio = await fakeMinio((n) => n === 1);
  const before = counted();
  const started = Date.now();
  const res = await get(minio.port, '/bucket/object');
  await minio.close();
  assert.equal(res.status, 200);
  assert.ok(Date.now() - started >= 9_500, 'the bound is 10 s');
  assert.equal(minio.accepted(), 2);
  assert.deepEqual(minio.gets, ['GET /bucket/object']);
  assert.equal(counted() - before, 1);
});
