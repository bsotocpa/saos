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
  clientTasks, createTask, instantiateTemplate, myTasks, ownerRollup, setTaskStatus, teamWorkload,
} from './service.ts';

const CreateBody = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  assignedStaffId: z.uuid().optional(),
  contactId: z.uuid().optional(),
  engagementId: z.uuid().optional(),
  dueDate: z.iso.date().optional(),
  priority: z.number().int().min(0).max(2).optional(),
  clientVisible: z.boolean().optional(),
  sopLink: z.string().optional(),
  checklist: z.array(z.string().min(1)).max(50).optional(),
  boardColumnId: z.uuid().optional(),
});

const StatusBody = z.object({ status: z.enum(['open', 'in_progress', 'done', 'cancelled']) });
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
