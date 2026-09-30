/*
 * THE CONNECT-PHASE RETRY FOR TEST DATABASES (Brian, 2026-09-29, ruling on the receipt resets).
 *
 * The tests reach the local Postgres through the Docker Desktop port relay, and under load the relay
 * resets some NEW connections after exactly 30 s without passing them on (Postgres logs nothing;
 * tasks/lessons.md has the measurements). Brian's ruling, bounded: in test code only, and only while a
 * connection is being established, a new client that has not connected within 10 s, or that fails with
 * ECONNRESET / ETIMEDOUT before it is connected, is replaced by one fresh attempt. A query is never
 * retried, and production code is untouched (this file patches the pool class only in the processes
 * that import the test helpers). Every retry is counted into a per-run file; the API test script's last
 * step prints the total, and a suite with more than 20 is red (scripts/test-db-retries.ts).
 */
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

export const CONNECT_TIMEOUT_MS = 10_000;
export const MAX_CONNECT_RETRIES_PER_SUITE = 20;
/** Where this checkout's test processes record their retries for the current suite. */
export function retryLogPath(tag: string): string {
  // The harness sets its own file for its own summary (apps/e2e/global-setup.ts).
  return process.env.SAOS_TEST_RETRY_LOG ?? join(tmpdir(), `saos-test-connect-retries-${tag}.log`);
}

let retries = 0;
let logPath: string | null = null;

/** Count one connect-phase retry, database or object store, into the suite's summary. */
export function recordConnectRetry(kind: string): void {
  retries++;
  try { if (logPath) appendFileSync(logPath, `${process.pid} ${kind}\n`); } catch { /* the count is still printed on exit */ }
}
/** A failure the relay causes while a connection is being made: a reset, a timeout, a stream cut before the handshake. */
export const isConnectReset = (err: unknown): boolean => {
  const code = (err as { code?: string } | null)?.code;
  const msg = String((err as { message?: string } | null)?.message ?? '');
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || /Connection terminated unexpectedly|timeout expired/.test(msg);
};

type PendingItem = { callback: (err: unknown, client?: unknown, release?: unknown) => void; timedOut?: boolean };
type PoolLike = { _clients: Array<{ connection?: { stream?: { destroy(): void } }; isConnected?: () => boolean; _connected?: boolean }> };

export function installConnectRetry(tag: string): void {
  if (logPath !== null) return;
  logPath = retryLogPath(tag);
  const proto = Object.getPrototypeOf(pg.Pool.prototype) as { newClient: (this: PoolLike, item: PendingItem) => void; __saosRetry?: boolean };
  if (proto.__saosRetry) return;
  proto.__saosRetry = true;
  const original = proto.newClient;
  proto.newClient = function (this: PoolLike, pendingItem: PendingItem): void {
    const attempt = (isRetry: boolean): void => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wrapped: PendingItem = {
        get timedOut() { return pendingItem.timedOut; },
        callback: (err, client, release) => {
          settled = true;
          if (timer) clearTimeout(timer);
          if (err && !isRetry && isConnectReset(err)) {
            recordConnectRetry((err as { code?: string }).code ?? 'timeout');
            attempt(true);
            return;
          }
          pendingItem.callback(err, client, release);
        },
      } as PendingItem;
      original.call(this, wrapped);
      // The client the pool just made is the last one it holds; a connect that hangs is ended at the
      // bound, which fails it through the pool's own path and lands in the callback above.
      const client = this._clients[this._clients.length - 1];
      timer = setTimeout(() => {
        if (!settled && client?.connection?.stream) client.connection.stream.destroy();
      }, CONNECT_TIMEOUT_MS);
      timer.unref();
    };
    attempt(false);
  };
  process.on('exit', () => {
    if (retries > 0) process.stderr.write(`[test-db] ${retries} connect retr${retries === 1 ? 'y' : 'ies'} in this process\n`);
  });
}
