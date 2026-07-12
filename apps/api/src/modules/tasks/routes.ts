// Unified task system routes (M25): views, CRUD, comments, checklists,
// kanban boards, templates, and the lightweight time log. Staff-wide read
// (tasks are the team's shared work surface); mutation needs tasks.manage
// or ownership of the assignment.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import {
  addTaskDependency, clientTasks, createTask, instantiateTemplate, myTasks, ownerRollup,
  removeTaskDependency, searchTasks, setTaskStatus, TASK_SELECT, teamWorkload,
} from './service.ts';
import type { TaskFilters, TaskStatus } from './service.ts';

const StatusEnum = z.enum(['not_started', 'in_progress', 'waiting_for_input', 'completed', 'deferred', 'cancelled']);
const RecurEnum = z.enum(['daily', 'weekly', 'monthly', 'quarterly', 'annually', 'custom']);

const CreateBody = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  assignedStaffId: z.uuid().optional(),
  contactId: z.uuid().optional(),
  businessId: z.uuid().optional(),
  engagementId: z.uuid().optional(),
  dueDate: z.iso.date().optional(),
  priority: z.number().int().min(0).max(2).optional(),
  status: StatusEnum.optional(),
  clientVisible: z.boolean().optional(),
  sopLink: z.string().optional(),
  checklist: z.array(z.string().min(1)).max(50).optional(),
  boardColumnId: z.uuid().optional(),
  tags: z.array(z.string().min(1)).max(20).optional(),
  remindAt: z.iso.datetime({ offset: true }).optional(),
  recurFreq: RecurEnum.optional(),
  recurInterval: z.number().int().min(1).max(365).optional(),
});

const StatusBody = z.object({ status: StatusEnum });

// The filter rail: every param optional, all combinable (v4.5).
const csv = <T extends string>(allowed: readonly T[]) =>
  z.string().transform((s) => s.split(',').filter((v): v is T => (allowed as readonly string[]).includes(v))).optional();
const boolParam = z.enum(['true', 'false']).transform((v) => v === 'true').optional();
const SearchQuery = z.object({
  q: z.string().max(200).optional(),
  status: csv(StatusEnum.options),
  priority: z.string().transform((s) => s.split(',').map(Number).filter((n) => n >= 0 && n <= 2)).optional(),
  assignee: z.uuid().optional(),
  unassigned: boolParam,
  contactId: z.uuid().optional(),
  businessId: z.uuid().optional(),
  tag: z.string().max(50).optional(),
  sourceType: z.string().max(50).optional(),
  clientVisible: boolParam,
  dueFrom: z.iso.date().optional(),
  dueTo: z.iso.date().optional(),
  overdue: boolParam,
  dueToday: boolParam,
  dueThisWeek: boolParam,
  createdBy: z.uuid().optional(),
  delegatedBy: z.uuid().optional(),
  untouchedDays: z.coerce.number().int().min(1).max(365).optional(),
  includeDone: boolParam,
  sortField: z.enum(['due_date', 'priority', 'status', 'title', 'created_at', 'updated_at', 'assignee', 'client']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

// Inline edit (list-view cell edits + the full edit form). Status changes go
// through /tasks/:id/status only — that route owns ladder + recurrence logic.
const PatchBody = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  assignedStaffId: z.uuid().nullable().optional(),
  contactId: z.uuid().nullable().optional(),
  businessId: z.uuid().nullable().optional(),
  engagementId: z.uuid().nullable().optional(),
  dueDate: z.iso.date().nullable().optional(),
  priority: z.number().int().min(0).max(2).optional(),
  clientVisible: z.boolean().optional(),
  sopLink: z.string().nullable().optional(),
  tags: z.array(z.string().min(1)).max(20).optional(),
  remindAt: z.iso.datetime({ offset: true }).nullable().optional(),
  recurFreq: RecurEnum.nullable().optional(),
  recurInterval: z.number().int().min(1).max(365).optional(),
});

const BulkBody = z.object({
  ids: z.array(z.uuid()).min(1).max(200),
  set: z.object({
    status: StatusEnum.optional(),
    assignedStaffId: z.uuid().nullable().optional(),
    priority: z.number().int().min(0).max(2).optional(),
    dueDate: z.iso.date().nullable().optional(),
    addTags: z.array(z.string().min(1)).max(10).optional(),
    removeTags: z.array(z.string().min(1)).max(10).optional(),
  }),
});

const FollowUpBody = z.object({
  title: z.string().min(1).optional(),
  dueDate: z.iso.date().optional(),
});

const ViewBody = z.object({
  name: z.string().min(1).max(100),
  shared: z.boolean().optional(),
  viewType: z.enum(['list', 'kanban', 'calendar', 'timeline']).optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
  sort: z.record(z.string(), z.unknown()).optional(),
  columns: z.array(z.string()).max(30).optional(),
  groupBy: z.string().max(50).nullable().optional(),
});

const CommentBody = z.object({ body: z.string().min(1) });
const ChecklistBody = z.object({ label: z.string().min(1) });
const ChecklistToggleBody = z.object({ done: z.boolean() });
const MoveBody = z.object({ boardColumnId: z.uuid().nullable(), position: z.number().int().min(0).optional() });
const BoardBody = z.object({ name: z.string().min(1), personal: z.boolean().optional() });
const ColumnBody = z.object({ name: z.string().min(1), position: z.number().int().min(0).optional() });
const TemplateBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  defaultPriority: z.number().int().min(0).max(2).optional(),
  sopLink: z.string().optional(),
  items: z.array(z.string().min(1)).max(100).optional(),
});
const InstantiateBody = z.object({
  contactId: z.uuid().optional(),
  assignedStaffId: z.uuid().optional(),
  dueDate: z.iso.date().optional(),
});
const TimeBody = z.object({
  taskId: z.uuid().optional(),
  engagementId: z.uuid().optional(),
  contactId: z.uuid().optional(),
  hours: z.number().positive().max(24),
  entryDate: z.iso.date().optional(),
  rateItemCode: z.string().optional(), // price-book item — billing pulls the rate
  isProBono: z.boolean().optional(),
  notes: z.string().optional(),
});

export function registerTaskRoutes(app: FastifyInstance): void {
  const read = { preHandler: [app.authenticate, requirePermission('tasks.read')] };
  const manage = { preHandler: [app.authenticate, requirePermission('tasks.manage')] };

  // ── views ──────────────────────────────────────────────────────────────────
  app.get('/tasks/mine', read, async (request) => {
    const q = z.object({ includeDone: z.enum(['true', 'false']).optional() }).parse(request.query);
    return { tasks: await myTasks(app, request.staff!.id, q.includeDone === 'true') };
  });

  app.get<{ Params: { contactId: string } }>('/contacts/:contactId/tasks', read, async (request) => {
    return { tasks: await clientTasks(app, z.uuid().parse(request.params.contactId)) };
  });

  app.get('/tasks/rollup', read, async (request) => ownerRollup(app, request.staff!.id));

  app.get('/tasks/workload', read, async () => ({ workload: await teamWorkload(app) }));

  // The filter rail behind every view (list/kanban/calendar/timeline all
  // query here; saved views replay their stored filters through it).
  app.get('/tasks/search', read, async (request) => {
    const q = SearchQuery.parse(request.query);
    const filters: TaskFilters = {
      q: q.q, status: q.status as TaskStatus[] | undefined, priority: q.priority,
      assignedStaffId: q.assignee, unassigned: q.unassigned,
      contactId: q.contactId, businessId: q.businessId, tag: q.tag, sourceType: q.sourceType,
      clientVisible: q.clientVisible, dueFrom: q.dueFrom, dueTo: q.dueTo,
      overdue: q.overdue, dueToday: q.dueToday, dueThisWeek: q.dueThisWeek,
      createdBy: q.createdBy, delegatedBy: q.delegatedBy, untouchedDays: q.untouchedDays,
      includeDone: q.includeDone || Boolean(q.status?.some((s) => s === 'completed' || s === 'cancelled')),
      sortField: q.sortField, sortDir: q.sortDir, limit: q.limit,
    };
    return { tasks: await searchTasks(app, filters) };
  });

  // v4.5 editable page layout: the create/edit form renders from this setting.
  // Editing it is the admin-settings PATCH (the "Edit Page Layout" affordance).
  app.get('/tasks/layout', read, async () => {
    const { rows } = await app.db.query<{ value: unknown }>(
      `SELECT value FROM app_settings WHERE key = 'tasks.layout'`
    );
    return { layout: rows[0]?.value ?? null };
  });

  // ── saved views (private or shared) ───────────────────────────────────────
  app.get('/task-views', read, async (request) => {
    const { rows } = await app.db.query(
      `SELECT v.id, v.name, v.owner_staff_id, v.shared, v.view_type, v.filters, v.sort, v.columns, v.group_by,
              st.full_name AS owner_name
       FROM task_views v JOIN staff st ON st.id = v.owner_staff_id
       WHERE v.owner_staff_id = $1 OR v.shared
       ORDER BY v.owner_staff_id = $1 DESC, v.name`,
      [request.staff!.id]
    );
    return { views: rows };
  });

  app.post('/task-views', read, async (request, reply) => {
    const b = ViewBody.parse(request.body);
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO task_views (name, owner_staff_id, shared, view_type, filters, sort, columns, group_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8) RETURNING id`,
      [
        b.name, request.staff!.id, b.shared ?? false, b.viewType ?? 'list',
        JSON.stringify(b.filters ?? {}), JSON.stringify(b.sort ?? {}), JSON.stringify(b.columns ?? []),
        b.groupBy ?? null,
      ]
    );
    return reply.code(201).send({ id: rows[0]!.id });
  });

  app.patch<{ Params: { id: string } }>('/task-views/:id', read, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = ViewBody.partial().parse(request.body);
    const res = await app.db.query(
      `UPDATE task_views SET
         name = COALESCE($3, name), shared = COALESCE($4, shared), view_type = COALESCE($5, view_type),
         filters = COALESCE($6::jsonb, filters), sort = COALESCE($7::jsonb, sort),
         columns = COALESCE($8::jsonb, columns),
         group_by = CASE WHEN $9 THEN $10 ELSE group_by END,
         updated_at = now()
       WHERE id = $1 AND owner_staff_id = $2`,
      [
        id, request.staff!.id, b.name ?? null, b.shared ?? null, b.viewType ?? null,
        b.filters ? JSON.stringify(b.filters) : null, b.sort ? JSON.stringify(b.sort) : null,
        b.columns ? JSON.stringify(b.columns) : null,
        b.groupBy !== undefined, b.groupBy ?? null,
      ]
    );
    if (res.rowCount === 0) throw new AppError(404, 'not_found', 'View not found (only the owner can edit a view).');
    return { status: 'ok' };
  });

  app.delete<{ Params: { id: string } }>('/task-views/:id', read, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const res = await app.db.query(`DELETE FROM task_views WHERE id = $1 AND owner_staff_id = $2`, [id, request.staff!.id]);
    if (res.rowCount === 0) throw new AppError(404, 'not_found', 'View not found (only the owner can delete a view).');
    return { status: 'ok' };
  });

  // ── task CRUD ──────────────────────────────────────────────────────────────
  app.post('/tasks', manage, async (request, reply) => {
    const b = CreateBody.parse(request.body);
    const actor = request.staff!;
    const { id } = await createTask(app, {
      ...b,
      source: 'manual',
      createdByStaffId: actor.id,
      assignedStaffId: b.assignedStaffId ?? actor.id, // default: yours
    });
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
      action: 'task.created', objectType: 'task', objectId: id,
      contactId: b.contactId ?? null,
      details: { client_visible: b.clientVisible ?? false },
    });
    return reply.code(201).send({ id });
  });

  app.get<{ Params: { id: string } }>('/tasks/:id', read, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const { rows } = await app.db.query(`${TASK_SELECT} WHERE t.id = $1`, [id]);
    if (!rows[0]) throw new AppError(404, 'not_found', 'Task not found.');
    return { task: rows[0] };
  });

  // Inline edit — every field except status (that route owns ladder/recurrence).
  app.patch<{ Params: { id: string } }>('/tasks/:id', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = PatchBody.parse(request.body);
    const sets: string[] = [];
    const params: unknown[] = [id];
    const map: Record<string, unknown> = {
      title: b.title, description: b.description, assigned_staff_id: b.assignedStaffId,
      contact_id: b.contactId, business_id: b.businessId, engagement_id: b.engagementId,
      due_date: b.dueDate, priority: b.priority, client_visible: b.clientVisible,
      sop_link: b.sopLink, tags: b.tags, recur_interval: b.recurInterval,
    };
    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) { params.push(val); sets.push(`${col} = $${params.length}`); }
    }
    if (b.remindAt !== undefined) {
      params.push(b.remindAt);
      sets.push(`remind_at = $${params.length}`, `reminded_at = NULL`); // re-arm the reminder
    }
    if (b.recurFreq !== undefined) { params.push(b.recurFreq); sets.push(`recur_freq = $${params.length}`); }
    // Becoming client-visible arms the ladder clock (matches createTask).
    if (b.clientVisible === true) sets.push(`waiting_since = COALESCE(waiting_since, now())`);
    if (sets.length === 0) throw new AppError(400, 'empty_update', 'No fields to update.');
    const res = await app.db.query(`UPDATE tasks SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    if (res.rowCount === 0) throw new AppError(404, 'not_found', 'Task not found.');
    await writeAudit(app.db, {
      actorType: 'staff', actorId: request.staff!.id, actorLabel: request.staff!.email,
      action: 'task.updated', objectType: 'task', objectId: id,
      details: { fields: Object.keys(b) },
    });
    return { status: 'ok' };
  });

  // ── dependencies (v4.6: "blocked by") ──────────────────────────────────────
  app.get<{ Params: { id: string } }>('/tasks/:id/dependencies', read, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const blockers = await app.db.query(
      `SELECT bt.id, bt.title, bt.status FROM task_dependencies d
       JOIN tasks bt ON bt.id = d.blocker_task_id WHERE d.blocked_task_id = $1 ORDER BY bt.created_at`,
      [id]
    );
    const blocking = await app.db.query(
      `SELECT t.id, t.title, t.status FROM task_dependencies d
       JOIN tasks t ON t.id = d.blocked_task_id WHERE d.blocker_task_id = $1 ORDER BY t.created_at`,
      [id]
    );
    return { blockers: blockers.rows, blocking: blocking.rows };
  });

  app.post<{ Params: { id: string } }>('/tasks/:id/dependencies', manage, async (request, reply) => {
    const id = z.uuid().parse(request.params.id);
    const b = z.object({ blockerTaskId: z.uuid() }).parse(request.body);
    await addTaskDependency(app, id, b.blockerTaskId, request.staff!);
    return reply.code(201).send({ status: 'ok' });
  });

  app.delete<{ Params: { id: string; blockerId: string } }>('/tasks/:id/dependencies/:blockerId', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const blockerId = z.uuid().parse(request.params.blockerId);
    await removeTaskDependency(app, id, blockerId, request.staff!);
    return { status: 'ok' };
  });

  // Bulk operations (list-view multi-select). Status changes route through
  // setTaskStatus one-by-one so ladder + recurrence + blocked semantics hold;
  // a blocked task is SKIPPED (reported), never silently completed.
  app.post('/tasks/bulk', manage, async (request) => {
    const b = BulkBody.parse(request.body);
    const actor = request.staff!;
    let updated = 0;
    let blocked = 0;
    if (b.set.status) {
      for (const id of b.ids) {
        try {
          await setTaskStatus(app, id, b.set.status, actor);
          updated++;
        } catch (err) {
          if ((err as { code?: string }).code === 'task_blocked') blocked++;
          else throw err;
        }
      }
    }
    const sets: string[] = [];
    const params: unknown[] = [b.ids];
    if (b.set.assignedStaffId !== undefined) { params.push(b.set.assignedStaffId); sets.push(`assigned_staff_id = $${params.length}`); }
    if (b.set.priority !== undefined) { params.push(b.set.priority); sets.push(`priority = $${params.length}`); }
    if (b.set.dueDate !== undefined) { params.push(b.set.dueDate); sets.push(`due_date = $${params.length}`); }
    if (b.set.addTags?.length || b.set.removeTags?.length) {
      // One combined assignment — Postgres refuses two SETs on the same column.
      params.push(b.set.addTags ?? []);
      const add = params.length;
      params.push(b.set.removeTags ?? []);
      sets.push(`tags = (SELECT COALESCE(array_agg(DISTINCT x), '{}') FROM unnest(tags || $${add}::text[]) x WHERE x <> ALL($${params.length}::text[]))`);
    }
    if (sets.length > 0) {
      const res = await app.db.query(
        `UPDATE tasks SET ${sets.join(', ')}, updated_at = now() WHERE id = ANY($1::uuid[])`,
        params
      );
      updated = Math.max(updated, res.rowCount ?? 0);
    }
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
      action: 'task.bulk_updated',
      details: { count: b.ids.length, set: Object.keys(b.set), blocked },
    });
    return { updated, blocked };
  });

  app.post<{ Params: { id: string } }>('/tasks/:id/duplicate', manage, async (request, reply) => {
    const id = z.uuid().parse(request.params.id);
    const { rows } = await app.db.query<{
      title: string; description: string | null; assigned_staff_id: string | null;
      contact_id: string | null; business_id: string | null; engagement_id: string | null;
      due_date: string | null; priority: number; client_visible: boolean; sop_link: string | null;
      tags: string[]; recur_freq: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annually' | 'custom' | null;
      recur_interval: number; board_column_id: string | null;
    }>(
      `SELECT title, description, assigned_staff_id, contact_id, business_id, engagement_id,
              due_date::text AS due_date, priority, client_visible, sop_link, tags,
              recur_freq, recur_interval, board_column_id
       FROM tasks WHERE id = $1`,
      [id]
    );
    const t = rows[0];
    if (!t) throw new AppError(404, 'not_found', 'Task not found.');
    // No sourceType/sourceId copy: the duplicate is its own manual work item.
    const created = await createTask(app, {
      title: t.title, description: t.description, assignedStaffId: t.assigned_staff_id,
      contactId: t.contact_id, businessId: t.business_id, engagementId: t.engagement_id,
      dueDate: t.due_date, priority: t.priority, clientVisible: t.client_visible,
      sopLink: t.sop_link, tags: t.tags, recurFreq: t.recur_freq, recurInterval: t.recur_interval,
      boardColumnId: t.board_column_id, parentTaskId: id,
      source: 'manual', createdByStaffId: request.staff!.id,
    });
    return reply.code(201).send({ id: created.id });
  });

  app.post<{ Params: { id: string } }>('/tasks/:id/follow-up', manage, async (request, reply) => {
    const id = z.uuid().parse(request.params.id);
    const b = FollowUpBody.parse(request.body ?? {});
    const { rows } = await app.db.query<{ title: string; contact_id: string | null; business_id: string | null; engagement_id: string | null }>(
      `SELECT title, contact_id, business_id, engagement_id FROM tasks WHERE id = $1`,
      [id]
    );
    const t = rows[0];
    if (!t) throw new AppError(404, 'not_found', 'Task not found.');
    const created = await createTask(app, {
      title: b.title ?? `Follow up: ${t.title}`,
      contactId: t.contact_id, businessId: t.business_id, engagementId: t.engagement_id,
      dueDate: b.dueDate ?? null,
      parentTaskId: id,
      source: 'manual', createdByStaffId: request.staff!.id, assignedStaffId: request.staff!.id,
    });
    return reply.code(201).send({ id: created.id });
  });

  // Status changes: managers freely; interns (tasks.execute) only on tasks
  // assigned to THEM — the spec's "task execution" scope.
  app.patch<{ Params: { id: string } }>('/tasks/:id/status', { preHandler: [app.authenticate] }, async (request, reply) => {
    const id = z.uuid().parse(request.params.id);
    const b = StatusBody.parse(request.body);
    const staff = request.staff!;
    const canManage = staff.permissions.includes('*') || staff.permissions.includes('tasks.manage');
    if (!canManage) {
      if (!staff.permissions.includes('tasks.execute')) {
        return reply.code(403).send({ error: 'forbidden', permission: 'tasks.manage' });
      }
      const own = await app.db.query(`SELECT 1 FROM tasks WHERE id = $1 AND assigned_staff_id = $2`, [id, staff.id]);
      if (own.rows.length === 0) {
        return reply.code(403).send({ error: 'forbidden', message: 'tasks.execute covers only tasks assigned to you.' });
      }
    }
    await setTaskStatus(app, id, b.status, staff);
    return { status: 'ok' };
  });

  app.post<{ Params: { id: string } }>('/tasks/:id/comments', manage, async (request, reply) => {
    const id = z.uuid().parse(request.params.id);
    const b = CommentBody.parse(request.body);
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO task_comments (task_id, staff_id, body) VALUES ($1, $2, $3) RETURNING id`,
      [id, request.staff!.id, b.body]
    );
    return reply.code(201).send({ id: rows[0]!.id });
  });

  app.get<{ Params: { id: string } }>('/tasks/:id/comments', read, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const { rows } = await app.db.query(
      `SELECT tc.id, tc.body, tc.created_at, st.full_name AS author
       FROM task_comments tc JOIN staff st ON st.id = tc.staff_id
       WHERE tc.task_id = $1 ORDER BY tc.created_at`,
      [id]
    );
    return { comments: rows };
  });

  app.post<{ Params: { id: string } }>('/tasks/:id/checklist', manage, async (request, reply) => {
    const id = z.uuid().parse(request.params.id);
    const b = ChecklistBody.parse(request.body);
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO task_checklist_items (task_id, label, position)
       SELECT $1, $2, COALESCE(max(position) + 1, 0) FROM task_checklist_items WHERE task_id = $1
       RETURNING id`,
      [id, b.label]
    );
    return reply.code(201).send({ id: rows[0]!.id });
  });

  app.get<{ Params: { id: string } }>('/tasks/:id/checklist', read, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const { rows } = await app.db.query(
      `SELECT id, label, done, position FROM task_checklist_items WHERE task_id = $1 ORDER BY position`,
      [id]
    );
    return { items: rows };
  });

  app.patch<{ Params: { id: string; itemId: string } }>('/tasks/:id/checklist/:itemId', manage, async (request) => {
    const itemId = z.uuid().parse(request.params.itemId);
    const b = ChecklistToggleBody.parse(request.body);
    const res = await app.db.query(`UPDATE task_checklist_items SET done = $2 WHERE id = $1`, [itemId, b.done]);
    if (res.rowCount === 0) throw new AppError(404, 'not_found', 'Checklist item not found.');
    return { status: 'ok' };
  });

  // ── boards (kanban) ────────────────────────────────────────────────────────
  app.get('/boards', read, async (request) => {
    const { rows } = await app.db.query(
      `SELECT b.id, b.name, b.owner_staff_id, st.full_name AS owner_name
       FROM boards b LEFT JOIN staff st ON st.id = b.owner_staff_id
       WHERE b.owner_staff_id IS NULL OR b.owner_staff_id = $1
       ORDER BY b.owner_staff_id NULLS FIRST, b.name`,
      [request.staff!.id]
    );
    return { boards: rows };
  });

  app.post('/boards', manage, async (request, reply) => {
    const b = BoardBody.parse(request.body);
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO boards (name, owner_staff_id) VALUES ($1, $2) RETURNING id`,
      [b.name, b.personal ? request.staff!.id : null]
    );
    const boardId = rows[0]!.id;
    // Sensible default columns; fully editable after.
    for (const [i, name] of ['To do', 'Doing', 'Done'].entries()) {
      await app.db.query(`INSERT INTO board_columns (board_id, name, position) VALUES ($1, $2, $3)`, [boardId, name, i]);
    }
    return reply.code(201).send({ id: boardId });
  });

  app.get<{ Params: { id: string } }>('/boards/:id', read, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const columns = await app.db.query(
      `SELECT id, name, position FROM board_columns WHERE board_id = $1 ORDER BY position`,
      [id]
    );
    const tasks = await app.db.query(
      `SELECT t.id, t.title, t.status, t.priority, t.due_date::text AS due_date, t.board_column_id,
              t.board_position, st.full_name AS assignee_name
       FROM tasks t LEFT JOIN staff st ON st.id = t.assigned_staff_id
       WHERE t.board_column_id IN (SELECT id FROM board_columns WHERE board_id = $1)
       ORDER BY t.board_position NULLS LAST, t.created_at`,
      [id]
    );
    return { columns: columns.rows, tasks: tasks.rows };
  });

  app.post<{ Params: { id: string } }>('/boards/:id/columns', manage, async (request, reply) => {
    const id = z.uuid().parse(request.params.id);
    const b = ColumnBody.parse(request.body);
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO board_columns (board_id, name, position)
       SELECT $1, $2, COALESCE($3, (SELECT COALESCE(max(position) + 1, 0) FROM board_columns WHERE board_id = $1))
       RETURNING id`,
      [id, b.name, b.position ?? null]
    );
    return reply.code(201).send({ id: rows[0]!.id });
  });

  app.patch<{ Params: { id: string } }>('/tasks/:id/move', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = MoveBody.parse(request.body);
    const res = await app.db.query(
      `UPDATE tasks SET board_column_id = $2, board_position = $3, updated_at = now() WHERE id = $1`,
      [id, b.boardColumnId, b.position ?? 0]
    );
    if (res.rowCount === 0) throw new AppError(404, 'not_found', 'Task not found.');
    return { status: 'ok' };
  });

  // ── checklist templates ────────────────────────────────────────────────────
  app.get('/task-templates', read, async () => {
    const { rows } = await app.db.query(
      `SELECT id, name, description, default_priority, sop_link, items FROM task_templates ORDER BY name`
    );
    return { templates: rows };
  });

  app.post('/task-templates', manage, async (request, reply) => {
    const b = TemplateBody.parse(request.body);
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO task_templates (name, description, default_priority, sop_link, items)
       VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
      [b.name, b.description ?? null, b.defaultPriority ?? 0, b.sopLink ?? null, JSON.stringify(b.items ?? [])]
    );
    return reply.code(201).send({ id: rows[0]!.id });
  });

  app.post<{ Params: { id: string } }>('/task-templates/:id/instantiate', manage, async (request, reply) => {
    const id = z.uuid().parse(request.params.id);
    const b = InstantiateBody.parse(request.body);
    const result = await instantiateTemplate(app, id, {
      contactId: b.contactId ?? null,
      assignedStaffId: b.assignedStaffId ?? request.staff!.id,
      dueDate: b.dueDate ?? null,
      actor: request.staff!,
    });
    return reply.code(201).send(result);
  });

  // ── lightweight time log ───────────────────────────────────────────────────
  app.post('/time-entries', manage, async (request, reply) => {
    const b = TimeBody.parse(request.body);
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO time_entries (staff_id, contact_id, task_id, engagement_id, hours, entry_date, rate_item_code, is_pro_bono, notes)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_DATE), $7, $8, $9) RETURNING id`,
      [
        request.staff!.id, b.contactId ?? null, b.taskId ?? null, b.engagementId ?? null,
        b.hours, b.entryDate ?? null, b.rateItemCode ?? null, b.isProBono ?? false, b.notes ?? null,
      ]
    );
    return reply.code(201).send({ id: rows[0]!.id });
  });

  app.post<{ Params: { id: string } }>('/tasks/:id/timer/start', manage, async (request, reply) => {
    const id = z.uuid().parse(request.params.id);
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO time_entries (staff_id, task_id, contact_id, hours, started_at, status, notes)
       SELECT $1, t.id, t.contact_id, 0.01, now(), 'suggested', 'timer running'
       FROM tasks t WHERE t.id = $2
       RETURNING id`,
      [request.staff!.id, id]
    );
    if (!rows[0]) throw new AppError(404, 'not_found', 'Task not found.');
    return reply.code(201).send({ timerId: rows[0].id });
  });

  app.post<{ Params: { id: string } }>('/time-entries/:id/stop', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const { rows } = await app.db.query<{ id: string; hours: string }>(
      `UPDATE time_entries
       SET hours = GREATEST(0.25, ROUND(EXTRACT(EPOCH FROM (now() - started_at)) / 3600.0 * 4) / 4.0),
           started_at = NULL, status = 'confirmed', notes = NULL, updated_at = now()
       WHERE id = $1 AND staff_id = $2 AND started_at IS NOT NULL
       RETURNING id, hours::text`,
      [id, request.staff!.id]
    );
    if (!rows[0]) throw new AppError(404, 'not_found', 'No running timer with that id.');
    return { id: rows[0].id, hours: Number(rows[0].hours) };
  });
}
