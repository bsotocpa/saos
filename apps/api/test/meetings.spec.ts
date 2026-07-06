// M17 "Prove it" (stub adapters — deterministic): full pipeline e2e from a
// voice-memo upload through transcript → summary → auto tasks → §7216-aware
// referral queue → suggested pro-bono time entry; failure path lands in
// 'failed' with a staff notification; Zoom webhook auth; recovery sweep.
// The live Whisper+Ollama run + memory measurement happens outside this
// suite (adapter modes flip by env). Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeStaff, multipartBody, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let jackson: TestStaff & { token: string }; // ed_coo — records Hilo sessions
let ana: TestStaff & { token: string };     // tax_preparer — meetings.upload

const WAV = Buffer.concat([
  Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(64, 7),
]);

const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  const res = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email, password: staff.password, totp: code },
  });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

async function makeContactRow(last: string, email: string, opts: { hilo?: string; soto?: string } = {}): Promise<string> {
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, hilo_status, soto_status)
     VALUES ('Synthetic', $1, $2, $3::hilo_status, $4::soto_status) RETURNING id`,
    [last, email, opts.hilo ?? 'active', opts.soto ?? 'none']
  );
  return rows[0]!.id;
}

async function waitForStatus(meetingId: string, wanted: string[], timeoutMs = 8000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const { rows } = await app.db.query<{ status: string }>(`SELECT status FROM meetings WHERE id = $1`, [meetingId]);
    const status = rows[0]?.status ?? 'missing';
    if (wanted.includes(status)) return status;
    if (Date.now() - start > timeoutMs) return status;
    await new Promise((r) => setTimeout(r, 150));
  }
}

before(async () => {
  config = await createTestConfig('meet');
  app = buildServer(config);
  await app.ready();
  jackson = await staffWithToken('jackson-meet@example.test', 'ed_coo');
  ana = await staffWithToken('ana-meet@example.test', 'tax_preparer');
});

after(async () => {
  await app.close();
});

test('voice memo → transcript → summary → tasks → referral queue → pro-bono time entry', async () => {
  const rosa = await makeContactRow('Meetrosa', 'meet-rosa@example.test'); // Hilo-only

  const up = multipartBody(
    { contactId: rosa, type: 'in_person', durationSeconds: '660' },
    { field: 'file', filename: 'session.wav', contentType: 'audio/wav', data: WAV }
  );
  const res = await app.inject({
    method: 'POST', url: '/meetings/upload',
    headers: { ...auth(jackson), ...up.headers }, payload: up.payload,
  });
  assert.equal(res.statusCode, 201, res.body);
  const meetingId = res.json().id as string;

  const status = await waitForStatus(meetingId, ['ready', 'failed']);
  assert.equal(status, 'ready');

  // Title convention: "CLIENT — Session Type" (v4.2).
  const meeting = await app.db.query(`SELECT title FROM meetings WHERE id = $1`, [meetingId]);
  assert.equal(meeting.rows[0].title, 'Synthetic Meetrosa — In-Person Session');

  const transcript = await app.db.query(`SELECT engine, content FROM transcripts WHERE meeting_id = $1`, [meetingId]);
  assert.match(transcript.rows[0].content, /Synthetic session transcript/);

  const summary = await app.db.query(
    `SELECT tax_need, referral_rec_hilo_to_soto, action_items FROM meeting_summaries WHERE meeting_id = $1`,
    [meetingId]
  );
  assert.equal(summary.rows[0].tax_need, true, 'stub detects the tax cue');
  assert.equal(summary.rows[0].referral_rec_hilo_to_soto, true);
  assert.equal(summary.rows[0].action_items.length, 2);

  // Auto tasks from action items, owned by the session's staff member.
  const tasks = await app.db.query(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'meeting_action_item' AND source_id = $1 AND assigned_staff_id = $2`,
    [meetingId, jackson.id]
  );
  assert.equal(tasks.rows[0].n, 2);

  // Referral queued (pure Hilo → no §7216 needed) into the approval queue.
  const referral = await app.db.query(
    `SELECT direction, status, source FROM referrals WHERE contact_id = $1`,
    [rosa]
  );
  assert.equal(referral.rows.length, 1);
  assert.equal(referral.rows[0].direction, 'hilo_to_soto');
  assert.equal(referral.rows[0].status, 'pending_approval');
  assert.equal(referral.rows[0].source, 'session_summary');

  // Suggested time entry: 660s → 0.25h, pro bono (Hilo-only contact).
  const entry = await app.db.query(
    `SELECT hours, is_pro_bono, status, service_type FROM time_entries WHERE meeting_id = $1`,
    [meetingId]
  );
  assert.equal(Number(entry.rows[0].hours), 0.25);
  assert.equal(entry.rows[0].is_pro_bono, true, 'Hilo work auto-suggests pro bono');
  assert.equal(entry.rows[0].status, 'suggested');

  const audit = await app.db.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = 'meeting.processed' AND object_id = $1`,
    [meetingId]
  );
  assert.equal(audit.rows[0].n, 1);
});

test('§7216 gate in the pipeline: blocked soto→hilo rec becomes a staff notification, not a silent skip', async () => {
  // A Soto tax client (no consent) whose stub summary recommends soto→hilo.
  const carl = await makeContactRow('Meetcarl', 'meet-carl@example.test', { hilo: 'none', soto: 'active' });
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status) VALUES ($1, 'tax', 'active') RETURNING id`,
    [carl]
  );
  await app.db.query(`INSERT INTO tax_engagements (engagement_id, tax_year, return_type) VALUES ($1, 2025, '1040')`, [
    eng.rows[0]!.id,
  ]);

  const up = multipartBody(
    { contactId: carl, type: 'phone', durationSeconds: '1900' },
    // Filename cue steers the stub to recommend soto→hilo.
    { field: 'file', filename: 'sotoreferral-session.wav', contentType: 'audio/wav', data: WAV }
  );
  const res = await app.inject({
    method: 'POST', url: '/meetings/upload',
    headers: { ...auth(ana), ...up.headers }, payload: up.payload,
  });
  const meetingId = res.json().id as string;
  const status = await waitForStatus(meetingId, ['ready', 'failed']);
  assert.equal(status, 'ready', 'gate block must not fail the pipeline');

  const referrals = await app.db.query(`SELECT count(*)::int AS n FROM referrals WHERE contact_id = $1`, [carl]);
  assert.equal(referrals.rows[0].n, 0, 'no consent → no referral');
  const note = await app.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'referral_blocked_7216' AND staff_id = $1`,
    [ana.id]
  );
  assert.equal(note.rows[0].n, 1, 'the block surfaces to the staff member');

  // Time entry for a Soto client is NOT pro bono; 1900s → 0.75h.
  const entry = await app.db.query(`SELECT hours, is_pro_bono FROM time_entries WHERE meeting_id = $1`, [meetingId]);
  assert.equal(Number(entry.rows[0].hours), 0.75);
  assert.equal(entry.rows[0].is_pro_bono, false);
});

test('upload guards: contact required; non-audio refused; RBAC enforced', async () => {
  const contact = await makeContactRow('Meetguard', 'meet-guard@example.test');

  const noContact = multipartBody({ type: 'phone' }, { field: 'file', filename: 's.wav', contentType: 'audio/wav', data: WAV });
  const r1 = await app.inject({
    method: 'POST', url: '/meetings/upload', headers: { ...auth(jackson), ...noContact.headers }, payload: noContact.payload,
  });
  assert.equal(r1.statusCode, 400);

  const badMime = multipartBody({ contactId: contact, type: 'phone' }, { field: 'file', filename: 'x.pdf', contentType: 'application/pdf', data: WAV });
  const r2 = await app.inject({
    method: 'POST', url: '/meetings/upload', headers: { ...auth(jackson), ...badMime.headers }, payload: badMime.payload,
  });
  assert.equal(r2.statusCode, 415);

  const intern = await staffWithToken('intern-meet@example.test', 'intern');
  const rbac = multipartBody({ contactId: contact, type: 'phone' }, { field: 'file', filename: 's.wav', contentType: 'audio/wav', data: WAV });
  const r3 = await app.inject({
    method: 'POST', url: '/meetings/upload', headers: { ...auth(intern), ...rbac.headers }, payload: rbac.payload,
  });
  assert.equal(r3.statusCode, 403);
});

test('zoom webhook: secret enforced; recording.completed accepted and triaged', async () => {
  const bad = await app.inject({
    method: 'POST', url: '/webhooks/zoom',
    headers: { 'x-webhook-secret': 'wrong' },
    payload: { event: 'recording.completed' },
  });
  assert.equal(bad.statusCode, 401);

  const ok = await app.inject({
    method: 'POST', url: '/webhooks/zoom',
    headers: { 'x-webhook-secret': config.WEBHOOK_SECRET },
    payload: {
      event: 'recording.completed',
      payload: { object: { topic: 'Synthetic Zoom session', duration: 30, recording_files: [{ download_url: 'http://127.0.0.1:1/unreachable' }] } },
    },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  const meetingId = ok.json().meetingId as string;
  const status = await waitForStatus(meetingId, ['failed']);
  assert.equal(status, 'failed', 'unfetchable recording lands in failed for manual triage');
});

test('recovery sweep re-enqueues stuck recordings', async () => {
  const contact = await makeContactRow('Meetstuck', 'meet-stuck@example.test');
  // A meeting stuck in 'recorded' (as after a crash), with a real stored recording.
  const up = multipartBody(
    { contactId: contact, type: 'phone', durationSeconds: '300' },
    { field: 'file', filename: 'stuck.wav', contentType: 'audio/wav', data: WAV }
  );
  const res = await app.inject({
    method: 'POST', url: '/meetings/upload', headers: { ...auth(jackson), ...up.headers }, payload: up.payload,
  });
  const meetingId = res.json().id as string;
  await waitForStatus(meetingId, ['ready']);
  // Simulate the crash state: force back to 'recorded', backdated.
  await app.db.query(
    `UPDATE meetings SET status = 'recorded', created_at = now() - interval '10 minutes' WHERE id = $1`,
    [meetingId]
  );
  await app.db.query(`DELETE FROM time_entries WHERE meeting_id = $1`, [meetingId]);

  const sweep = await app.inject({ method: 'POST', url: '/jobs/meeting-recovery', headers: auth(jackson) });
  assert.equal(sweep.statusCode, 200, sweep.body);
  assert.ok(sweep.json().recovered >= 1);
  const status = await waitForStatus(meetingId, ['ready']);
  assert.equal(status, 'ready');
});
