// M26 flow 6 (v4.3): grant vouchering tracker.
//
// STATUS TRACKING ONLY — the hard rule (CLAUDE.md): "Grant vouchering is
// status-tracking only — the system never generates voucher files; Brian
// operates the work outside the system." Nothing here produces a document,
// an export, or a funder submission. It produces REMINDERS and STATUS, so a
// period never quietly slips past its funder deadline.
//
// Each open period is a task (every work item is a task), and the T-7 funder
// deadline escalates. Reimbursed periods leave the board.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { firstActiveByRole, notifyOnce } from '../../staffing.ts';
import { closeTasksForSource, createTask } from '../tasks/service.ts';
import { daysBetween } from '../tax/deadlines.ts';

export type VoucherStatus = 'due' | 'in_progress' | 'submitted' | 'reimbursed';

export async function createVoucherPeriod(
  app: FastifyInstance,
  input: {
    grantId: string; periodLabel: string; periodStart?: string | null; periodEnd?: string | null;
    funderDueDate?: string | null; amountCents?: number | null; notes?: string | null;
  },
  actor: { id: string; email: string }
): Promise<{ id: string; created: boolean }> {
  const grant = await app.db.query<{ funder: string; lead_staff_id: string | null }>(
    `SELECT funder, lead_staff_id FROM grants_received WHERE id = $1`,
    [input.grantId]
  );
  if (!grant.rows[0]) throw new AppError(404, 'not_found', 'Grant not found.');

  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO grant_voucher_periods (grant_id, period_label, period_start, period_end, funder_due_date, amount_cents, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (grant_id, period_label) DO NOTHING
     RETURNING id`,
    [
      input.grantId, input.periodLabel, input.periodStart ?? null, input.periodEnd ?? null,
      input.funderDueDate ?? null, input.amountCents ?? null, input.notes ?? null,
    ]
  );
  if (!rows[0]) {
    const existing = await app.db.query<{ id: string }>(
      `SELECT id FROM grant_voucher_periods WHERE grant_id = $1 AND period_label = $2`,
      [input.grantId, input.periodLabel]
    );
    return { id: existing.rows[0]!.id, created: false };
  }
  const id = rows[0].id;

  // Brian operates vouchering, so the work item is his unless the grant has a
  // different lead.
  const owner = grant.rows[0].lead_staff_id ?? (await firstActiveByRole(app.db, 'ceo'));
  await createTask(app, {
    title: `Voucher: ${grant.rows[0].funder} — ${input.periodLabel}`,
    description:
      'Status tracking only — SAOS does not generate voucher files. Prepare and submit outside the system, then move the status here.' +
      (input.funderDueDate ? `\nFunder deadline: ${input.funderDueDate}.` : ''),
    assignedStaffId: owner,
    dueDate: input.funderDueDate ?? null,
    priority: 1,
    source: 'system',
    sourceType: 'voucher_period',
    sourceId: id,
  });
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'voucher_period.created', objectType: 'grant_voucher_period', objectId: id,
    details: { grant_id: input.grantId, period: input.periodLabel, funder_due_date: input.funderDueDate ?? null },
  });
  return { id, created: true };
}

export async function setVoucherStatus(
  app: FastifyInstance,
  id: string,
  status: VoucherStatus,
  actor: { id: string; email: string }
): Promise<void> {
  const existing = await app.db.query<{ status: VoucherStatus; grant_id: string }>(
    `SELECT status, grant_id FROM grant_voucher_periods WHERE id = $1`,
    [id]
  );
  if (!existing.rows[0]) throw new AppError(404, 'not_found', 'Voucher period not found.');

  await app.db.query(
    `UPDATE grant_voucher_periods
     SET status = $2::voucher_status,
         submitted_at  = CASE WHEN $2 IN ('submitted', 'reimbursed') THEN COALESCE(submitted_at, now()) ELSE submitted_at END,
         reimbursed_at = CASE WHEN $2 = 'reimbursed' THEN COALESCE(reimbursed_at, now()) ELSE reimbursed_at END
     WHERE id = $1`,
    [id, status]
  );
  // Reimbursed = the money landed = the work item is done.
  if (status === 'reimbursed') {
    await closeTasksForSource(app, 'voucher_period', id, 'voucher reimbursed');
  }
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'voucher_period.status_changed', objectType: 'grant_voucher_period', objectId: id,
    details: { from: existing.rows[0].status, to: status },
  });
}

/**
 * Daily, date-guarded: T-7 funder-deadline reminder on any period that is not
 * yet submitted, and an overdue alert once the funder date passes. Internal
 * only — a funder deadline is never a client-facing send, so no kill switch
 * applies here.
 */
export async function runVoucherReminderJob(
  app: FastifyInstance,
  today: string
): Promise<{ skipped: boolean; upcoming: number; overdue: number }> {
  const ACTION = 'job.voucher_reminders';
  const already = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = $1 AND details->>'run_date' = $2 LIMIT 1`,
    [ACTION, today]
  );
  if (already.rows.length > 0) return { skipped: true, upcoming: 0, overdue: 0 };

  const { rows } = await app.db.query<{
    id: string; period_label: string; funder_due_date: string; status: VoucherStatus;
    funder: string; lead_staff_id: string | null;
  }>(
    `SELECT v.id, v.period_label, v.funder_due_date::text AS funder_due_date, v.status,
            g.funder, g.lead_staff_id
     FROM grant_voucher_periods v
     JOIN grants_received g ON g.id = v.grant_id
     WHERE v.funder_due_date IS NOT NULL AND v.status IN ('due', 'in_progress')`
  );
  const brian = await firstActiveByRole(app.db, 'ceo');
  let upcoming = 0;
  let overdue = 0;

  for (const v of rows) {
    const owner = v.lead_staff_id ?? brian;
    if (!owner) continue;
    const daysLeft = daysBetween(today, v.funder_due_date);
    if (daysLeft < 0) {
      const fired = await notifyOnce(app.db, {
        staffId: owner,
        type: 'voucher_overdue',
        severity: 'critical',
        title: `Voucher PAST the funder deadline: ${v.funder} — ${v.period_label} (was ${v.funder_due_date})`,
        relatedObjectType: 'voucher_overdue',
        relatedObjectId: v.id,
      });
      if (fired) overdue++;
    } else if (daysLeft <= 7) {
      const fired = await notifyOnce(app.db, {
        staffId: owner,
        type: 'voucher_due_soon',
        severity: 'warning',
        title: `Voucher due ${v.funder_due_date} (${daysLeft}d): ${v.funder} — ${v.period_label}`,
        relatedObjectType: 'voucher_due_soon',
        relatedObjectId: v.id,
      });
      if (fired) upcoming++;
    }
  }

  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'daily-jobs',
    action: ACTION,
    details: { run_date: today, upcoming, overdue },
  });
  return { skipped: false, upcoming, overdue };
}

/** Dashboard tile + board: open periods by status, soonest funder date first. */
export async function voucherBoard(app: FastifyInstance) {
  const periods = await app.db.query(
    `SELECT v.id, v.period_label, v.funder_due_date::text AS funder_due_date, v.status,
            v.amount_cents, v.submitted_at, v.reimbursed_at,
            g.id AS grant_id, g.funder, g.program
     FROM grant_voucher_periods v
     JOIN grants_received g ON g.id = v.grant_id
     WHERE v.status <> 'reimbursed'
     ORDER BY v.funder_due_date NULLS LAST, g.funder`
  );
  const counts = await app.db.query<{ status: VoucherStatus; n: number }>(
    `SELECT status, count(*)::int AS n FROM grant_voucher_periods GROUP BY status`
  );
  return {
    periods: periods.rows,
    byStatus: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])),
  };
}
