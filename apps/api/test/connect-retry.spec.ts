// THE CONNECT-PHASE RETRY, BOUNDED (Brian, 2026-09-29). Against a server that resets every connection
// while it is being made: the pool tries once more, never twice, the error still reaches the caller,
// and the retry is counted. A query is never retried: the patch wraps the pool's connect path only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { installConnectRetry, retryLogPath } from './connect-retry.ts';

// Its own log, so this spec's deliberate retry never counts toward the suite's limit (the helpers are not imported here).
const TAG = `selftest-${process.pid}`;
installConnectRetry(TAG);

test('a connection reset while connecting is retried once, counted, and then surfaces', async () => {
  let accepted = 0;
  const server = createServer((socket) => { accepted++; socket.resetAndDestroy(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  const before = readFileSync(retryLogPath(TAG), { encoding: 'utf8', flag: 'a+' }).split('\n').filter((l) => l.startsWith(`${process.pid} `)).length;
  const pool = new pg.Pool({ connectionString: `postgresql://nobody:nothing@127.0.0.1:${port}/none`, max: 1 });
  await assert.rejects(pool.query('select 1'), (e: { code?: string; message?: string }) => e.code === 'ECONNRESET' || /terminated/.test(String(e.message)));
  await pool.end();
  server.close();
  assert.equal(accepted, 2, 'two connection attempts: the first and one retry, never more');
  const after = readFileSync(retryLogPath(TAG), 'utf8').split('\n').filter((l) => l.startsWith(`${process.pid} `)).length;
  assert.equal(after - before, 1, 'the retry is counted for the suite summary');
});
