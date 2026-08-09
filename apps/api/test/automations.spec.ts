// Client-acting automation kill switches (Brian's directive 2026-08-09).
// THE POINT OF THESE TESTS: with an automation disarmed, nothing reaches the
// client — but the internal work (tasks, alerts, A/R status, rung state) is
// unaffected, and the run record counts what was suppressed. Every automation
// ships enabled=false; the test bootstrap arms them, so each test here
// explicitly disarms the one it is proving.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createTask, runLadderJob, setTaskStatus } from '../src/modules/tasks/service.ts';
import { runInvoiceOverdueJob } from '../src/modules/billing/service.ts';
import { AUTOMATION_KEYS, isAutomationEnabled } from '../src/automations.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let rene: TestStaff;
const sentMail: MailMessage[] = [];

const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });
const capturingMailer: Mailer = {
  transport: 'console',
  async send(msg) { sentMail.push(msg); return { id: `test-${sentMail.length}` }; },
};

async function staffWithToken(email: string, role: string) {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

async function disarm(key: string): Promise<void> {
  const res = await app.db.query(`UPDATE automations SET enabled = false WHERE key = $1`, [key]);
  assert.equal(res.rowCount, 1, `${key} must exist in the registry`);
}

before(async () => {
  config = await createTestConfig('automations');
  app = buildServer(config, { mailer: capturingMailer });
  await app.ready();
  brian = await staffWithToken('brian-auto@example.test', 'ceo');
  rene = await makeStaff(app.db, config, {
    email: 'rene-auto@example.test', name: 'Synthetic Rene', role: 'comms_billing',
    password: 'comms_billing-password-123456',
  });
});

after(async () => {
  await app.close();
});

test('every registered automation ships DISABLED by seed default', async () => {
  // The seed inserts enabled=false; the TEST bootstrap arms them afterwards.
  // Prove the shipped default by re-inserting a fresh key the seed way.
  await app.db.query(
    `INSERT INTO automations (key, name, description) VALUES ('synthetic_probe', 'Probe', 'Ships off.')`
  );
  assert.equal(await isAutomationEnabled(app, 'synthetic_probe' as never), false, 'new automations arrive OFF');
  // An unregistered key is also false — never accidentally live.
  assert.equal(await isAutomationEnabled(app, 'not_a_real_automation' as never), false);
  await app.db.query(`DELETE FROM automations WHERE key = 'synthetic_probe'`);

  // Registry ↔ database parity, BOTH directions: a gate key with no admin row
  // would be un-armable; a seeded row with no gate would be un-enforced.
  const rows = await app.db.query<{ key: string }>(`SELECT key FROM automations`);
  const dbKeys = new Set(rows.rows.map((r) => r.key));
  for (const key of AUTOMATION_KEYS) {
    assert.ok(dbKeys.has(key), `${key} must have an admin row (seed it)`);
  }
  for (const key of dbKeys) {
    assert.ok((AUTOMATION_KEYS as readonly string[]).includes(key), `${key} has an admin row but no code gate`);
  }
});

test('ladder disarmed: no client sends, rungs DO NOT advance, suppression counted', async () => {
  await disarm('escalation_ladder');
  const wendy = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Waitoff', email: 'wait-off@example.test' });
  const t = await createTask(app, { title: 'Send us the K-1', contactId: wendy.id, source: 'manual' });
  await setTaskStatus(app, t.id, 'waiting_for_input', brian);
  await app.db.query(`UPDATE tasks SET waiting_since = timestamp '2030-05-01 12:00' WHERE id = $1`, [t.id]);

  const mailBefore = sentMail.length;
  const run = await runLadderJob(app, '2030-06-20'); // 50 days waiting = past D30
  assert.equal(run.skipped, false);
  assert.deepEqual(run.rungs, [0, 0, 0, 0], 'nothing fired');
  assert.equal(run.suppressed, 1, 'run record shows what would have gone out');
  assert.equal(sentMail.length, mailBefore, 'no client email');

  // Rung stays 0 — arming it later must not dump everyone at D30.
  const rung = await app.db.query<{ ladder_rung: number }>(`SELECT ladder_rung FROM tasks WHERE id = $1`, [t.id]);
  assert.equal(rung.rows[0]!.ladder_rung, 0, 'rungs frozen while disarmed');
  // No D14 call task / D30 stalled task either (they belong to the ladder).
  const spawned = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type IN ('ladder_call', 'stalled_flag') AND source_id = $1`,
    [t.id]
  );
  assert.equal(spawned.rows[0]!.n, 0);

  // Armed on the NEXT day → the ladder fires the top rung it has reached.
  await app.db.query(`UPDATE automations SET enabled = true WHERE key = 'escalation_ladder'`);
  const armed = await runLadderJob(app, '2030-06-21');
  assert.deepEqual(armed.rungs, [0, 0, 0, 1], 'arming picks up where the clock actually is');
});

test('A/R dunning disarmed: invoice still goes overdue and Rene still gets the task — client is not chased', async () => {
  await disarm('ar_dunning');
  const dan = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Dunoff', email: 'dun-off@example.test' });
  const invoice = await app.inject({
    method: 'POST', url: '/invoices', headers: auth(brian),
    payload: { contactId: dan.id, lines: [{ code: 'ENTITY_BOI' }] },
  });
  assert.equal(invoice.statusCode, 201, invoice.body);
  const invoiceId = invoice.json().id as string;
  await app.db.query(`UPDATE invoices SET sent_at = now() - interval '30 days' WHERE id = $1`, [invoiceId]);

  const run = await runInvoiceOverdueJob(app, '2030-07-01');
  assert.equal(run.overdue, 1);
  assert.equal(run.suppressed, 1, 'the client reminder was suppressed and counted');
  assert.equal(
    sentMail.filter((m) => m.to === 'dun-off@example.test' && /reminder/i.test(m.subject)).length,
    0,
    'no dunning email reached the client'
  );

  // Internal side intact: status flipped, Rene flagged, chase task exists.
  const inv = await app.db.query<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [invoiceId]);
  assert.equal(inv.rows[0]!.status, 'overdue', 'A/R truth is not gated');
  const flag = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'invoice_overdue' AND related_object_id = $1`,
    [invoiceId]
  );
  assert.equal(flag.rows[0]!.n, 1, 'Rene still flagged');
  const task = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'invoice_overdue' AND source_id = $1`,
    [invoiceId]
  );
  assert.equal(task.rows[0]!.n, 1, 'collection work item still created');
});

test('admin toggles are audited and drive the gate immediately', async () => {
  const listed = await app.inject({ method: 'GET', url: '/admin/automations', headers: auth(brian) });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().automations.length, AUTOMATION_KEYS.length);

  const off = await app.inject({
    method: 'PATCH', url: '/admin/automations/attachment_acks', headers: auth(brian),
    payload: { enabled: false },
  });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(await isAutomationEnabled(app, 'attachment_acks'), false);

  const on = await app.inject({
    method: 'PATCH', url: '/admin/automations/attachment_acks', headers: auth(brian),
    payload: { enabled: true },
  });
  assert.equal(on.statusCode, 200, on.body);
  assert.equal(await isAutomationEnabled(app, 'attachment_acks'), true);

  const audit = await app.db.query<{ action: string }>(
    `SELECT action FROM audit_log WHERE object_type = 'automation' AND object_id = 'attachment_acks' ORDER BY occurred_at`
  );
  assert.deepEqual(audit.rows.map((r) => r.action), ['automation.disabled', 'automation.enabled']);

  const unknown = await app.inject({
    method: 'PATCH', url: '/admin/automations/nope', headers: auth(brian), payload: { enabled: true },
  });
  assert.equal(unknown.statusCode, 404);

  // Leadership-only: the preparer role cannot arm client automations.
  const ana = await staffWithToken('ana-auto@example.test', 'tax_preparer');
  const forbidden = await app.inject({
    method: 'PATCH', url: '/admin/automations/ar_dunning', headers: auth(ana), payload: { enabled: true },
  });
  assert.equal(forbidden.statusCode, 403);
  void rene;
});
