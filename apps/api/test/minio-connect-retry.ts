/*
 * THE CONNECT-PHASE RETRY FOR THE TEST OBJECT STORE (Brian, 2026-09-29, receipt run 47).
 *
 * The same bound as the database's (connect-retry.ts): one fresh connection when a NEW MinIO connection
 * resets or has not opened within 10 s; never a request that already reached MinIO; counted in the same
 * suite summary under the same limit; test processes only.
 *
 * "Opened" is proven, not assumed: through the Docker Desktop relay a TCP connect succeeds at once even
 * when the relay cannot reach the container. So a new socket to the MinIO endpoint first carries a
 * `HEAD /minio/health/live`; only when MinIO answers on it is the socket handed to the request. A reset
 * or silence before that answer is the connect phase: the socket is thrown away and one fresh one is
 * opened. The request itself is never re-sent: it goes out only on a socket MinIO has answered.
 * minio-js uses node:http's global agent, so the hook is that agent's createConnection, for the MinIO
 * host and port alone; every other connection passes through untouched.
 */
import http from 'node:http';
import net from 'node:net';
import { CONNECT_TIMEOUT_MS, recordConnectRetry } from './connect-retry.ts';

const targets = new Set<string>();
const LOCAL = ['localhost', '127.0.0.1', '::1'];

/** Probe-and-retry new connections to this endpoint (a test's own fake server may add itself). */
export function addMinioTarget(host: string, port: number): void {
  for (const h of LOCAL.includes(host) ? LOCAL : [host]) targets.add(`${h}:${port}`);
  install();
}

function install(): void {
  type CreateConnection = (o: { host?: string | null; port?: number | string | null }, cb?: (e: Error | null, s?: net.Socket) => void) => net.Socket | undefined;
  const agent = http.globalAgent as unknown as { createConnection: CreateConnection; __saosMinio?: boolean };
  if (agent.__saosMinio) return;
  agent.__saosMinio = true;
  const original = agent.createConnection.bind(agent);
  agent.createConnection = (options, cb) => {
    const host = String(options.host ?? 'localhost');
    const port = Number(options.port);
    if (!cb || !targets.has(`${host}:${port}`)) return original(options, cb);
    const open = (isRetry: boolean): void => {
      const socket = net.connect({ host, port });
      let done = false;
      let head = '';
      const fail = (err: Error & { code?: string }): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        if (!isRetry) { recordConnectRetry(`minio ${err.code ?? 'timeout'}`); open(true); return; }
        cb(err);
      };
      const timer = setTimeout(() => fail(Object.assign(new Error(`MinIO did not answer on a new connection within ${CONNECT_TIMEOUT_MS / 1000} s`), { code: 'ETIMEDOUT' })), CONNECT_TIMEOUT_MS);
      timer.unref();
      const onError = (e: Error & { code?: string }) => fail(e);
      const onClose = () => fail(Object.assign(new Error('MinIO connection closed before MinIO answered'), { code: 'ECONNRESET' }));
      const onData = (chunk: Buffer): void => {
        head += chunk.toString('latin1');
        if (!head.includes('\r\n\r\n')) return;
        // MinIO answered on this socket: it is open. Hand it over, clean, for the request.
        done = true;
        clearTimeout(timer);
        socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose);
        cb(null, socket);
      };
      socket.on('error', onError);
      socket.on('close', onClose);
      socket.on('data', onData);
      socket.once('connect', () => socket.write(`HEAD /minio/health/live HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: keep-alive\r\n\r\n`));
    };
    open(false);
    return undefined;
  };
}
