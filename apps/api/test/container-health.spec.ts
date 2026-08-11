// Container-health watchdog + the skipped-scan filing gate.
//
// Both exist because of one incident: ClamAV sat unhealthy for ~12 hours with 1470
// failed health checks, nothing was watching, and the only reason Brian learned of
// it was a container listing pasted into a report. Two separate failures:
//
//   1. NOBODY WAS WATCHING     -> container health now alerts and opens a task
//   2. FILING FAILED OPEN      -> an unscanned attachment could be filed to a
//                                 client record because only 'infected' was refused

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { recordContainerHealth } from '../src/modules/admin/container-health.ts';
import { ingestInboundAttachment, fileAttachment } from '../src/modules/comms/attachments.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let rene: TestStaff & { token: string };

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${role}`, role, password: `${role}-password-1234567`, totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

before(async () => {
  config = await createTestConfig('containerhealth');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  brian = await staffWithToken('brian-ch@example.test', 'ceo');
  rene = await staffWithToken('rene-ch@example.test', 'comms_billing');
});

after(async () => {
  await app.close();
});

// ── 1. Somebody is watching now ───────────────────────────────────────────────

test('a container unhealthy past the grace period alerts Brian AND opens one task', async () => {
  const result = await recordContainerHealth(app, [
    { name: 'saos-clamav-1', health: 'unhealthy', state: 'running', failingStreak: 1470, unhealthyMinutes: 720 },
    { name: 'saos-api-1', health: 'healthy', state: 'running', failingStreak: 0 },
  ]);
  assert.deepEqual(result.alerted, ['saos-clamav-1']);
  assert.equal(result.graceMinutes, 10, 'the threshold is a setting, not a literal');

  const alert = await app.db.query<{ severity: string; title: string }>(
    `SELECT severity::text, title FROM notifications WHERE type = 'container_unhealthy' ORDER BY created_at DESC LIMIT 1`
  );
  assert.equal(alert.rows[0]!.severity, 'critical', 'a dead virus scanner is critical, not a warning');
  assert.match(alert.rows[0]!.title, /saos-clamav-1/);
  assert.match(alert.rows[0]!.title, /virus scanning is down/i, 'it says WHY it matters');

  const task = await app.db.query<{ title: string; description: string; priority: number }>(
    `SELECT title, description, priority FROM tasks WHERE source_type = 'container_unhealthy'`
  );
  assert.equal(task.rows.length, 1, 'exactly one task');
  assert.match(task.rows[0]!.description, /docker restart saos-clamav-1/, 'it tells you how to fix it');
  assert.equal(task.rows[0]!.priority, 1);

  // Re-reporting the same outage does not pile up tasks.
  await recordContainerHealth(app, [
    { name: 'saos-clamav-1', health: 'unhealthy', state: 'running', failingStreak: 1475, unhealthyMinutes: 725 },
  ]);
  const again = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'container_unhealthy'`
  );
  assert.equal(again.rows[0]!.n, 1, 'still one — a 12-hour outage is one problem, not 144 tasks');
});

test('a briefly-unhealthy or still-starting container does NOT alert', async () => {
  const result = await recordContainerHealth(app, [
    // Two minutes in, two failed checks: a service that is restarting normally.
    { name: 'saos-whisper-1', health: 'unhealthy', state: 'running', failingStreak: 2, unhealthyMinutes: 2 },
    { name: 'saos-ollama-1', health: 'starting', state: 'running', failingStreak: 0 },
    { name: 'saos-minio-1', health: 'none', state: 'running', failingStreak: 0 },
  ]);
  assert.deepEqual(result.alerted, [], 'no noise for normal startup churn');
});

test('an exited container alerts immediately — there is no grace period for gone', async () => {
  const result = await recordContainerHealth(app, [
    { name: 'saos-minio-1', health: 'none', state: 'exited', failingStreak: 0 },
  ]);
  assert.deepEqual(result.alerted, ['saos-minio-1']);
  const alert = await app.db.query<{ title: string; severity: string }>(
    `SELECT title, severity::text FROM notifications WHERE title LIKE '%minio%' ORDER BY created_at DESC LIMIT 1`
  );
  assert.match(alert.rows[0]!.title, /state exited/);
  assert.equal(alert.rows[0]!.severity, 'critical', 'document storage down is critical');
});

test('the host reports over a secret-authenticated webhook, not a session', async () => {
  const payload = {
    containers: [{ name: 'saos-calcom-1', health: 'unhealthy', state: 'running', failingStreak: 30, unhealthyMinutes: 60 }],
  };
  const noSecret = await app.inject({ method: 'POST', url: '/webhooks/container-health', payload });
  assert.equal(noSecret.statusCode, 401);

  const wrong = await app.inject({
    method: 'POST', url: '/webhooks/container-health',
    headers: { 'x-webhook-secret': 'not-the-secret' }, payload,
  });
  assert.equal(wrong.statusCode, 401);

  const ok = await app.inject({
    method: 'POST', url: '/webhooks/container-health',
    headers: { 'x-webhook-secret': config.WEBHOOK_SECRET }, payload,
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(ok.json().alerted, ['saos-calcom-1']);
});

// ── 2. Filing no longer fails open ────────────────────────────────────────────

async function quarantinedUnscanned(name: string): Promise<{ id: string; contactId: string }> {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: name, email: `${name.toLowerCase()}@example.test`,
  });
  const att = await ingestInboundAttachment(app, {
    channel: 'email', originRef: `probe-${name}`, sender: `${name.toLowerCase()}@example.test`,
    contactId: c.id, filename: 'receipt.pdf', mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 synthetic\n%%EOF'),
  });
  // No CLAMAV_HOST in test config, so the scan is genuinely 'skipped' — the same
  // state a wedged clamd produces in production.
  assert.equal(att.scanStatus, 'skipped');
  return { id: att.id, contactId: c.id };
}

test('an UNSCANNED attachment cannot be filed without an override', async () => {
  const { id } = await quarantinedUnscanned('Unscanned');
  await assert.rejects(
    fileAttachment(app, id, { category: 'tax_documents', actor: rene, actorRoleKey: 'comms_billing' }),
    (err: { code?: string; message?: string }) => {
      assert.equal(err.code, 'scan_not_clean');
      assert.match(String(err.message), /never scanned/i);
      assert.match(String(err.message), /re-upload through the portal/i, 'it offers the better path first');
      return true;
    }
  );
  const still = await app.db.query<{ status: string }>(
    `SELECT status FROM inbound_attachments WHERE id = $1`, [id]
  );
  assert.equal(still.rows[0]!.status, 'quarantined', 'it stays in quarantine');
});

test('the override is Brian\'s alone, needs a real reason, and is audited by name', async () => {
  const { id, contactId } = await quarantinedUnscanned('Overridden');

  // Rene cannot override even with a note.
  await assert.rejects(
    fileAttachment(app, id, {
      category: 'tax_documents', actor: rene, actorRoleKey: 'comms_billing',
      unscannedOverrideNote: 'Client is waiting and I checked it myself.',
    }),
    (err: { code?: string }) => err.code === 'unscanned_override_requires_ceo'
  );

  // A one-word "reason" is refused at the route boundary.
  const thin = await app.inject({
    method: 'POST', url: `/inbound-attachments/${id}/file`, headers: auth(brian),
    payload: { category: 'tax_documents', unscannedOverrideNote: 'ok' },
  });
  assert.equal(thin.statusCode, 400, 'ten characters minimum — a reason, not an acknowledgement');

  // Brian's documented override goes through.
  const ok = await app.inject({
    method: 'POST', url: `/inbound-attachments/${id}/file`, headers: auth(brian),
    payload: {
      category: 'tax_documents',
      unscannedOverrideNote: 'Scanner was wedged; I opened this receipt in a sandbox and it is a photo.',
    },
  });
  assert.equal(ok.statusCode, 200, ok.body);

  const override = await app.db.query<{ details: Record<string, unknown>; actor_label: string }>(
    `SELECT details, actor_label FROM audit_log
     WHERE action = 'attachment.unscanned_override' AND object_id = $1`,
    [id]
  );
  assert.equal(override.rows.length, 1, 'a separately searchable audit action');
  assert.equal(override.rows[0]!.actor_label, brian.email, 'recorded by name');
  assert.equal((override.rows[0]!.details as { scan_status: string }).scan_status, 'skipped');
  assert.match(String((override.rows[0]!.details as { note: string }).note), /sandbox/);

  const filed = await app.db.query<{ status: string }>(
    `SELECT status FROM inbound_attachments WHERE id = $1`, [id]
  );
  assert.equal(filed.rows[0]!.status, 'filed');
  assert.ok(contactId);
});

test('a CLEAN attachment still files with no override and no ceremony', async () => {
  const { id } = await quarantinedUnscanned('CleanPath');
  // Simulate a working scanner having passed it.
  await app.db.query(
    `UPDATE inbound_attachments SET scan_status = 'clean', scan_detail = NULL WHERE id = $1`, [id]
  );
  const res = await fileAttachment(app, id, {
    category: 'tax_documents', actor: rene, actorRoleKey: 'comms_billing',
  });
  assert.ok(res.documentId, 'the normal path is unchanged');
  const none = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = 'attachment.unscanned_override' AND object_id = $1`, [id]
  );
  assert.equal(none.rows.length, 0, 'no override row when none was needed');
});
