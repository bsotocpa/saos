// Ops posture (M21): the WISP security summary export and the backup/restore
// watchdogs. The summary is LIVE data — MFA enrollment, audit statistics,
// backup recency — not a static document, so the written WISP can cite
// current facts whenever the IRS checklist or an insurer asks.

import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../../plugins/auth.ts';
import { writeAudit } from '../../audit.ts';
import { notifyOnce, ownerForRole } from '../../staffing.ts';
import { createTask } from '../tasks/service.ts';

/** Written by scripts/backup.sh — timestamps, snapshot id, counts. No client data. */
export interface BackupStatus {
  last_backup_at: string;
  snapshot_id: string;
  repository_kind: 'b2' | 'local';
  retention: string;
  duration_seconds?: number | undefined;
  counts?: Record<string, number> | undefined;
}

export async function readBackupStatus(path: string): Promise<BackupStatus | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const status = parsed as Partial<BackupStatus>;
    return typeof status.last_backup_at === 'string' && typeof status.snapshot_id === 'string'
      ? (status as BackupStatus)
      : null;
  } catch {
    return null; // no file yet = backups not configured on this machine
  }
}

// Approved external vendors (CLAUDE.md hard rule) — a truthful declaration
// for the WISP. Anything not on this list does not receive client data.
const VENDORS = [
  'Stripe — payment processing (card data never touches SAOS)',
  'Twilio — SMS/voice relay (Phase 2; no documents by SMS, ever)',
  'Amazon SES — outbound mail relay (routing metadata only)',
  'KBA vendor — 8879 remote-signature identity verification (selection pending; sandbox until then)',
  'Backblaze B2 — backup storage (receives restic ciphertext only)',
];

interface StaffRow {
  full_name: string;
  email: string;
  role: string;
  is_active: boolean;
  totp_enabled: boolean;
  last_login_at: string | null;
}

async function buildSummary(app: FastifyInstance) {
  const staff = await app.db.query<StaffRow>(
    `SELECT st.full_name, st.email, r.key AS role, st.is_active, st.totp_enabled,
            st.last_login_at::text AS last_login_at
     FROM staff st JOIN roles r ON r.id = st.role_id
     ORDER BY st.is_active DESC, st.full_name`
  );
  const active = staff.rows.filter((s) => s.is_active);

  const audit = await app.db.query<{
    total: string; recent: string; doc_access: string; permission_changes: string;
    oldest: string | null; newest: string | null;
  }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE occurred_at > now() - interval '30 days') AS recent,
            count(*) FILTER (WHERE action LIKE 'document.%' AND occurred_at > now() - interval '30 days') AS doc_access,
            count(*) FILTER (WHERE action = 'permission.change' AND occurred_at > now() - interval '30 days') AS permission_changes,
            min(occurred_at)::text AS oldest, max(occurred_at)::text AS newest
     FROM audit_log`
  );
  const a = audit.rows[0]!;

  const settings = await app.db.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM app_settings WHERE key IN ('ops.last_restore_drill_at', 'ops.restore_drill_interval_days')`
  );
  const lastDrill = settings.rows.find((s) => s.key === 'ops.last_restore_drill_at')?.value as string | null ?? null;
  const drillIntervalDays = Number(settings.rows.find((s) => s.key === 'ops.restore_drill_interval_days')?.value ?? 90);
  const drillAgeDays = lastDrill ? (Date.now() - Date.parse(lastDrill)) / 86_400_000 : Infinity;

  const backup = await readBackupStatus(app.config.BACKUP_STATUS_PATH);
  const backupAgeHours = backup ? (Date.now() - Date.parse(backup.last_backup_at)) / 3_600_000 : null;

  return {
    generated_at: new Date().toISOString(),
    environment: app.config.NODE_ENV,
    access_control: {
      staff: staff.rows,
      active_count: active.length,
      mfa_enrolled_count: active.filter((s) => s.totp_enabled).length,
      mfa_pending: active.filter((s) => !s.totp_enabled).map((s) => s.email),
      mfa_policy: 'TOTP required — no staff session exists until enrollment completes',
      session_policy: {
        idle_minutes: app.config.SESSION_IDLE_MINUTES,
        absolute_hours: app.config.SESSION_ABSOLUTE_HOURS,
      },
      lockout_policy: {
        max_attempts: app.config.LOGIN_MAX_ATTEMPTS,
        lockout_minutes: app.config.LOGIN_LOCKOUT_MINUTES,
      },
      client_auth: 'single-use expiring magic links; every portal query scoped to the signed-in contact',
    },
    audit: {
      total_events: Number(a.total),
      events_30d: Number(a.recent),
      document_access_30d: Number(a.doc_access),
      permission_changes_30d: Number(a.permission_changes),
      oldest_event_at: a.oldest,
      newest_event_at: a.newest,
      append_only: true,
    },
    encryption: {
      field_level: 'AES-256-GCM for SSNs and TOTP secrets (APP_ENCRYPTION_KEY)',
      in_transit: 'TLS terminated at the reverse proxy (M23); MinIO and Postgres never exposed publicly',
      backups: 'restic client-side encryption — storage vendor sees ciphertext only',
      at_rest: 'encrypted volume on the production host (M23)',
    },
    backups: {
      configured: backup !== null,
      last_backup_at: backup?.last_backup_at ?? null,
      snapshot_id: backup?.snapshot_id ?? null,
      repository_kind: backup?.repository_kind ?? null,
      retention: backup?.retention ?? null,
      stale: backupAgeHours !== null && backupAgeHours > 26,
      restore_drill: {
        last_passed_at: lastDrill,
        interval_days: drillIntervalDays,
        overdue: drillAgeDays > drillIntervalDays,
      },
    },
    approved_vendors: VENDORS,
    storage: 'self-hosted PostgreSQL + MinIO; documents move by portal only — never SMS or email attachments',
  };
}

type Summary = Awaited<ReturnType<typeof buildSummary>>;

function toMarkdown(s: Summary): string {
  const staffLines = s.access_control.staff
    .map(
      (m) =>
        `| ${m.full_name} | ${m.role} | ${m.is_active ? 'active' : 'inactive'} | ${m.totp_enabled ? 'enrolled' : 'PENDING'} | ${m.last_login_at ?? '—'} |`
    )
    .join('\n');
  const drill = s.backups.restore_drill;
  return `# SAOS Security Summary (WISP)

Generated ${s.generated_at} · environment: ${s.environment}

## Access control
- MFA policy: ${s.access_control.mfa_policy}
- Active staff: ${s.access_control.active_count} (${s.access_control.mfa_enrolled_count} MFA-enrolled${s.access_control.mfa_pending.length > 0 ? `; pending: ${s.access_control.mfa_pending.join(', ')}` : ''})
- Sessions: ${s.access_control.session_policy.idle_minutes}m idle window, ${s.access_control.session_policy.absolute_hours}h absolute lifetime
- Lockout: ${s.access_control.lockout_policy.max_attempts} failed attempts → ${s.access_control.lockout_policy.lockout_minutes}m lock
- Client auth: ${s.access_control.client_auth}

| Staff | Role | Status | MFA | Last login |
|---|---|---|---|---|
${staffLines}

## Audit trail (append-only)
- Total events: ${s.audit.total_events} (${s.audit.events_30d} in the last 30 days)
- Document access events, 30d: ${s.audit.document_access_30d}
- Permission changes, 30d: ${s.audit.permission_changes_30d}
- Coverage: ${s.audit.oldest_event_at ?? '—'} → ${s.audit.newest_event_at ?? '—'}

## Encryption
- Field level: ${s.encryption.field_level}
- In transit: ${s.encryption.in_transit}
- Backups: ${s.encryption.backups}
- At rest: ${s.encryption.at_rest}

## Backups & recovery
- Configured on this machine: ${s.backups.configured ? 'yes' : 'NO — scripts/backup.sh has not run here'}
- Last backup: ${s.backups.last_backup_at ?? '—'}${s.backups.stale ? ' **(STALE — over 26h old)**' : ''}
- Snapshot: ${s.backups.snapshot_id ?? '—'} · repository: ${s.backups.repository_kind ?? '—'} · retention: ${s.backups.retention ?? '—'}
- Last passing restore drill: ${drill.last_passed_at ?? 'NEVER'} (cadence: every ${drill.interval_days} days)${drill.overdue ? ' **(OVERDUE)**' : ''}

## Approved external vendors
${s.approved_vendors.map((v) => `- ${v}`).join('\n')}

## Storage
${s.storage}
`;
}

export function registerOpsRoutes(app: FastifyInstance): void {
  const admin = { preHandler: [app.authenticate, requirePermission('admin.settings')] };

  app.get<{ Querystring: { format?: string } }>('/admin/wisp/security-summary', admin, async (request, reply) => {
    const summary = await buildSummary(app);
    const actor = request.staff!;
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
      action: 'wisp.summary_exported',
      details: { format: request.query.format === 'markdown' ? 'markdown' : 'json' },
    });
    if (request.query.format === 'markdown') {
      return reply
        .type('text/markdown; charset=utf-8')
        .header('content-disposition', `attachment; filename="saos-security-summary-${summary.generated_at.slice(0, 10)}.md"`)
        .send(toMarkdown(summary));
    }
    return summary;
  });
}

/** Daily: nag Brian when the quarterly restore drill is overdue (WISP). */
export async function runRestoreDrillReminderJob(
  app: FastifyInstance,
  today: string
): Promise<{ skipped: boolean; reminded: boolean }> {
  const ACTION = 'job.restore_drill_reminder';
  const already = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = $1 AND details->>'run_date' = $2 LIMIT 1`,
    [ACTION, today]
  );
  if (already.rows.length > 0) return { skipped: true, reminded: false };

  const settings = await app.db.query<{ key: string; value: unknown }>(
    `SELECT key, value FROM app_settings WHERE key IN ('ops.last_restore_drill_at', 'ops.restore_drill_interval_days')`
  );
  const lastDrill = settings.rows.find((s) => s.key === 'ops.last_restore_drill_at')?.value as string | null ?? null;
  const intervalDays = Number(settings.rows.find((s) => s.key === 'ops.restore_drill_interval_days')?.value ?? 90);
  const ageDays = lastDrill ? (Date.parse(`${today}T00:00:00Z`) - Date.parse(lastDrill)) / 86_400_000 : Infinity;

  let reminded = false;
  if (ageDays > intervalDays) {
    const ceo = await ownerForRole(app.db, 'ceo');
    // One reminder per quarter (dedupe key), not one per day. Declared out here because both
    // the task and the alert key off it, and the task is no longer inside the alert's guard.
    const quarter = `${today.slice(0, 4)}-Q${Math.ceil(Number(today.slice(5, 7)) / 3)}`;
    /*
     * THE TASK IS UNCONDITIONAL; only the ALERT is gated (Brian's rule, 2026-08-17).
     *
     * Both sat inside `if (ceo)`. Unproven backups with nobody on staff produced no task and
     * no record — and this is the drill that exists because backups nobody has restored are
     * not backups. An unassigned task in the queue is visible; a skipped one never was.
     */
    await createTask(app, {
      title: `Run the quarterly restore drill (${quarter})`,
      description: 'scripts/restore-drill.sh — record the pass in Admin → Settings → ops.last_restore_drill_at. Procedure: RUNBOOK_OPS.md.',
      assignedStaffId: ceo,
      priority: 1,
      source: 'system',
      sourceType: 'restore_drill',
      sourceId: quarter,
    });
    if (ceo) {
      reminded = await notifyOnce(app.db, {
        staffId: ceo,
        type: 'restore_drill_due',
        severity: 'warning',
        title:
          lastDrill === null
            ? 'Restore drill has NEVER run — backups are unproven. Run scripts/restore-drill.sh (see RUNBOOK_OPS.md).'
            : `Quarterly restore drill overdue (last passed ${lastDrill.slice(0, 10)}). Run scripts/restore-drill.sh.`,
        relatedObjectType: 'ops_quarter',
        relatedObjectId: quarter,
      });
    }
  } else {
    // Drill is current → any open drill task (this quarter's or a stale
    // earlier one) auto-closes; recording the pass IS completing the work.
    const closed = await app.db.query<{ id: string }>(
      `UPDATE tasks SET status = 'completed', completed_at = now(), updated_at = now()
       WHERE source_type = 'restore_drill' AND status = ANY($1::task_status[])
       RETURNING id`,
      [['not_started', 'in_progress', 'waiting_for_input', 'deferred']]
    );
    if (closed.rows.length > 0) {
      await writeAudit(app.db, {
        actorType: 'system', actorLabel: 'daily-jobs',
        action: 'task.auto_closed',
        details: { source_type: 'restore_drill', count: closed.rows.length, note: `drill recorded ${lastDrill}` },
      });
    }
  }

  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'daily-jobs',
    action: ACTION,
    details: { run_date: today, overdue: ageDays > intervalDays, reminded },
  });
  return { skipped: false, reminded };
}

/** Daily: once backups exist on this machine, a >26h gap is a critical alert. */
export async function runBackupStaleCheckJob(
  app: FastifyInstance,
  today: string
): Promise<{ skipped: boolean; stale: boolean }> {
  const ACTION = 'job.backup_stale_check';
  const already = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = $1 AND details->>'run_date' = $2 LIMIT 1`,
    [ACTION, today]
  );
  if (already.rows.length > 0) return { skipped: true, stale: false };

  const status = await readBackupStatus(app.config.BACKUP_STATUS_PATH);
  // No status file = backups not configured here (dev boxes). The WISP
  // summary reports that loudly; alerting would just be daily dev noise.
  let stale = false;
  if (status) {
    stale = Date.now() - Date.parse(status.last_backup_at) > 26 * 3_600_000;
    if (stale) {
      const ceo = await ownerForRole(app.db, 'ceo');
      /*
       * THE TASK IS UNCONDITIONAL; only the ALERT is gated (Brian's rule, 2026-08-17).
       *
       * M25: one open work item until fixed (dedupe on a stable source id). It sat inside
       * `if (ceo)`, so a stale backup with nobody on staff left no work item — and a stale
       * backup is the thing this whole job exists to make impossible to miss.
       */
      await createTask(app, {
        title: 'Fix the stale nightly backup',
        description: `Last snapshot ${status.last_backup_at}. Check /etc/cron.d/saos-backup and /var/log/saos-backup.log on the server.`,
        assignedStaffId: ceo,
        priority: 2,
        source: 'system',
        sourceType: 'backup_stale',
        sourceId: 'backup-stale', // stable: re-opens only after the last one closes
      });
      if (ceo) {
        await notifyOnce(app.db, {
          staffId: ceo,
          type: 'backup_stale',
          severity: 'critical',
          title: `Nightly backup is stale — last snapshot ${status.last_backup_at}. Check the cron + scripts/backup.sh log.`,
          relatedObjectType: 'ops_date',
          relatedObjectId: today, // re-nags daily until fixed
        });
      }
    }
  }

  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'daily-jobs',
    action: ACTION,
    details: { run_date: today, configured: status !== null, stale },
  });
  return { skipped: false, stale };
}
