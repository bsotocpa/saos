// M21 "Prove it": WISP security summary (live posture, RBAC-guarded,
// markdown export) + the backup-staleness and restore-drill watchdogs.
// Synthetic data only; backup status fixtures live in the OS temp dir.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { headerSafe } from '../src/notify/push.ts';
import { runBackupStaleCheckJob, runRestoreDrillReminderJob } from '../src/modules/admin/ops.ts';
import { MIGRATED_LOGIN_TARGET, runDubsadoRetirementCheckJob } from '../src/modules/admin/dubsado-retirement.ts';
import { createTestConfig, makeStaff, auditRows, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let statusDir: string;
let statusPath: string;
let ceo: TestStaff;
let preparer: TestStaff;

const CEO_SECRET = new OTPAuth.Secret({ size: 20 }).base32;
const PREPARER_SECRET = new OTPAuth.Secret({ size: 20 }).base32;

function totpCode(secret: string): string {
  return new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
}

async function loginToken(staff: TestStaff): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: staff.email, password: staff.password, totp: totpCode(staff.totpSecret!) },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token as string;
}

async function notificationCount(type: string): Promise<number> {
  const { rows } = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifications WHERE type = $1`,
    [type]
  );
  return rows[0]!.n;
}

before(async () => {
  const base = await createTestConfig('ops');
  statusDir = await mkdtemp(path.join(tmpdir(), 'saos-ops-test-'));
  statusPath = path.join(statusDir, 'status.json');
  config = { ...base, BACKUP_STATUS_PATH: statusPath };
  app = buildServer(config);
  await app.ready();
  ceo = await makeStaff(app.db, config, {
    email: 'brian@example.test', name: 'Synthetic Brian', role: 'ceo',
    password: 'ceo-password-123456', totpSecret: CEO_SECRET,
  });
  preparer = await makeStaff(app.db, config, {
    email: 'ana@example.test', name: 'Synthetic Ana', role: 'tax_preparer',
    password: 'ana-password-123456', totpSecret: PREPARER_SECRET,
  });
});

after(async () => {
  await app.close();
  await rm(statusDir, { recursive: true, force: true });
});

test('ntfy titles survive HTTP header transport (RFC 2047 for non-ASCII)', () => {
  // Plain ASCII passes through untouched.
  assert.equal(headerSafe('Backup is stale'), 'Backup is stale');
  // Em-dashes and Spanish text (both appear in real alert titles) encode —
  // fetch would otherwise throw on any codepoint above Latin-1.
  const encoded = headerSafe('Restore drill has NEVER run — Preparación');
  assert.match(encoded, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  const b64 = encoded.slice('=?UTF-8?B?'.length, -'?='.length);
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), 'Restore drill has NEVER run — Preparación');
});

test('WISP summary is admin-only: preparer 403, ceo 200 with live posture (audited)', async () => {
  const anaToken = await loginToken(preparer);
  const denied = await app.inject({
    method: 'GET', url: '/admin/wisp/security-summary',
    headers: { authorization: `Bearer ${anaToken}` },
  });
  assert.equal(denied.statusCode, 403);

  const ceoToken = await loginToken(ceo);
  const res = await app.inject({
    method: 'GET', url: '/admin/wisp/security-summary',
    headers: { authorization: `Bearer ${ceoToken}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const s = res.json();

  // Access control reflects the real staff table.
  assert.equal(s.access_control.active_count, 2);
  assert.equal(s.access_control.mfa_enrolled_count, 2);
  assert.deepEqual(s.access_control.mfa_pending, []);
  assert.equal(s.access_control.session_policy.idle_minutes, config.SESSION_IDLE_MINUTES);
  assert.equal(s.access_control.lockout_policy.max_attempts, config.LOGIN_MAX_ATTEMPTS);

  // Audit stats are live (logins above already produced events).
  assert.ok(s.audit.total_events > 0);
  assert.equal(s.audit.append_only, true);

  // No backup has ever run on this machine → reported loudly, drill overdue.
  assert.equal(s.backups.configured, false);
  assert.equal(s.backups.restore_drill.last_passed_at, null);
  assert.equal(s.backups.restore_drill.interval_days, 90);
  assert.equal(s.backups.restore_drill.overdue, true);

  assert.equal(s.approved_vendors.length, 5);
  assert.ok((await auditRows(app.db, 'wisp.summary_exported')) >= 1);
});

test('WISP summary exports as markdown for the binder', async () => {
  const ceoToken = await loginToken(ceo);
  const res = await app.inject({
    method: 'GET', url: '/admin/wisp/security-summary?format=markdown',
    headers: { authorization: `Bearer ${ceoToken}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.headers['content-type'] as string, /text\/markdown/);
  assert.match(res.headers['content-disposition'] as string, /saos-security-summary-.*\.md/);
  assert.match(res.body, /# SAOS Security Summary \(WISP\)/);
  assert.match(res.body, /Synthetic Brian/);
  assert.match(res.body, /NEVER/); // restore drill never run
});

test('restore-drill reminder: nags once per quarter until a drill is recorded', async () => {
  // Never drilled (seed default null) → warning to the CEO role.
  const first = await runRestoreDrillReminderJob(app, '2026-07-06');
  assert.deepEqual(first, { skipped: false, reminded: true });
  assert.equal(await notificationCount('restore_drill_due'), 1);

  // Same date again → date-guarded.
  const rerun = await runRestoreDrillReminderJob(app, '2026-07-06');
  assert.equal(rerun.skipped, true);

  // Next day, same quarter → runs, but notifyOnce dedupes (no second nag).
  const nextDay = await runRestoreDrillReminderJob(app, '2026-07-07');
  assert.deepEqual(nextDay, { skipped: false, reminded: false });
  assert.equal(await notificationCount('restore_drill_due'), 1);

  // A NEW quarter with the drill still unrecorded → nags again.
  const newQuarter = await runRestoreDrillReminderJob(app, '2026-10-01');
  assert.deepEqual(newQuarter, { skipped: false, reminded: true });
  assert.equal(await notificationCount('restore_drill_due'), 2);

  // The quarterly task exists while overdue…
  const open = await app.db.query(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'restore_drill' AND status <> 'completed'`
  );
  assert.ok(open.rows[0].n >= 1, 'quarter drill task created for the CEO');

  // Recording a passing drill silences it AND auto-closes the open task —
  // recording the pass IS completing the work.
  await app.db.query(
    `UPDATE app_settings SET value = to_jsonb('2026-10-02T03:00:00Z'::text) WHERE key = 'ops.last_restore_drill_at'`
  );
  const afterDrill = await runRestoreDrillReminderJob(app, '2026-10-03');
  assert.deepEqual(afterDrill, { skipped: false, reminded: false });
  assert.equal(await notificationCount('restore_drill_due'), 2);
  const closed = await app.db.query(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'restore_drill' AND status <> 'completed'`
  );
  assert.equal(closed.rows[0].n, 0, 'drill tasks auto-closed on recorded pass');
});

test('backup staleness: silent while unconfigured, critical alert once stale', async () => {
  // No status.json → not configured → no alert (dev machines stay quiet).
  const unconfigured = await runBackupStaleCheckJob(app, '2026-07-06');
  assert.deepEqual(unconfigured, { skipped: false, stale: false });
  assert.equal(await notificationCount('backup_stale'), 0);

  // Fresh backup → still quiet.
  await writeFile(
    statusPath,
    JSON.stringify({
      last_backup_at: new Date().toISOString(),
      snapshot_id: 'abc123def456',
      repository_kind: 'local',
      retention: '14 daily / 8 weekly / 12 monthly',
      counts: { 'table:contacts': 3 },
    })
  );
  const fresh = await runBackupStaleCheckJob(app, '2026-07-07');
  assert.deepEqual(fresh, { skipped: false, stale: false });

  // 30h-old backup → critical alert to the CEO role; re-nags on a new day.
  await writeFile(
    statusPath,
    JSON.stringify({
      last_backup_at: new Date(Date.now() - 30 * 3_600_000).toISOString(),
      snapshot_id: 'abc123def456',
      repository_kind: 'local',
      retention: '14 daily / 8 weekly / 12 monthly',
    })
  );
  const stale = await runBackupStaleCheckJob(app, '2026-07-08');
  assert.deepEqual(stale, { skipped: false, stale: true });
  assert.equal(await notificationCount('backup_stale'), 1);
  const severity = await app.db.query<{ severity: string }>(
    `SELECT severity FROM notifications WHERE type = 'backup_stale' LIMIT 1`
  );
  assert.equal(severity.rows[0]!.severity, 'critical');

  const staleAgain = await runBackupStaleCheckJob(app, '2026-07-08');
  assert.equal(staleAgain.skipped, true, 'same-date rerun is guarded');
  const nextDay = await runBackupStaleCheckJob(app, '2026-07-09');
  assert.deepEqual(nextDay, { skipped: false, stale: true });
  assert.equal(await notificationCount('backup_stale'), 2, 'still-stale backups re-nag daily');

  // …and the WISP summary now reflects the (stale) backup.
  const ceoToken = await loginToken(ceo);
  const res = await app.inject({
    method: 'GET', url: '/admin/wisp/security-summary',
    headers: { authorization: `Bearer ${ceoToken}` },
  });
  const s = res.json();
  assert.equal(s.backups.configured, true);
  assert.equal(s.backups.snapshot_id, 'abc123def456');
  assert.equal(s.backups.stale, true);
});

test('Dubsado retirement: measured, not guessed — and alerts exactly once', async () => {
  // Nothing migrated has logged in and no close has run: silent, with progress
  // visible so the distance is a number rather than a feeling.
  const cold = await runDubsadoRetirementCheckJob(app, '2026-08-10');
  assert.equal(cold.skipped, false);
  assert.equal(cold.ready, false);
  assert.equal(cold.readiness.migratedLoggedIn, 0);
  assert.equal(cold.readiness.closesCompleted, 0);
  assert.equal(cold.alerted, false);
  assert.equal(await notificationCount('dubsado_retirement_ready'), 0);

  // Same date again → date-guarded.
  assert.equal((await runDubsadoRetirementCheckJob(app, '2026-08-10')).skipped, true);

  // Condition A only: the target number of MIGRATED clients logs in.
  // A native signup logging in must not count — it says nothing about whether
  // the old system can be switched off.
  const native = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, source)
     VALUES ('Synthetic', 'Native', 'native-retire@example.test', 'native') RETURNING id`
  );
  await app.db.query(
    `INSERT INTO audit_log (actor_type, actor_label, action, contact_id)
     VALUES ('client', 'Synthetic Native', 'portal.login', $1)`,
    [native.rows[0]!.id]
  );
  const migratedIds: string[] = [];
  for (let i = 0; i < MIGRATED_LOGIN_TARGET; i += 1) {
    const c = await app.db.query<{ id: string }>(
      `INSERT INTO contacts (first_name, last_name, email, source)
       VALUES ('Synthetic', $2, $1, 'dubsado') RETURNING id`,
      [`migrated-${i}@example.test`, `Migrated${i}`]
    );
    migratedIds.push(c.rows[0]!.id);
    // Two logins for one of them — DISTINCT contacts, not login events.
    await app.db.query(
      `INSERT INTO audit_log (actor_type, actor_label, action, contact_id)
       VALUES ('client', 'Synthetic Migrated', 'portal.login', $1)`,
      [c.rows[0]!.id]
    );
    if (i === 0) {
      await app.db.query(
        `INSERT INTO audit_log (actor_type, actor_label, action, contact_id)
         VALUES ('client', 'Synthetic Migrated', 'portal.login', $1)`,
        [c.rows[0]!.id]
      );
    }
  }

  const halfway = await runDubsadoRetirementCheckJob(app, '2026-08-11');
  assert.equal(halfway.readiness.migratedLoggedIn, MIGRATED_LOGIN_TARGET, 'counts contacts, not login rows');
  assert.equal(halfway.readiness.conditionA, true);
  assert.equal(halfway.readiness.conditionB, false);
  assert.equal(halfway.ready, false, 'both conditions or nothing');
  assert.equal(await notificationCount('dubsado_retirement_ready'), 0);

  // A close cycle that is still OPEN does not count either.
  await app.db.query(
    `INSERT INTO close_cycles (contact_id, cadence, period_start, period_end)
     VALUES ($1, 'monthly', '2026-07-01', '2026-07-31')`,
    [migratedIds[0]]
  );
  const stillOpen = await runDubsadoRetirementCheckJob(app, '2026-08-12');
  assert.equal(stillOpen.readiness.closesCompleted, 0, 'an unfinished close is not a close');
  assert.equal(stillOpen.ready, false);

  // Condition B lands: the close finishes.
  await app.db.query(
    `UPDATE close_cycles SET closed_at = now() WHERE contact_id = $1 AND period_start = '2026-07-01'`,
    [migratedIds[0]]
  );
  const ready = await runDubsadoRetirementCheckJob(app, '2026-08-13');
  assert.equal(ready.ready, true);
  assert.equal(ready.alerted, true);
  assert.equal(await notificationCount('dubsado_retirement_ready'), 1);

  const task = await app.db.query<{ title: string; description: string }>(
    `SELECT title, description FROM tasks WHERE source_type = 'dubsado_retirement'`
  );
  assert.equal(task.rows.length, 1);
  assert.match(task.rows[0]!.description, /export anything you still want/i, 'the task carries the pre-cancellation checklist');

  // Later days: still ready, but NO second alert and no duplicate task.
  const laterDay = await runDubsadoRetirementCheckJob(app, '2026-08-14');
  assert.equal(laterDay.ready, true);
  assert.equal(laterDay.alerted, false, 'once-ever, not a daily nag');
  assert.equal(await notificationCount('dubsado_retirement_ready'), 1);
  const tasksAgain = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'dubsado_retirement'`
  );
  assert.equal(tasksAgain.rows[0]!.n, 1);
});
