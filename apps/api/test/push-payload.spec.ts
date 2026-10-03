// R127 (Brian, 2026-10-03): a push says only that an alert exists. Every push is the fixed text
// "1 new alert in Ops" under a fixed title, with the API's own token; nothing of the alert (a client
// name, an amount, a return, an invoice) leaves the API this way, and without a token nothing is sent.
// The sender is built from plain values with a recording fetch: nothing leaves this spec. Synthetic data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { PUSH_TEXT, PUSH_TITLE, makePusher, ntfyPusherFor, runPushSweep } from '../src/notify/push.ts';
import { notifyOnce } from '../src/staffing.ts';

let app: FastifyInstance;
let config: Config;

before(async () => {
  config = await createTestConfig('pushpayload');
  app = buildServer(config);
  await app.ready();
});
after(async () => { await app.close(); });

interface Sent { url: string; method: string; headers: Record<string, string>; body: string }
function recorder(status = 200): { sent: Sent[]; send: typeof fetch } {
  const sent: Sent[] = [];
  const send = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body ?? '') });
    return new Response('', { status });
  }) as typeof fetch;
  return { sent, send };
}

test('R127: the fixed text is exactly what Brian ruled', () => {
  assert.equal(PUSH_TEXT, '1 new alert in Ops');
  assert.equal(PUSH_TITLE, 'SAOS');
});

test("R127: an alert that names a client is pushed as the fixed text; the alert's own words never leave", async () => {
  const ceo = await makeStaff(app.db, config, { email: 'ceo-push@example.test', name: 'Synthetic ceo', role: 'ceo', password: 'ceo-password-1234567' });
  const title = 'Invoice SA-2099-0042 unpaid 30+ days: Synthetic Pushclient';
  const body = 'Synthetic Pushclient owes $1,234.00 on the 2025 1040.';
  await notifyOnce(app.db, { staffId: ceo.id, type: 'invoice_unpaid_30', severity: 'critical', title, body, relatedObjectType: 'invoice', relatedObjectId: 'synthetic-1' });
  await notifyOnce(app.db, { staffId: ceo.id, type: 'info_only', severity: 'info', title: 'Synthetic: not pushed', relatedObjectType: 'x', relatedObjectId: 'synthetic-2' });

  const { sent, send } = recorder();
  const out = await runPushSweep(app, ntfyPusherFor({ url: 'http://push.invalid', topic: 'synthetic-topic', token: 'tk_synthetic' }, send));
  assert.equal(out.pushed, 1, 'one push for the one critical alert; the info row is not pushed');
  assert.equal(sent.length, 1);
  const req = sent[0]!;
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'http://push.invalid/synthetic-topic');
  assert.equal(req.body, '1 new alert in Ops');
  assert.deepEqual(req.headers, { Authorization: 'Bearer tk_synthetic', Title: 'SAOS', Priority: 'high' }, 'three headers, each fixed but the token');
  const wire = JSON.stringify(req);
  for (const word of ['Pushclient', 'SA-2099-0042', '1,234', '1040', 'invoice_unpaid_30', 'unpaid']) {
    assert.ok(!wire.includes(word), `"${word}" is not in the request`);
  }
  const row = await app.db.query<{ pushed_at: string | null; title: string }>(`SELECT pushed_at, title FROM notifications WHERE related_object_id = 'synthetic-1'`);
  assert.ok(row.rows[0]!.pushed_at, 'the alert is stamped pushed');
  assert.equal(row.rows[0]!.title, title, 'and the full alert stays in Ops');

  const again = await runPushSweep(app, ntfyPusherFor({ url: 'http://push.invalid', topic: 'synthetic-topic', token: 'tk_synthetic' }, send));
  assert.equal(again.pushed, 0, 'never re-sent');
  assert.equal(sent.length, 1);
});

test('R127: with push on and no token, or no topic, nothing is sent, and the alert waits for the next sweep', async () => {
  const ceo = (await app.db.query<{ id: string }>(`SELECT id FROM staff WHERE email = 'ceo-push@example.test'`)).rows[0]!;
  await notifyOnce(app.db, { staffId: ceo.id, type: 'no_token_case', severity: 'warning', title: 'Synthetic: waits for a token', relatedObjectType: 'x', relatedObjectId: 'synthetic-3' });
  const { sent, send } = recorder();
  const out = await runPushSweep(app, ntfyPusherFor({ url: 'http://push.invalid', topic: 'synthetic-topic', token: undefined }, send));
  assert.equal(out.pushed, 0);
  assert.equal(sent.length, 0, 'no request without a token');
  const blank = await runPushSweep(app, ntfyPusherFor({ url: 'http://push.invalid', topic: '', token: 'tk_synthetic' }, send));
  assert.equal(blank.pushed, 0);
  assert.equal(sent.length, 0, 'and none without a topic');
  const row = await app.db.query<{ pushed_at: string | null }>(`SELECT pushed_at FROM notifications WHERE related_object_id = 'synthetic-3'`);
  assert.equal(row.rows[0]!.pushed_at, null, 'not stamped: it is pushed once a token is set');
});

test('R127: a refusal from the server (401, 403) leaves the alert unstamped', async () => {
  const { sent, send } = recorder(403);
  const out = await runPushSweep(app, ntfyPusherFor({ url: 'http://push.invalid', topic: 'synthetic-topic', token: 'tk_wrong' }, send));
  assert.equal(out.pushed, 0);
  assert.equal(sent.length, 1, 'it asked once');
  assert.equal(sent[0]!.body, '1 new alert in Ops', 'and even a refused request carried only the fixed text');
});

test('R127: the test configuration pushes nowhere (stub)', () => {
  assert.equal(makePusher(config).mode, 'stub');
});
