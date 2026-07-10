// Unified task system (M25, spec v4.4) — the connective layer. EVERY work
// item in every module is a task object here (CLAUDE.md hard rule: no
// module-local to-do lists, ever). Notifications remain the ALERT channel;
// tasks are the WORK channel — approved design principle, 2026-07-07.
//
// createTask() is the one entry point modules call; closeTasksForSource()
// is the auto-close hook (a resolved notice, a decided referral, a filled
// enrichment gap closes its task without human bookkeeping).

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';

export interface CreateTaskInput {
  title: string;
  description?: string | null | undefined;
  assignedStaffId?: string | null | undefined;
  contactId?: string | null | undefined;
  engagementId?: string | null | undefined;
  dueDate?: string | null | undefined;      // YYYY-MM-DD
  priority?: number | undefined;            // 0 normal, 1 high, 2 urgent
  source?: 'manual' | 'meeting' | 'automation' | 'system' | 'import' | undefined;
  sourceType?: string | null | undefined;   // e.g. 'irs_notice', 'referral_approval'
  sourceId?: string | null | undefined;
  clientVisible?: boolean | undefined;
  sopLink?: string | null | undefined;
  createdByStaffId?: string | null | undefined;
  checklist?: string[] | undefined;
  boardColumnId?: string | null | undefined;
}

/**
 * Create a task, deduplicating on (source_type, source_id) for system work:
 * a job re-run or webhook replay never doubles a work item. Returns the
 * task id (existing OPEN task's id when deduped).
 */
export async function createTask(app: FastifyInstance, input: CreateTaskInput): Promise<{ id: string; created: boolean }> {
  if (input.sourceType && input.sourceId) {
    const existing = await app.db.query<{ id: string }>(
      `SELECT id FROM tasks
       WHERE source_type = $1 AND source_id = $2 AND status IN ('open', 'in_progress')
       LIMIT 1`,
      [input.sourceType, input.sourceId]
    );
    if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
  }

  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO tasks
       (title, description, assigned_staff_id, contact_id, engagement_id, due_date, priority,
        source, source_type, source_id, client_visible, sop_link, created_by_staff_id, board_column_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id`,
    [
      input.title, input.description ?? null, input.assignedStaffId ?? null, input.contactId ?? null,
      input.engagementId ?? null, input.dueDate ?? null, input.priority ?? 0,
      input.source ?? 'system', input.sourceType ?? null, input.sourceId ?? null,
      input.clientVisible ?? false, input.sopLink ?? null, input.createdByStaffId ?? null,
      input.boardColumnId ?? null,
    ]
  );
  const id = rows[0]!.id;
  for (const [i, label] of (input.checklist ?? []).entries()) {
    await app.db.query(
      `INSERT INTO task_checklist_items (task_id, label, position) VALUES ($1, $2, $3)`,
      [id, label, i]
    );
  }
  return { id, created: true };
}

/** Auto-close: the source object completed → its open task(s) close themselves. */
export async function closeTasksForSource(
  app: FastifyInstance,
  sourceType: string,
  sourceId: string,
  note?: string
): Promise<number> {
  const { rows } = await app.db.query<{ id: string }>(
    `UPDATE tasks SET status = 'done', completed_at = now(), updated_at = now()
     WHERE source_type = $1 AND source_id = $2 AND status IN ('open', 'in_progress')
     RETURNING id`,
    [sourceType, sourceId]
  );
  if (rows.length > 0 && note) {
    await writeAudit(app.db, {
      actorType: 'system', actorLabel: 'task-autoclose',
      action: 'task.auto_closed',
      details: { source_type: sourceType, source_id: sourceId, count: rows.length, note },
    });
  }
  return rows.length;
}

export type TaskStatus = 'open' | 'in_progress' | 'done' | 'cancelled';

export async function setTaskStatus(
  app: FastifyInstance,
  taskId: string,
  status: TaskStatus,
  actor: { id: string; email: string }
): Promise<void> {
  const res = await app.db.query(
    `UPDATE tasks SET status = $2::task_status,
            completed_at = CASE WHEN $2::text IN ('done', 'cancelled') THEN now() ELSE NULL END,
            updated_at = now()
     WHERE id = $1`,
    [taskId, status]
  );
  if (res.rowCount === 0) throw new AppError(404, 'not_found', 'Task not found.');
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'task.status_changed', objectType: 'task', objectId: taskId,
    details: { status },
  });
}

const TASK_SELECT = `
  SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date::text AS due_date,
         t.source, t.source_type, t.source_id, t.client_visible, t.sop_link,
         t.contact_id, t.engagement_id, t.board_column_id, t.board_position,
         t.created_at, t.completed_at,
         st.full_name AS assignee_name, t.assigned_staff_id,
         c.first_name || ' ' || c.last_name AS client_name,
         (SELECT count(*)::int FROM task_checklist_items i WHERE i.task_id = t.id) AS checklist_total,
         (SELECT count(*)::int FROM task_checklist_items i WHERE i.task_id = t.id AND i.done) AS checklist_done
  FROM tasks t
  LEFT JOIN staff st ON st.id = t.assigned_staff_id
  LEFT JOIN contacts c ON c.id = t.contact_id`;

/** My Tasks — one list per person across every module (v4.4 view #1). */
export async function myTasks(app: FastifyInstance, staffId: string, includeDone: boolean) {
  const { rows } = await app.db.query(
    `${TASK_SELECT}
     WHERE t.assigned_staff_id = $1 ${includeDone ? '' : `AND t.status IN ('open', 'in_progress')`}
     ORDER BY t.status, t.priority DESC, t.due_date NULLS LAST, t.created_at`,
    [staffId]
  );
  return rows;
}

/** Client-record tasks — all open/done work on one client (view #2). */
export async function clientTasks(app: FastifyInstance, contactId: string) {
  const { rows } = await app.db.query(
    `${TASK_SELECT} WHERE t.contact_id = $1
     ORDER BY (t.status IN ('open','in_progress')) DESC, t.priority DESC, t.due_date NULLS LAST, t.created_at DESC`,
    [contactId]
  );
  return rows;
}

/**
 * Owner rollup (view #3) — Brian's "needs you today": everything assigned to
 * him + approvals waiting + stalled/day-60/vouchers (those populate as the
 * M26 flows land; the shape is stable now).
 */
export async function ownerRollup(app: FastifyInstance, staffId: string) {
  const mine = await app.db.query(
    `${TASK_SELECT}
     WHERE t.assigned_staff_id = $1 AND t.status IN ('open', 'in_progress')
     ORDER BY t.priority DESC, t.due_date NULLS LAST, t.created_at`,
    [staffId]
  );
  const approvals = await app.db.query(
    `${TASK_SELECT}
     WHERE t.source_type IN ('referral_approval', 'extension_batch_review') AND t.status IN ('open', 'in_progress')
     ORDER BY t.created_at`
  );
  const counts = await app.db.query<{ stalled: number; day60: number; vouchers_due: number }>(
    `SELECT
       (SELECT count(*)::int FROM tasks WHERE source_type = 'stalled_flag'   AND status IN ('open','in_progress')) AS stalled,
       (SELECT count(*)::int FROM tasks WHERE source_type = 'deposit_day60'  AND status IN ('open','in_progress')) AS day60,
       (SELECT count(*)::int FROM tasks WHERE source_type = 'voucher_period' AND status IN ('open','in_progress')) AS vouchers_due`
  );
  return { mine: mine.rows, approvals: approvals.rows, ...counts.rows[0]! };
}

/** Team workload (view #4) — open tasks per person for balancing/coverage. */
export async function teamWorkload(app: FastifyInstance) {
  const { rows } = await app.db.query(
    `SELECT st.id, st.full_name, r.key AS role,
            count(t.id) FILTER (WHERE t.status = 'open')::int AS open,
            count(t.id) FILTER (WHERE t.status = 'in_progress')::int AS in_progress,
            count(t.id) FILTER (WHERE t.status IN ('open','in_progress') AND t.due_date < CURRENT_DATE)::int AS overdue
     FROM staff st
     JOIN roles r ON r.id = st.role_id
     LEFT JOIN tasks t ON t.assigned_staff_id = st.id
     WHERE st.is_active
     GROUP BY st.id, r.key
     ORDER BY count(t.id) FILTER (WHERE t.status IN ('open','in_progress')) DESC, st.full_name`
  );
  return rows;
}

/** Instantiate a checklist template (per client / per season — v4.4). */
export async function instantiateTemplate(
  app: FastifyInstance,
  templateId: string,
  opts: { contactId?: string | null; assignedStaffId?: string | null; dueDate?: string | null; actor: { id: string; email: string } }
): Promise<{ taskId: string }> {
  const tpl = await app.db.query<{ name: string; description: string | null; default_priority: number; sop_link: string | null; items: string[] }>(
    `SELECT name, description, default_priority, sop_link, items FROM task_templates WHERE id = $1`,
    [templateId]
  );
  if (!tpl.rows[0]) throw new AppError(404, 'not_found', 'Template not found.');
  const t = tpl.rows[0];
  const { id } = await createTask(app, {
    title: t.name,
    description: t.description,
    assignedStaffId: opts.assignedStaffId ?? null,
    contactId: opts.contactId ?? null,
    dueDate: opts.dueDate ?? null,
    priority: t.default_priority,
    source: 'manual',
    sopLink: t.sop_link,
    createdByStaffId: opts.actor.id,
    checklist: t.items,
  });
  await writeAudit(app.db, {
    actorType: 'staff', actorId: opts.actor.id, actorLabel: opts.actor.email,
    action: 'task.template_instantiated', objectType: 'task', objectId: id,
    details: { template_id: templateId },
  });
  return { taskId: id };
}
