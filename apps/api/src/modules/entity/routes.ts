import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { todayChicago } from '../tax/deadlines.ts';
import { createPllcConversion, nextAnnualReportDueDate, runEntityComplianceJob } from './service.ts';

const CreateComplianceBody = z.object({
  businessId: z.uuid(),
  state: z.string().length(2).optional(),
  formationDate: z.iso.date().optional(),
  annualReportDueDate: z.iso.date().optional(), // manual override; otherwise derived per state rule
  assignedStaffId: z.uuid().optional(),
});

const FiledBody = z.object({ filedDate: z.iso.date() });

const CreatePllcBody = z.object({
  contactId: z.uuid(),
  businessId: z.uuid().optional(),
  licenseType: z.string().min(1),
  currentEntityType: z.enum(['sole_prop', 'llc', 'pllc', 's_corp', 'c_corp', 'partnership', 'nonprofit', 'coop', 'not_sure', 'other']).optional(),
  detectedVia: z.string().optional(),
});

const UpdatePllcBody = z.object({
  status: z.enum(['flagged', 'client_notified', 'advisory_scheduled', 'in_progress', 'filed', 'completed', 'dismissed']).optional(),
  licenseVerified: z.boolean().optional(),
  checklist: z.array(z.object({ item: z.string(), done: z.boolean() })).optional(),
  notes: z.string().optional(),
});

export function registerEntityRoutes(app: FastifyInstance): void {
  const manage = { preHandler: [app.authenticate, requirePermission('entity.manage')] };

  app.post('/entity-compliance', manage, async (request, reply) => {
    const b = CreateComplianceBody.parse(request.body);
    const biz = await app.db.query<{ id: string; state: string }>(
      `SELECT id, state FROM businesses WHERE id = $1`,
      [b.businessId]
    );
    if (!biz.rows[0]) throw new AppError(404, 'not_found', 'Business not found.');
    const state = b.state ?? biz.rows[0].state ?? 'IL';
    const due =
      b.annualReportDueDate ??
      (b.formationDate ? nextAnnualReportDueDate(state, b.formationDate, todayChicago()) : null);

    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO entity_compliance (business_id, assigned_staff_id, state, formation_date, annual_report_due_date, status)
       VALUES ($1, $2, $3, $4, $5, 'unknown') RETURNING id`,
      [b.businessId, b.assignedStaffId ?? null, state, b.formationDate ?? null, due]
    );
    return reply.code(201).send({ id: rows[0]!.id, annualReportDueDate: due });
  });

  app.get('/entity-compliance', manage, async () => {
    const { rows } = await app.db.query(
      `SELECT ec.id, ec.state, ec.formation_date, ec.annual_report_due_date, ec.status,
              ec.last_filed_date, ec.assigned_staff_id, b.id AS business_id, b.name AS business_name
       FROM entity_compliance ec JOIN businesses b ON b.id = ec.business_id
       ORDER BY ec.annual_report_due_date NULLS LAST`
    );
    return { records: rows };
  });

  // Filed → history row + roll the due date to the next period.
  app.post<{ Params: { id: string } }>('/entity-compliance/:id/filed', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = FiledBody.parse(request.body);
    const { rows } = await app.db.query<{
      id: string; state: string; formation_date: string | null; annual_report_due_date: string | null;
    }>(
      `SELECT id, state, formation_date::text AS formation_date, annual_report_due_date::text AS annual_report_due_date
       FROM entity_compliance WHERE id = $1`,
      [id]
    );
    const rec = rows[0];
    if (!rec) throw new AppError(404, 'not_found', 'Compliance record not found.');
    if (!rec.annual_report_due_date) throw new AppError(400, 'no_due_date', 'No annual report due date on record.');

    const periodYear = Number(rec.annual_report_due_date.slice(0, 4));
    await app.db.query(
      `INSERT INTO annual_report_filings (entity_compliance_id, period_year, due_date, filed_date, status)
       VALUES ($1, $2, $3, $4, 'filed')
       ON CONFLICT (entity_compliance_id, period_year)
       DO UPDATE SET filed_date = EXCLUDED.filed_date, status = 'filed'`,
      [id, periodYear, rec.annual_report_due_date, b.filedDate]
    );
    const anchor = rec.formation_date ?? rec.annual_report_due_date;
    const nextDue = nextAnnualReportDueDate(rec.state, anchor, rec.annual_report_due_date);
    await app.db.query(
      `UPDATE entity_compliance
       SET last_filed_date = $2, annual_report_due_date = $3, status = 'filed'
       WHERE id = $1`,
      [id, b.filedDate, nextDue]
    );
    await writeAudit(app.db, {
      actorType: 'staff', actorId: request.staff!.id, actorLabel: request.staff!.email,
      action: 'annual_report.filed', objectType: 'entity_compliance', objectId: id,
      details: { period_year: periodYear, next_due: nextDue },
    });
    return { status: 'ok', nextDueDate: nextDue };
  });

  // ── PLLC conversions (v4.2 new service line) ────────────────────────────
  app.post('/pllc-conversions', manage, async (request, reply) => {
    const b = CreatePllcBody.parse(request.body);
    const result = await createPllcConversion(
      app,
      { type: 'staff', id: request.staff!.id, label: request.staff!.email },
      b
    );
    return reply.code(201).send(result);
  });

  /*
   * THE CHECKLIST COMES FROM THE TASK (Brian's ruling 2026-08-17).
   *
   * `pllc_conversions.checklist` was a module-local to-do list — the thing CLAUDE.md forbids —
   * and once the conversion started spawning a real task, the same six steps existed in two
   * places that could disagree. The task is the one source: it is where the work is assigned,
   * where it shows in My Tasks, and where the existing `/tasks/:id/checklist` endpoints already
   * tick items off.
   *
   * `taskId` is returned so a UI has somewhere to POST a tick to. Nullable on purpose:
   * conversions created before the task existed have none, and inventing one on read would be
   * a write hiding in a GET.
   */
  app.get('/pllc-conversions', manage, async () => {
    const { rows } = await app.db.query(
      `SELECT p.id, p.status, p.license_type, p.current_entity_type, p.license_verified,
              p.detected_via, p.assigned_staff_id,
              c.id AS contact_id, c.first_name, c.last_name, b.name AS business_name,
              t.id AS task_id,
              COALESCE(
                (SELECT json_agg(json_build_object('id', i.id, 'item', i.label, 'done', i.done)
                                 ORDER BY i.position)
                   FROM task_checklist_items i WHERE i.task_id = t.id),
                '[]'::json
              ) AS checklist
       FROM pllc_conversions p
       JOIN contacts c ON c.id = p.contact_id
       LEFT JOIN businesses b ON b.id = p.business_id
       LEFT JOIN tasks t
         ON t.source_type = 'pllc_conversion' AND t.source_id = p.id::text
       ORDER BY p.created_at DESC`
    );
    return { conversions: rows };
  });

  app.patch<{ Params: { id: string } }>('/pllc-conversions/:id', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = UpdatePllcBody.parse(request.body);
    const sets: string[] = [];
    const params: unknown[] = [id];
    if (b.status !== undefined) { params.push(b.status); sets.push(`status = $${params.length}::pllc_status`); }
    if (b.licenseVerified !== undefined) { params.push(b.licenseVerified); sets.push(`license_verified = $${params.length}`); }
    /*
     * REFUSED, not silently dropped. Removing `checklist` from the schema would have zod strip
     * it and return 200, so a caller ticking an item would be told it worked and see nothing
     * change — the worst of the three options. The message names where to go instead.
     */
    if (b.checklist !== undefined) {
      throw new AppError(
        400,
        'checklist_moved',
        'The conversion checklist lives on the task now, not on this record — tick items through ' +
          'PATCH /tasks/:taskId/checklist/:itemId. GET /pllc-conversions returns the taskId.'
      );
    }
    if (b.notes !== undefined) { params.push(b.notes); sets.push(`notes = $${params.length}`); }
    if (sets.length === 0) throw new AppError(400, 'empty_update', 'No fields to update.');
    const res = await app.db.query(`UPDATE pllc_conversions SET ${sets.join(', ')} WHERE id = $1`, params);
    if (res.rowCount === 0) throw new AppError(404, 'not_found', 'PLLC conversion not found.');
    return { status: 'ok' };
  });

  app.post('/jobs/entity-compliance', { preHandler: [app.authenticate, requirePermission('jobs.run')] }, async (request) => {
    const q = z.object({ asOf: z.iso.date().optional() }).parse(request.query);
    return runEntityComplianceJob(app, q.asOf ?? todayChicago());
  });
}
