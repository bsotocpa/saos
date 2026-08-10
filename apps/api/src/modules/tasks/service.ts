// Unified task system (M25, revised to the v4.5 UX spec — Zoho parity; the
// screenshots in docs/reference are the benchmark). EVERY work item in every
// module is a task object here (CLAUDE.md hard rule). Notifications remain
// the ALERT channel; tasks are the WORK channel.
//
// v4.5 status set: not_started · in_progress · waiting_for_input ·
// completed · deferred ('cancelled' kept as an internal terminal state).
// "Waiting for input" is load-bearing: entering it stamps waiting_since and
// the D3/D7/D14/D30 escalation ladder self-chases the client (runLadderJob).

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { isAutomationEnabled } from '../../automations.ts';
import { AppError } from '../../types.ts';
import { firstActiveByRole, notifyOnce } from '../../staffing.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { sendSms } from '../comms/send-sms.ts';
import { addDays, daysBetween } from '../tax/deadlines.ts';
import { sopLinkForTaskType } from '../sops/service.ts';

export type TaskStatus = 'not_started' | 'in_progress' | 'waiting_for_input' | 'completed' | 'deferred' | 'cancelled';
/** Non-terminal statuses — what "open work" means across every view/query. */
export const OPEN_STATUSES: TaskStatus[] = ['not_started', 'in_progress', 'waiting_for_input', 'deferred'];
export type RecurFreq = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annually' | 'custom';

export interface CreateTaskInput {
  title: string;
  description?: string | null | undefined;
  assignedStaffId?: string | null | undefined;
  contactId?: string | null | undefined;
  businessId?: string | null | undefined;   // v4.5: independent second lookup
  engagementId?: string | null | undefined;
  dueDate?: string | null | undefined;
  priority?: number | undefined;            // 0 low/normal, 1 high, 2 urgent
  source?: 'manual' | 'meeting' | 'automation' | 'system' | 'import' | undefined;
  sourceType?: string | null | undefined;
  sourceId?: string | null | undefined;
  clientVisible?: boolean | undefined;
  sopLink?: string | null | undefined;
  createdByStaffId?: string | null | undefined;
  checklist?: string[] | undefined;
  boardColumnId?: string | null | undefined;
  tags?: string[] | undefined;
  remindAt?: string | null | undefined;     // ISO timestamp
  recurFreq?: RecurFreq | null | undefined;
  recurInterval?: number | undefined;
  parentTaskId?: string | null | undefined;
  status?: TaskStatus | undefined;
}

/**
 * The one entry point. Dedupes on (source_type, source_id) across open
 * statuses so job re-runs and webhook replays never double a work item.
 */
export async function createTask(app: FastifyInstance, input: CreateTaskInput): Promise<{ id: string; created: boolean }> {
  if (input.sourceType && input.sourceId) {
    const existing = await app.db.query<{ id: string }>(
      `SELECT id FROM tasks
       WHERE source_type = $1 AND source_id = $2 AND status = ANY($3::task_status[])
       LIMIT 1`,
      [input.sourceType, input.sourceId, OPEN_STATUSES]
    );
    if (existing.rows[0]) return { id: existing.rows[0].id, created: false };
  }

  const status = input.status ?? 'not_started';
  // Client-visible items are waiting-on-client by nature: the ladder clocks
  // from creation (v4.4: client to-dos drive the D3/D7/D14 ladder).
  const waitingSince = status === 'waiting_for_input' || input.clientVisible ? 'now()' : 'NULL';

  // M27: attach the "how to do this" link from the task-type registry when the
  // caller did not supply one. Resolved rather than typed, so a new hire opening
  // a task finds the procedure without anyone remembering to paste a URL — and
  // an unwritten SOP resolves to null rather than a dead link.
  const sopLink = input.sopLink ?? (await sopLinkForTaskType(app, input.sourceType));

  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO tasks
       (title, description, assigned_staff_id, contact_id, business_id, engagement_id, due_date, priority,
        source, source_type, source_id, client_visible, sop_link, created_by_staff_id, board_column_id,
        tags, remind_at, recur_freq, recur_interval, parent_task_id, status, waiting_since)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::task_status,${waitingSince})
     RETURNING id`,
    [
      input.title, input.description ?? null, input.assignedStaffId ?? null, input.contactId ?? null,
      input.businessId ?? null, input.engagementId ?? null, input.dueDate ?? null, input.priority ?? 0,
      input.source ?? 'system', input.sourceType ?? null, input.sourceId ?? null,
      input.clientVisible ?? false, sopLink, input.createdByStaffId ?? null,
      input.boardColumnId ?? null, input.tags ?? [], input.remindAt ?? null,
      input.recurFreq ?? null, input.recurInterval ?? 1, input.parentTaskId ?? null, status,
    ]
  );
  const id = rows[0]!.id;
  for (const [i, label] of (input.checklist ?? []).entries()) {
    await app.db.query(`INSERT INTO task_checklist_items (task_id, label, position) VALUES ($1, $2, $3)`, [id, label, i]);
  }
  return { id, created: true };
}

// ── v4.6: task dependencies ("blocked by") ───────────────────────────────────

const TERMINAL: TaskStatus[] = ['completed', 'cancelled'];

/** Blockers of `taskId` that are still open (what "blocked" means). */
export async function openBlockers(app: FastifyInstance, taskId: string): Promise<Array<{ id: string; title: string }>> {
  const { rows } = await app.db.query<{ id: string; title: string }>(
    `SELECT bt.id, bt.title
     FROM task_dependencies d JOIN tasks bt ON bt.id = d.blocker_task_id
     WHERE d.blocked_task_id = $1 AND NOT (bt.status = ANY($2::task_status[]))`,
    [taskId, TERMINAL]
  );
  return rows;
}

export async function addTaskDependency(
  app: FastifyInstance,
  blockedId: string,
  blockerId: string,
  actor: { id: string; email: string }
): Promise<void> {
  if (blockedId === blockerId) throw new AppError(400, 'self_dependency', 'A task cannot block itself.');
  const both = await app.db.query<{ id: string; status: TaskStatus }>(
    `SELECT id, status FROM tasks WHERE id = ANY($1::uuid[])`,
    [[blockedId, blockerId]]
  );
  if (both.rows.length !== 2) throw new AppError(404, 'not_found', 'Task not found.');
  const blocker = both.rows.find((r) => r.id === blockerId)!;
  if (TERMINAL.includes(blocker.status)) {
    throw new AppError(400, 'blocker_terminal', 'That task is already closed — nothing to wait on.');
  }
  // Cycle check: if the proposed blocker is itself (transitively) blocked by
  // the blocked task, this edge would close a loop nothing could ever finish.
  const cycle = await app.db.query(
    `WITH RECURSIVE chain AS (
       SELECT blocker_task_id FROM task_dependencies WHERE blocked_task_id = $1
       UNION
       SELECT td.blocker_task_id FROM task_dependencies td JOIN chain ON td.blocked_task_id = chain.blocker_task_id
     )
     SELECT 1 FROM chain WHERE blocker_task_id = $2 LIMIT 1`,
    [blockerId, blockedId]
  );
  if (cycle.rows.length > 0) throw new AppError(409, 'dependency_cycle', 'That would create a dependency loop.');

  await app.db.query(
    `INSERT INTO task_dependencies (blocked_task_id, blocker_task_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [blockedId, blockerId]
  );
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'task.dependency_added', objectType: 'task', objectId: blockedId,
    details: { blocker_task_id: blockerId },
  });
}

export async function removeTaskDependency(
  app: FastifyInstance,
  blockedId: string,
  blockerId: string,
  actor: { id: string; email: string }
): Promise<void> {
  const res = await app.db.query(
    `DELETE FROM task_dependencies WHERE blocked_task_id = $1 AND blocker_task_id = $2`,
    [blockedId, blockerId]
  );
  if (res.rowCount === 0) throw new AppError(404, 'not_found', 'Dependency not found.');
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'task.dependency_removed', objectType: 'task', objectId: blockedId,
    details: { blocker_task_id: blockerId },
  });
}

/**
 * A blocker reached a terminal state → any task it was blocking that has NO
 * remaining open blockers gets an unblock notification to its assignee
 * (v4.6: "completing a blocker cascades unblock notifications").
 */
export async function cascadeUnblock(app: FastifyInstance, blockerTaskId: string): Promise<number> {
  const { rows } = await app.db.query<{ id: string; title: string; assigned_staff_id: string | null; contact_id: string | null }>(
    `SELECT t.id, t.title, t.assigned_staff_id, t.contact_id
     FROM task_dependencies d
     JOIN tasks t ON t.id = d.blocked_task_id
     WHERE d.blocker_task_id = $1
       AND NOT (t.status = ANY($2::task_status[]))
       AND NOT EXISTS (
         SELECT 1 FROM task_dependencies d2
         JOIN tasks bt ON bt.id = d2.blocker_task_id
         WHERE d2.blocked_task_id = t.id AND bt.id <> $1 AND NOT (bt.status = ANY($2::task_status[]))
       )`,
    [blockerTaskId, TERMINAL]
  );
  for (const t of rows) {
    if (!t.assigned_staff_id) continue;
    await notifyOnce(app.db, {
      staffId: t.assigned_staff_id,
      type: 'task_unblocked',
      severity: 'info',
      title: `Unblocked: ${t.title}`,
      contactId: t.contact_id,
      relatedObjectType: 'task_unblocked',
      relatedObjectId: t.id,
    });
  }
  return rows.length;
}

/** Auto-close: the source object completed → its open task(s) close themselves. */
export async function closeTasksForSource(
  app: FastifyInstance,
  sourceType: string,
  sourceId: string,
  note?: string
): Promise<number> {
  // Deliberately unconditional on dependencies: auto-close means the SOURCE
  // work is objectively done (doc uploaded, notice resolved) — refusing here
  // would strand zombie tasks. Manual completion is where the block applies.
  const { rows } = await app.db.query<{ id: string }>(
    `UPDATE tasks SET status = 'completed', completed_at = now(), updated_at = now()
     WHERE source_type = $1 AND source_id = $2 AND status = ANY($3::task_status[])
     RETURNING id`,
    [sourceType, sourceId, OPEN_STATUSES]
  );
  for (const r of rows) await cascadeUnblock(app, r.id);
  if (rows.length > 0 && note) {
    await writeAudit(app.db, {
      actorType: 'system', actorLabel: 'task-autoclose',
      action: 'task.auto_closed',
      details: { source_type: sourceType, source_id: sourceId, count: rows.length, note },
    });
  }
  return rows.length;
}

/** Advance a YYYY-MM-DD date by one recurrence step. */
export function advanceDate(date: string, freq: RecurFreq, interval: number): string {
  const [y, m, d] = [Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10))];
  const clamp = (yy: number, mm: number, dd: number) => {
    const rolledY = yy + Math.floor((mm - 1) / 12);
    const rolledM = ((mm - 1) % 12) + 1;
    const last = new Date(Date.UTC(rolledY, rolledM, 0)).getUTCDate();
    return `${rolledY}-${String(rolledM).padStart(2, '0')}-${String(Math.min(dd, last)).padStart(2, '0')}`;
  };
  switch (freq) {
    case 'daily': return addDays(date, interval);
    case 'weekly': return addDays(date, 7 * interval);
    case 'monthly': return clamp(y, m + interval, d);
    case 'quarterly': return clamp(y, m + 3 * interval, d);
    case 'annually': return clamp(y + interval, m, d);
    case 'custom': return addDays(date, interval);
  }
}

export async function setTaskStatus(
  app: FastifyInstance,
  taskId: string,
  status: TaskStatus,
  actor: { id: string; email: string }
): Promise<void> {
  const { rows } = await app.db.query<{
    id: string; status: TaskStatus; title: string; description: string | null;
    assigned_staff_id: string | null; contact_id: string | null; business_id: string | null;
    engagement_id: string | null; due_date: string | null; priority: number; tags: string[];
    sop_link: string | null; client_visible: boolean; recur_freq: RecurFreq | null; recur_interval: number;
    source: 'manual' | 'meeting' | 'automation' | 'system' | 'import';
    source_type: string | null; board_column_id: string | null;
  }>(
    `SELECT id, status, title, description, assigned_staff_id, contact_id, business_id, engagement_id,
            due_date::text AS due_date, priority, tags, sop_link, client_visible, recur_freq, recur_interval,
            source, source_type, board_column_id
     FROM tasks WHERE id = $1`,
    [taskId]
  );
  const task = rows[0];
  if (!task) throw new AppError(404, 'not_found', 'Task not found.');

  // v4.6: a blocked task cannot complete before its blockers (hard rule).
  // Cancelling is allowed — abandoning work is not finishing it.
  if (status === 'completed' && task.status !== 'completed') {
    const blockers = await openBlockers(app, taskId);
    if (blockers.length > 0) {
      throw new AppError(
        409, 'task_blocked',
        `Blocked by ${blockers.length} open task${blockers.length === 1 ? '' : 's'}: ${blockers.map((b) => b.title).join('; ').slice(0, 200)}`
      );
    }
  }

  // v4.5: entering waiting_for_input arms the escalation ladder; leaving it
  // (the client responded / work resumed) disarms and resets the rung.
  const entersWaiting = status === 'waiting_for_input' && task.status !== 'waiting_for_input';
  const leavesWaiting = status !== 'waiting_for_input' && task.status === 'waiting_for_input';
  await app.db.query(
    `UPDATE tasks SET status = $2::task_status,
            completed_at = CASE WHEN $2::text IN ('completed', 'cancelled') THEN now() ELSE NULL END,
            waiting_since = CASE WHEN $3 THEN now() WHEN $4 THEN NULL ELSE waiting_since END,
            ladder_rung  = CASE WHEN $3 OR $4 THEN 0 ELSE ladder_rung END,
            updated_at = now()
     WHERE id = $1`,
    [taskId, status, entersWaiting, leavesWaiting]
  );

  // Recurrence: completing a repeating task spawns the next occurrence
  // (quarterly ST-1, monthly QBO edits, annual AG990 — the live patterns).
  if (status === 'completed' && task.recur_freq && task.status !== 'completed') {
    const baseDue = task.due_date ?? new Date().toISOString().slice(0, 10);
    await createTask(app, {
      title: task.title,
      description: task.description,
      assignedStaffId: task.assigned_staff_id,
      contactId: task.contact_id,
      businessId: task.business_id,
      engagementId: task.engagement_id,
      dueDate: advanceDate(baseDue, task.recur_freq, task.recur_interval),
      priority: task.priority,
      tags: task.tags,
      sopLink: task.sop_link,
      clientVisible: task.client_visible,
      recurFreq: task.recur_freq,
      recurInterval: task.recur_interval,
      parentTaskId: task.id,
      source: task.source,
      sourceType: task.source_type,
      boardColumnId: task.board_column_id,
      // sourceId deliberately NOT copied: each occurrence is its own work item.
    });
  }

  // v4.6: reaching a terminal state may unblock downstream tasks.
  if (TERMINAL.includes(status) && !TERMINAL.includes(task.status)) {
    await cascadeUnblock(app, taskId);
  }

  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'task.status_changed', objectType: 'task', objectId: taskId,
    contactId: task.contact_id,
    details: { status, from: task.status },
  });
}

// ── the filter engine (v4.5 filter rail — every field, system filters) ──────

export interface TaskFilters {
  q?: string | undefined;
  status?: TaskStatus[] | undefined;
  priority?: number[] | undefined;
  assignedStaffId?: string | undefined;
  unassigned?: boolean | undefined;
  contactId?: string | undefined;
  businessId?: string | undefined;
  tag?: string | undefined;
  sourceType?: string | undefined;
  clientVisible?: boolean | undefined;
  dueFrom?: string | undefined;
  dueTo?: string | undefined;
  overdue?: boolean | undefined;
  dueToday?: boolean | undefined;
  dueThisWeek?: boolean | undefined;
  createdBy?: string | undefined;
  delegatedBy?: string | undefined;      // created by X, assigned to someone else
  untouchedDays?: number | undefined;    // no update in N days
  includeDone?: boolean | undefined;
  sortField?: string | undefined;
  sortDir?: 'asc' | 'desc' | undefined;
  limit?: number | undefined;
}

const SORTABLE: Record<string, string> = {
  due_date: 't.due_date', priority: 't.priority', status: 't.status', title: 't.title',
  created_at: 't.created_at', updated_at: 't.updated_at', assignee: 'assignee_name', client: 'client_name',
};

export const TASK_SELECT = `
  SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date::text AS due_date,
         t.source, t.source_type, t.source_id, t.client_visible, t.sop_link, t.tags,
         t.contact_id, t.business_id, t.engagement_id, t.board_column_id, t.board_position,
         t.remind_at, t.recur_freq, t.recur_interval, t.parent_task_id,
         t.waiting_since, t.ladder_rung, t.created_at, t.updated_at, t.completed_at,
         st.full_name AS assignee_name, t.assigned_staff_id,
         cr.full_name AS created_by_name, t.created_by_staff_id,
         c.first_name || ' ' || c.last_name AS client_name,
         b.name AS business_name,
         (SELECT count(*)::int FROM task_checklist_items i WHERE i.task_id = t.id) AS checklist_total,
         (SELECT count(*)::int FROM task_checklist_items i WHERE i.task_id = t.id AND i.done) AS checklist_done,
         (SELECT count(*)::int FROM task_comments tc WHERE tc.task_id = t.id) AS comment_count,
         (SELECT count(*)::int FROM task_dependencies d JOIN tasks bt ON bt.id = d.blocker_task_id
          WHERE d.blocked_task_id = t.id AND bt.status NOT IN ('completed', 'cancelled')) AS open_blockers
  FROM tasks t
  LEFT JOIN staff st ON st.id = t.assigned_staff_id
  LEFT JOIN staff cr ON cr.id = t.created_by_staff_id
  LEFT JOIN contacts c ON c.id = t.contact_id
  LEFT JOIN businesses b ON b.id = t.business_id`;

export async function searchTasks(app: FastifyInstance, f: TaskFilters) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replaceAll('$$', `$${params.length}`));
  };

  if (!f.includeDone) add(`t.status = ANY($$::task_status[])`, f.status ?? OPEN_STATUSES);
  else if (f.status?.length) add(`t.status = ANY($$::task_status[])`, f.status);
  // replaceAll maps BOTH $$ placeholders to the same $N — one pushed param serves both ILIKEs.
  if (f.q) add(`(t.title ILIKE $$ OR t.description ILIKE $$)`, `%${f.q}%`);
  if (f.priority?.length) add(`t.priority = ANY($$::int[])`, f.priority);
  if (f.assignedStaffId) add(`t.assigned_staff_id = $$`, f.assignedStaffId);
  if (f.unassigned) where.push(`t.assigned_staff_id IS NULL`);
  if (f.contactId) add(`t.contact_id = $$`, f.contactId);
  if (f.businessId) add(`t.business_id = $$`, f.businessId);
  if (f.tag) add(`$$ = ANY(t.tags)`, f.tag);
  if (f.sourceType) add(`t.source_type = $$`, f.sourceType);
  if (f.clientVisible !== undefined) add(`t.client_visible = $$`, f.clientVisible);
  if (f.dueFrom) add(`t.due_date >= $$`, f.dueFrom);
  if (f.dueTo) add(`t.due_date <= $$`, f.dueTo);
  if (f.overdue) where.push(`t.due_date < CURRENT_DATE AND t.status <> 'completed' AND t.status <> 'cancelled'`);
  if (f.dueToday) where.push(`t.due_date = CURRENT_DATE`);
  if (f.dueThisWeek) where.push(`t.due_date >= CURRENT_DATE AND t.due_date < CURRENT_DATE + 7`);
  if (f.createdBy) add(`t.created_by_staff_id = $$`, f.createdBy);
  if (f.delegatedBy) {
    add(`t.created_by_staff_id = $$ AND t.assigned_staff_id IS DISTINCT FROM t.created_by_staff_id`, f.delegatedBy);
  }
  if (f.untouchedDays) add(`t.updated_at < now() - make_interval(days => $$)`, f.untouchedDays);

  const sortCol = SORTABLE[f.sortField ?? ''] ?? 't.priority';
  const sortDir = f.sortDir === 'asc' ? 'ASC' : 'DESC';
  const secondary = sortCol === 't.priority' ? ', t.due_date NULLS LAST, t.created_at' : ', t.created_at DESC';

  const { rows } = await app.db.query(
    `${TASK_SELECT}
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY ${sortCol} ${sortDir} NULLS LAST${secondary}
     LIMIT ${Math.min(Math.max(f.limit ?? 500, 1), 2000)}`,
    params
  );
  return rows;
}

// ── views (the four staff views ride searchTasks; these are the shortcuts) ──

export async function myTasks(app: FastifyInstance, staffId: string, includeDone: boolean) {
  return searchTasks(app, { assignedStaffId: staffId, includeDone, sortField: 'priority', limit: 1000 });
}

export async function clientTasks(app: FastifyInstance, contactId: string) {
  return searchTasks(app, { contactId, includeDone: true, sortField: 'updated_at', limit: 500 });
}

export async function ownerRollup(app: FastifyInstance, staffId: string) {
  const mine = await searchTasks(app, { assignedStaffId: staffId, sortField: 'priority', limit: 100 });
  const approvals = await app.db.query(
    `${TASK_SELECT}
     WHERE t.source_type IN ('referral_approval', 'extension_batch_review') AND t.status = ANY($1::task_status[])
     ORDER BY t.created_at`,
    [OPEN_STATUSES]
  );
  const counts = await app.db.query<{ stalled: number; day60: number; vouchers_due: number; waiting: number }>(
    `SELECT
       (SELECT count(*)::int FROM tasks WHERE source_type = 'stalled_flag'   AND status = ANY($1::task_status[])) AS stalled,
       (SELECT count(*)::int FROM tasks WHERE source_type = 'deposit_day60'  AND status = ANY($1::task_status[])) AS day60,
       (SELECT count(*)::int FROM tasks WHERE source_type = 'voucher_period' AND status = ANY($1::task_status[])) AS vouchers_due,
       (SELECT count(*)::int FROM tasks WHERE status = 'waiting_for_input') AS waiting`,
    [OPEN_STATUSES]
  );
  return { mine, approvals: approvals.rows, ...counts.rows[0]! };
}

export async function teamWorkload(app: FastifyInstance) {
  const { rows } = await app.db.query(
    `SELECT st.id, st.full_name, r.key AS role,
            count(t.id) FILTER (WHERE t.status = 'not_started')::int AS not_started,
            count(t.id) FILTER (WHERE t.status = 'in_progress')::int AS in_progress,
            count(t.id) FILTER (WHERE t.status = 'waiting_for_input')::int AS waiting,
            count(t.id) FILTER (WHERE t.status = 'deferred')::int AS deferred,
            count(t.id) FILTER (WHERE t.status = ANY($1::task_status[]) AND t.due_date < CURRENT_DATE)::int AS overdue
     FROM staff st
     JOIN roles r ON r.id = st.role_id
     LEFT JOIN tasks t ON t.assigned_staff_id = st.id
     WHERE st.is_active
     GROUP BY st.id, r.key
     ORDER BY count(t.id) FILTER (WHERE t.status = ANY($1::task_status[])) DESC, st.full_name`,
    [OPEN_STATUSES]
  );
  return rows;
}

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

// ── v4.5: the self-chasing "Waiting for input" ladder (D3/D7/D14/D30) ────────

interface LadderRow {
  id: string; title: string; contact_id: string; ladder_rung: number;
  waiting_days: number; first_name: string; last_name: string;
  email: string | null; language: 'en' | 'es'; sms_consent: boolean;
}

/**
 * Daily, date-guarded. Tasks waiting on a client (status waiting_for_input,
 * or open client-visible to-dos) climb the ladder from waiting_since:
 * D3 portal-reminder email → D7 SMS nudge (consent-gated; email fallback) →
 * D14 call task for Rene → D30 STALLED flag on the owner rollup.
 * Every rung is audited on the client record (v4.3 flow 3).
 */
export async function runLadderJob(
  app: FastifyInstance,
  today: string
): Promise<{ skipped: boolean; rungs: number[]; suppressed?: number }> {
  const ACTION = 'job.escalation_ladder';
  const already = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = $1 AND details->>'run_date' = $2 LIMIT 1`,
    [ACTION, today]
  );
  if (already.rows.length > 0) return { skipped: true, rungs: [] };

  // Kill switch: when disarmed, rungs DO NOT advance — otherwise arming it
  // later would fire every client straight to D30. Count what would have
  // gone out so the run record shows the pressure building.
  if (!(await isAutomationEnabled(app, 'escalation_ladder'))) {
    const waiting = await app.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tasks t
       WHERE t.waiting_since IS NOT NULL AND t.ladder_rung < 4
         AND (t.status = 'waiting_for_input' OR (t.client_visible AND t.status = ANY($1::task_status[])))`,
      [OPEN_STATUSES]
    );
    const suppressed = waiting.rows[0]!.n;
    await writeAudit(app.db, {
      actorType: 'system', actorLabel: 'daily-jobs',
      action: ACTION,
      details: { run_date: today, automation_disabled: true, suppressed },
    });
    return { skipped: false, rungs: [0, 0, 0, 0], suppressed };
  }

  const daysSetting = await app.db.query<{ value: number[] }>(
    `SELECT value FROM app_settings WHERE key = 'ladder.days'`
  );
  const [d3, d7, d14, d30] = (daysSetting.rows[0]?.value ?? [3, 7, 14, 30]) as [number, number, number, number];

  const { rows } = await app.db.query<LadderRow>(
    `SELECT t.id, t.title, t.contact_id, t.ladder_rung,
            (EXTRACT(EPOCH FROM (($2::date + time '12:00') - t.waiting_since)) / 86400)::int AS waiting_days,
            c.first_name, c.last_name, c.email, c.language, c.sms_consent
     FROM tasks t
     JOIN contacts c ON c.id = t.contact_id
     WHERE t.waiting_since IS NOT NULL
       AND (t.status = 'waiting_for_input' OR (t.client_visible AND t.status = ANY($1::task_status[])))
       AND t.ladder_rung < 4`,
    [OPEN_STATUSES, today]
  );

  const rungs = [0, 0, 0, 0];
  const rene = await firstActiveByRole(app.db, 'comms_billing');
  const brian = await firstActiveByRole(app.db, 'ceo');

  for (const t of rows) {
    let target = 0;
    if (t.waiting_days >= d30) target = 4;
    else if (t.waiting_days >= d14) target = 3;
    else if (t.waiting_days >= d7) target = 2;
    else if (t.waiting_days >= d3) target = 1;
    if (target <= t.ladder_rung) continue;

    // Fire only the HIGHEST newly-reached rung (a task discovered at D15
    // gets the call task, not three stale reminders).
    if (target === 1 && t.email) {
      await sendTemplatedEmail(app, {
        to: t.email, templateKey: 'ladder_portal_reminder', language: t.language,
        contactId: t.contact_id,
        vars: { first_name: t.first_name, item: t.title, portal_link: app.config.PORTAL_BASE_URL },
      });
    } else if (target === 2) {
      const sms = await sendSms(app, {
        contactId: t.contact_id,
        templateKey: 'ladder_sms_nudge',
        language: t.language,
        vars: { first_name: t.first_name, portal_link: app.config.PORTAL_BASE_URL },
      });
      if (!sms.sent && t.email) {
        await sendTemplatedEmail(app, {
          to: t.email, templateKey: 'ladder_portal_reminder', language: t.language,
          contactId: t.contact_id,
          vars: { first_name: t.first_name, item: t.title, portal_link: app.config.PORTAL_BASE_URL },
        });
      }
    } else if (target === 3 && rene) {
      await createTask(app, {
        title: `Call ${t.first_name} ${t.last_name} — waiting ${t.waiting_days} days: ${t.title}`,
        assignedStaffId: rene,
        contactId: t.contact_id,
        priority: 1,
        source: 'automation',
        sourceType: 'ladder_call',
        sourceId: t.id,
      });
    } else if (target === 4) {
      await createTask(app, {
        title: `STALLED (${t.waiting_days}d): ${t.first_name} ${t.last_name} — ${t.title}`,
        description: 'Day-30 rung: work is paused waiting on the client. Decide the path (rescue call, pause formally, or close).',
        assignedStaffId: brian,
        contactId: t.contact_id,
        priority: 2,
        source: 'automation',
        sourceType: 'stalled_flag',
        sourceId: t.id,
      });
    }

    await app.db.query(`UPDATE tasks SET ladder_rung = $2, updated_at = now() WHERE id = $1`, [t.id, target]);
    await writeAudit(app.db, {
      actorType: 'system', actorLabel: 'escalation-ladder',
      action: 'ladder.rung_fired', objectType: 'task', objectId: t.id, contactId: t.contact_id,
      details: { rung: target, waiting_days: t.waiting_days },
    });
    rungs[target - 1] = (rungs[target - 1] ?? 0) + 1;
  }

  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'daily-jobs',
    action: ACTION,
    details: { run_date: today, d3: rungs[0], d7: rungs[1], d14: rungs[2], d30: rungs[3] },
  });
  return { skipped: false, rungs };
}

/** Reminder sweep (every scheduler tick): due reminders → assignee alert. */
export async function runTaskReminderSweep(app: FastifyInstance): Promise<{ reminded: number }> {
  const { rows } = await app.db.query<{ id: string; title: string; assigned_staff_id: string; contact_id: string | null }>(
    `UPDATE tasks SET reminded_at = now()
     WHERE remind_at IS NOT NULL AND reminded_at IS NULL AND remind_at <= now()
       AND assigned_staff_id IS NOT NULL AND status = ANY($1::task_status[])
     RETURNING id, title, assigned_staff_id, contact_id`,
    [OPEN_STATUSES]
  );
  for (const t of rows) {
    await notifyOnce(app.db, {
      staffId: t.assigned_staff_id,
      type: 'task_reminder',
      severity: 'info',
      title: `Reminder: ${t.title}`,
      contactId: t.contact_id,
      relatedObjectType: 'task_reminder',
      relatedObjectId: t.id,
    });
  }
  return { reminded: rows.length };
}
