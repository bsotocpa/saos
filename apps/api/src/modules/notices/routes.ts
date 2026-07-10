import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { createIrsNotice, runNoticeEscalations } from './service.ts';
import { closeTasksForSource } from '../tasks/service.ts';

const CreateBody = z.object({
  contactId: z.uuid(),
  businessId: z.uuid().optional(),
  taxEngagementId: z.uuid().optional(),
  noticeType: z.string().min(1),         // admin-editable dropdown value, or free text ("Other")
  taxYear: z.number().int().optional(),
  noticeDate: z.iso.date().optional(),
  responseDeadline: z.iso.date().optional(),
  serviceTier: z.enum(['standard', 'premium']).optional(),
  amountCents: z.number().int().optional(),
  source: z.enum(['portal_upload', 'manual', 'mail', 'email']).optional(),
});

const UpdateBody = z.object({
  status: z.enum(['received', 'under_review', 'response_drafted', 'response_sent', 'resolved', 'escalated']).optional(),
  handlerStaffId: z.uuid().optional(),
  responseDeadline: z.iso.date().optional(),
  amountCents: z.number().int().optional(),
  resolutionNotes: z.string().optional(),
});

const ListQuery = z.object({
  status: z.enum(['received', 'under_review', 'response_drafted', 'response_sent', 'resolved', 'escalated']).optional(),
  handlerId: z.uuid().optional(),
});

export function registerNoticeRoutes(app: FastifyInstance): void {
  const manage = { preHandler: [app.authenticate, requirePermission('irs_notices.manage')] };

  app.post('/irs-notices', manage, async (request, reply) => {
    const b = CreateBody.parse(request.body);
    const result = await createIrsNotice(
      app,
      { type: 'staff', id: request.staff!.id, label: request.staff!.email },
      b
    );
    return reply.code(201).send(result);
  });

  app.get('/irs-notices', manage, async (request) => {
    const q = ListQuery.parse(request.query);
    const clauses: string[] = ['true'];
    const params: unknown[] = [];
    if (q.status) { params.push(q.status); clauses.push(`n.status = $${params.length}::notice_status`); }
    if (q.handlerId) { params.push(q.handlerId); clauses.push(`n.handler_staff_id = $${params.length}`); }
    const { rows } = await app.db.query(
      `SELECT n.id, n.notice_type, n.tax_year, n.notice_date, n.response_deadline, n.status,
              n.service_tier, n.amount_cents, n.handler_staff_id, n.first_actioned_at, n.escalated_at,
              n.received_at, c.id AS contact_id, c.first_name, c.last_name
       FROM irs_notices n JOIN contacts c ON c.id = n.contact_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY n.response_deadline NULLS LAST, n.received_at DESC
       LIMIT 200`,
      params
    );
    return { notices: rows };
  });

  app.patch<{ Params: { id: string } }>('/irs-notices/:id', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = UpdateBody.parse(request.body);
    const existing = await app.db.query<{ id: string; contact_id: string; first_actioned_at: Date | null }>(
      `SELECT id, contact_id, first_actioned_at FROM irs_notices WHERE id = $1`,
      [id]
    );
    if (!existing.rows[0]) throw new AppError(404, 'not_found', 'Notice not found.');

    const sets: string[] = [];
    const params: unknown[] = [id];
    if (b.status !== undefined) {
      params.push(b.status);
      sets.push(`status = $${params.length}::notice_status`);
      // First movement out of 'received' stamps first_actioned_at (48h SLA basis).
      if (b.status !== 'received' && existing.rows[0].first_actioned_at === null) {
        sets.push(`first_actioned_at = now()`);
      }
    }
    if (b.handlerStaffId !== undefined) { params.push(b.handlerStaffId); sets.push(`handler_staff_id = $${params.length}`); }
    if (b.responseDeadline !== undefined) { params.push(b.responseDeadline); sets.push(`response_deadline = $${params.length}`); }
    if (b.amountCents !== undefined) { params.push(b.amountCents); sets.push(`amount_cents = $${params.length}`); }
    if (b.resolutionNotes !== undefined) { params.push(b.resolutionNotes); sets.push(`resolution_notes = $${params.length}`); }
    if (sets.length === 0) throw new AppError(400, 'empty_update', 'No fields to update.');

    await app.db.query(`UPDATE irs_notices SET ${sets.join(', ')} WHERE id = $1`, params);
    // M25: resolving the notice closes its owned ticket-task automatically.
    if (b.status === 'resolved') {
      await closeTasksForSource(app, 'irs_notice', id, 'notice resolved');
    }
    await writeAudit(app.db, {
      actorType: 'staff', actorId: request.staff!.id, actorLabel: request.staff!.email,
      action: 'irs_notice.updated', objectType: 'irs_notice', objectId: id,
      contactId: existing.rows[0].contact_id,
      details: { fields: sets.map((s) => s.split(' =')[0]) },
    });
    return { status: 'ok' };
  });

  app.post('/jobs/notice-escalations', { preHandler: [app.authenticate, requirePermission('jobs.run')] }, async () => {
    return runNoticeEscalations(app);
  });
}
