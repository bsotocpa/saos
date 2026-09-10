// ITEM 10 (2026-09-09, Brian's ruling): a Stripe signature failure logs livemode and the
// endpoint id. The refusal names the world the event claims to come from (livemode, read from
// the payload and never trusted), the event id and type, the mode this box is configured for,
// and the endpoint the installer registered — as a warn line and as an audit row.
// Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };

before(async () => {
  config = await createTestConfig('websig');
  (config as { STRIPE_WEBHOOK_ENDPOINT_ID?: string }).STRIPE_WEBHOOK_ENDPOINT_ID = 'we_synthetic_endpoint';
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
});

after(async () => {
  await app.close();
});

test('a bad signature is refused with 401, and the audit row names livemode, event id, configured mode and endpoint id', async () => {
  const res = await app.inject({
    method: 'POST', url: '/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': 'not-the-secret' },
    payload: JSON.stringify({ id: 'evt_synthetic_live_1', type: 'charge.refunded', livemode: true, data: { object: {} } }),
  });
  assert.equal(res.statusCode, 401, res.body);

  const audit = await app.db.query<{ object_id: string; details: Record<string, unknown> }>(
    `SELECT object_id, details FROM audit_log WHERE action = 'webhook.signature_failed' ORDER BY occurred_at DESC LIMIT 1`);
  assert.equal(audit.rows.length, 1, 'the failure is a durable record');
  const d = audit.rows[0]!.details;
  assert.equal(d.livemode, true, 'the world the event claims');
  assert.equal(d.event_id, 'evt_synthetic_live_1');
  assert.equal(d.event_type, 'charge.refunded');
  assert.equal(d.configured_mode, 'stub', 'the world this box is in');
  assert.equal(d.endpoint_id, 'we_synthetic_endpoint', 'the door it knocked on');
  assert.equal(audit.rows[0]!.object_id, 'we_synthetic_endpoint');
  assert.match(String(d.reason), /bad webhook secret/);
});

test('a body that is not JSON still fails safely, with livemode unknown', async () => {
  const res = await app.inject({
    method: 'POST', url: '/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': 'still-wrong' },
    payload: 'this is not json',
  });
  assert.equal(res.statusCode, 401);
  const audit = await app.db.query<{ details: Record<string, unknown> }>(
    `SELECT details FROM audit_log WHERE action = 'webhook.signature_failed' ORDER BY occurred_at DESC LIMIT 1`);
  assert.equal(audit.rows[0]!.details.livemode, null);
  assert.equal(audit.rows[0]!.details.event_id, null);
});

test('a good secret still passes through untouched', async () => {
  const res = await app.inject({
    method: 'POST', url: '/webhooks/stripe',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': config.WEBHOOK_SECRET },
    payload: JSON.stringify({ id: 'evt_synthetic_ok', type: 'some.unhandled.event', livemode: false, data: { object: {} } }),
  });
  assert.equal(res.statusCode, 200, res.body);
  const count = await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE action = 'webhook.signature_failed'`);
  assert.equal(Number(count.rows[0]!.n), 2, 'no new failure row for a good signature');
});
