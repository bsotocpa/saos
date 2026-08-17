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
import type { Summarizer } from '../src/modules/meetings/adapters.ts';

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

// The loop returns the instant the status matches, so a generous ceiling costs
// nothing on a fast run. 8s was too tight: under the FULL suite (every spec file
// sharing this box) the stubbed pipeline queue got starved and this flaked, while
// passing in 3s on its own. The timeout is here to eventually fail a genuine
// hang, not to enforce a performance budget.
async function waitForStatus(meetingId: string, wanted: string[], timeoutMs = 30_000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const { rows } = await app.db.query<{ status: string }>(`SELECT status FROM meetings WHERE id = $1`, [meetingId]);
    const status = rows[0]?.status ?? 'missing';
    if (wanted.includes(status)) return status;
    if (Date.now() - start > timeoutMs) return status;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * Make a meeting look older than it is.
 *
 * `set_updated_at` fires BEFORE UPDATE and assigns now() unconditionally, so a plain
 * `SET updated_at = ...` is stamped straight back over. The trigger is what makes
 * updated_at trustworthy in production ("how long has this been in this state"), so
 * the test suspends it rather than the code working around it.
 */
async function backdate(meetingId: string, interval: string): Promise<void> {
  await app.db.query(`ALTER TABLE meetings DISABLE TRIGGER trg_meetings_updated_at`);
  try {
    await app.db.query(
      `UPDATE meetings SET created_at = now() - $2::interval, updated_at = now() - $2::interval WHERE id = $1`,
      [meetingId, interval]
    );
  } finally {
    await app.db.query(`ALTER TABLE meetings ENABLE TRIGGER trg_meetings_updated_at`);
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

  /*
   * Auto tasks from action items, owned by the session's staff member.
   *
   * INVERTED: `source_id` is now `<meetingId>:<index>` rather than the meeting id repeated.
   * The pipeline creates tasks through `createTask()` (Brian's one-door rule, 2026-08-17), and
   * that dedupes on (source_type, source_id) — so a shared id would have collapsed every
   * action item after the first into one task. A meeting producing five commitments would have
   * recorded one. The DISTINCT assertion below is the property that change protects.
   */
  const tasks = await app.db.query<{ n: number; distinct_ids: number }>(
    `SELECT count(*)::int AS n, count(DISTINCT source_id)::int AS distinct_ids
       FROM tasks
      WHERE source_type = 'meeting_action_item' AND source_id LIKE $1 || ':%'
        AND assigned_staff_id = $2`,
    [meetingId, jackson.id]
  );
  assert.equal(tasks.rows[0]!.n, 2);
  assert.equal(tasks.rows[0]!.distinct_ids, 2, 'each action item is its own work item, not deduped into one');

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
  await app.db.query(`UPDATE meetings SET status = 'recorded' WHERE id = $1`, [meetingId]);
  await backdate(meetingId, '10 minutes');
  await app.db.query(`DELETE FROM time_entries WHERE meeting_id = $1`, [meetingId]);

  const sweep = await app.inject({ method: 'POST', url: '/jobs/meeting-recovery', headers: auth(jackson) });
  assert.equal(sweep.statusCode, 200, sweep.body);
  assert.ok(sweep.json().recovered >= 1);
  const status = await waitForStatus(meetingId, ['ready']);
  assert.equal(status, 'ready');
});

/*
 * FINDING #18 — the recovery hole that stranded a real session.
 *
 * Jackson Flores's 7-minute recording went to `transcribing` 352ms after upload on
 * 2026-08-11 and stayed there for two days. The API container restarted mid-
 * transcription, so processMeeting's catch never ran: the status never reached
 * `failed`, no alert fired, and the recovery sweep only ever looked at `recorded` —
 * work that never STARTED. Work that started and vanished was recovered by nothing.
 */
test('recovery sweep rescues a session abandoned MID-processing, not just one never started', async () => {
  const contact = await makeContactRow('Meetmidflight', 'meet-midflight@example.test');
  const up = multipartBody(
    { contactId: contact, type: 'in_person', durationSeconds: '431' },
    { field: 'file', filename: 'midflight.wav', contentType: 'audio/wav', data: WAV }
  );
  const res = await app.inject({
    method: 'POST', url: '/meetings/upload', headers: { ...auth(jackson), ...up.headers }, payload: up.payload,
  });
  const meetingId = res.json().id as string;
  await waitForStatus(meetingId, ['ready']);

  // Exactly Jackson's state: mid-flight, transcript and summary wiped, long stale.
  await app.db.query(`DELETE FROM transcripts WHERE meeting_id = $1`, [meetingId]);
  await app.db.query(`DELETE FROM meeting_summaries WHERE meeting_id = $1`, [meetingId]);
  await app.db.query(`DELETE FROM time_entries WHERE meeting_id = $1`, [meetingId]);
  await app.db.query(`UPDATE meetings SET status = 'transcribing' WHERE id = $1`, [meetingId]);
  await backdate(meetingId, '2 days');

  const sweep = await app.inject({ method: 'POST', url: '/jobs/meeting-recovery', headers: auth(jackson) });
  assert.equal(sweep.statusCode, 200, sweep.body);
  assert.ok(sweep.json().recovered >= 1, 'the mid-flight session was picked up');

  assert.equal(await waitForStatus(meetingId, ['ready']), 'ready');
  const rebuilt = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM meeting_summaries WHERE meeting_id = $1`, [meetingId]);
  assert.equal(rebuilt.rows[0]!.n, 1, 'and it produced the summary that was missing');
});

test('a session still genuinely in flight is left alone', async () => {
  const contact = await makeContactRow('Meetinflight', 'meet-inflight@example.test');
  const up = multipartBody(
    { contactId: contact, type: 'phone', durationSeconds: '600' },
    { field: 'file', filename: 'inflight.wav', contentType: 'audio/wav', data: WAV }
  );
  const res = await app.inject({
    method: 'POST', url: '/meetings/upload', headers: { ...auth(jackson), ...up.headers }, payload: up.payload,
  });
  const meetingId = res.json().id as string;
  await waitForStatus(meetingId, ['ready']);
  // Transcribing for ten minutes is Whisper doing its job on CPU, not a stall.
  // Re-enqueueing it would transcribe the same audio twice.
  await app.db.query(`UPDATE meetings SET status = 'transcribing' WHERE id = $1`, [meetingId]);
  await backdate(meetingId, '10 minutes');

  const sweep = await app.inject({ method: 'POST', url: '/jobs/meeting-recovery', headers: auth(jackson) });
  assert.equal(sweep.statusCode, 200, sweep.body);
  const still = await app.db.query<{ status: string }>(
    `SELECT status::text AS status FROM meetings WHERE id = $1`, [meetingId]);
  assert.equal(still.rows[0]!.status, 'transcribing', 'left running, not restarted');
});

test('the client record lists sessions with their summaries; the transcript is separate and audited', async () => {
  const contact = await makeContactRow('Meetrecord', 'meet-record@example.test');
  const up = multipartBody(
    { contactId: contact, type: 'in_person', durationSeconds: '431' },
    { field: 'file', filename: 'record.wav', contentType: 'audio/wav', data: WAV }
  );
  const res = await app.inject({
    method: 'POST', url: '/meetings/upload', headers: { ...auth(jackson), ...up.headers }, payload: up.payload,
  });
  const meetingId = res.json().id as string;
  await waitForStatus(meetingId, ['ready']);

  const list = await app.inject({
    method: 'GET', url: `/contacts/${contact}/meetings`, headers: auth(ana),
  });
  assert.equal(list.statusCode, 200, list.body);
  const row = (list.json().meetings as Array<Record<string, unknown>>)[0]!;
  assert.equal(row.id, meetingId);
  assert.ok(row.summary, 'the summary is IN the list — reviewing a session is the point');
  assert.equal(row.has_transcript, true);
  assert.equal(row.stalled, false);
  assert.ok(!('content' in row), 'the transcript body is NOT in the list payload');

  // Reading the transcript is its own call, and it lands in the audit log.
  const before = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = 'transcript.read' AND object_id = $1`,
    [meetingId]
  );
  const t = await app.inject({
    method: 'GET', url: `/meetings/${meetingId}/transcript`, headers: auth(ana),
  });
  assert.equal(t.statusCode, 200, t.body);
  assert.ok((t.json().transcript.content as string).length > 0);
  const after = await app.db.query<{ n: number; details: Record<string, unknown> }>(
    `SELECT count(*)::int AS n, (array_agg(details))[1] AS details FROM audit_log
      WHERE action = 'transcript.read' AND object_id = $1`,
    [meetingId]
  );
  assert.equal(after.rows[0]!.n, before.rows[0]!.n + 1, 'the read was audited');
  // No-PII-in-logs applies hardest to the table holding whole conversations.
  assert.ok(!JSON.stringify(after.rows[0]!.details).includes('transcript of'), 'content never enters the log');
  assert.ok('chars' in after.rows[0]!.details, 'a length is recorded instead');
});

/*
 * The real case, from Jackson Flores's re-processed session: the summary text said
 * "no major decisions or action items" and the model emitted an action item anyway,
 * whose text was literally "...". The pipeline turned that into a task in Brian's
 * queue described as "...". A task nobody can act on costs attention to open and
 * teaches people to skim the queue.
 *
 * Driven by an injected summarizer, because the stub regenerates its own action items
 * on every re-process — seeding a bad one into the table proves nothing, it is
 * overwritten before the code under test ever sees it.
 */
test('a placeholder action item does not become a task nobody can act on', async () => {
  const placeholderSummarizer: Summarizer = {
    mode: 'stub',
    async summarize() {
      return {
        summary: 'Caught up on the grant cycle. No major decisions or action items.',
        decisions: [],
        actionItems: [
          { owner: null, due: null, text: '...' },        // the exact junk that shipped
          { owner: null, due: null, text: '  ' },         // whitespace only
          { owner: null, due: null, text: '-' },          // punctuation only
          { owner: null, due: null, text: 'Send the 2025 organizer' }, // the real one
        ],
        taxNeed: false,
        taxNeedDescription: null,
        referralHiloToSoto: false,
        referralSotoToHilo: false,
      };
    },
  };

  const cfg = await createTestConfig('meetph');
  const app2 = buildServer(cfg, { summarizer: placeholderSummarizer });
  await app2.ready();
  try {
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    const st = await makeStaff(app2.db, cfg, {
      email: 'ph-meet@example.test', name: 'Synthetic ED', role: 'ed_coo',
      password: 'ph-password-123456', totpSecret: secret,
    });
    const code = new OTPAuth.TOTP({
      algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
    }).generate();
    const login = await app2.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: st.email, password: st.password, totp: code },
    });
    const token = login.json().token as string;

    const { rows } = await app2.db.query<{ id: string }>(
      `INSERT INTO contacts (first_name, last_name, email, hilo_status, soto_status)
       VALUES ('Synthetic', 'Meetplaceholder', 'meet-placeholder@example.test', 'active', 'none') RETURNING id`
    );
    const up = multipartBody(
      { contactId: rows[0]!.id, type: 'phone', durationSeconds: '60' },
      { field: 'file', filename: 'placeholder.wav', contentType: 'audio/wav', data: WAV }
    );
    const res = await app2.inject({
      method: 'POST', url: '/meetings/upload',
      headers: { authorization: `Bearer ${token}`, ...up.headers }, payload: up.payload,
    });
    const meetingId = res.json().id as string;

    for (let i = 0; i < 200; i += 1) {
      const s = await app2.db.query<{ status: string }>(`SELECT status FROM meetings WHERE id = $1`, [meetingId]);
      if (s.rows[0]?.status === 'ready' || s.rows[0]?.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 150));
    }

    // `source_id` is `<meetingId>:<index>` now — see the inversion note on the walkthrough test.
    const tasks = await app2.db.query<{ description: string }>(
      `SELECT description FROM tasks
        WHERE source_id LIKE $1 || ':%' AND source_type = 'meeting_action_item'`,
      [meetingId]
    );
    assert.equal(tasks.rows.length, 1, 'exactly one of the four action items was actionable');
    assert.equal(tasks.rows[0]!.description, 'Send the 2025 organizer');
  } finally {
    await app2.close();
  }
});

test('a stalled session is NAMED as stalled, not left looking busy', async () => {
  const contact = await makeContactRow('Meetstalled', 'meet-stalled@example.test');
  const up = multipartBody(
    { contactId: contact, type: 'in_person', durationSeconds: '431' },
    { field: 'file', filename: 'stalled.wav', contentType: 'audio/wav', data: WAV }
  );
  const res = await app.inject({
    method: 'POST', url: '/meetings/upload', headers: { ...auth(jackson), ...up.headers }, payload: up.payload,
  });
  const meetingId = res.json().id as string;
  await waitForStatus(meetingId, ['ready']);
  await app.db.query(`UPDATE meetings SET status = 'transcribing' WHERE id = $1`, [meetingId]);
  await backdate(meetingId, '2 days');

  const list = await app.inject({
    method: 'GET', url: `/contacts/${contact}/meetings`, headers: auth(ana),
  });
  const row = (list.json().meetings as Array<Record<string, unknown>>)[0]!;
  assert.equal(row.stalled, true, 'two days in transcribing reads as stalled, not "still working"');
});
