// Bookkeeping close cycle routes (M26 flow 5) + the session store the
// calendar cross-check depends on. Marian's workbench is the GET; closing is
// a multipart POST because the statements PDF posts to the portal in the same
// step (no separate upload, no review gate).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { AppError } from '../../types.ts';
import { writeAudit } from '../../audit.ts';
import { makeMinioClient } from '../documents/storage.ts';
import { todayChicago } from '../tax/deadlines.ts';
import {
  CLOSE_STEPS, closeWorkbench, completeClose, createCloseCycle, markCloseStep, upcomingSession,
} from './close.ts';

const CreateBody = z.object({
  contactId: z.uuid(),
  businessId: z.uuid().optional(),
  engagementId: z.uuid().optional(),
  cadence: z.enum(['weekly', 'monthly', 'quarterly', 'semi_annual']),
  periodStart: z.iso.date(),
  periodEnd: z.iso.date(),
  assignedStaffId: z.uuid().optional(),
});

const SessionBody = z.object({
  contactId: z.uuid(),
  staffId: z.uuid().optional(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).optional(),
  eventType: z.string().max(120).optional(),
  externalRef: z.string().max(200).optional(),
  isRecurring: z.boolean().optional(),
});

function fieldValues(data: MultipartFile): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(data.fields)) {
    const f = Array.isArray(field) ? field[0] : field;
    if (f && f.type === 'field') out[name] = (f as { value: unknown }).value;
  }
  return out;
}

export function registerBookkeepingRoutes(app: FastifyInstance): void {
  const minio = makeMinioClient(app.config);
  const manage = { preHandler: [app.authenticate, requirePermission('bookkeeping.assigned.manage')] };
  const read = { preHandler: [app.authenticate, requirePermission('bookkeeping.assigned.manage')] };

  // ── close cycles ──────────────────────────────────────────────────────────
  app.get('/close-cycles', read, async (request) => {
    const q = z.object({ mine: z.enum(['true', 'false']).optional() }).parse(request.query);
    return { cycles: await closeWorkbench(app, q.mine === 'true' ? request.staff!.id : undefined) };
  });

  app.post('/close-cycles', manage, async (request, reply) => {
    const b = CreateBody.parse(request.body);
    if (b.periodEnd < b.periodStart) throw new AppError(400, 'bad_period', 'periodEnd must not precede periodStart.');
    const result = await createCloseCycle(
      app,
      {
        contactId: b.contactId, businessId: b.businessId ?? null, engagementId: b.engagementId ?? null,
        cadence: b.cadence, periodStart: b.periodStart, periodEnd: b.periodEnd,
        assignedStaffId: b.assignedStaffId ?? null,
      },
      request.staff!
    );
    return reply.code(result.created ? 201 : 200).send(result);
  });

  app.post<{ Params: { id: string; step: string } }>('/close-cycles/:id/steps/:step', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const step = z.enum(CLOSE_STEPS).parse(request.params.step);
    await markCloseStep(app, id, step, request.staff!);
    return { status: 'ok', step };
  });

  /**
   * Close the period: the statements file posts to the client portal and the
   * calendar cross-check decides whether any scheduling task is needed.
   */
  app.post<{ Params: { id: string } }>('/close-cycles/:id/close', manage, async (request, reply) => {
    const id = z.uuid().parse(request.params.id);
    const data = await request.file();
    if (!data) throw new AppError(400, 'file_required', 'Attach the statements file (it posts to the client portal).');
    const buffer = await data.toBuffer();
    const fields = z.object({ asOf: z.iso.date().optional() }).parse(fieldValues(data));
    const result = await completeClose(
      app, minio, id,
      {
        filename: data.filename,
        mimeType: data.mimetype,
        buffer,
        today: fields.asOf ?? todayChicago(),
      },
      { id: request.staff!.id, email: request.staff!.email, ip: request.ip }
    );
    return reply.code(201).send(result);
  });

  // ── client sessions (the cross-check's source of truth) ───────────────────
  // Cal.com bookings land here; the books-close cross-check reads it.
  app.post('/client-sessions', manage, async (request, reply) => {
    const b = SessionBody.parse(request.body);
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO client_sessions (contact_id, staff_id, starts_at, ends_at, event_type, external_ref, is_recurring)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (external_ref) DO UPDATE
         SET starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, status = 'scheduled'
       RETURNING id`,
      [
        b.contactId, b.staffId ?? null, b.startsAt, b.endsAt ?? null,
        b.eventType ?? null, b.externalRef ?? null, b.isRecurring ?? false,
      ]
    );
    await writeAudit(app.db, {
      actorType: 'staff', actorId: request.staff!.id, actorLabel: request.staff!.email,
      action: 'client_session.recorded', objectType: 'client_session', objectId: rows[0]!.id,
      contactId: b.contactId,
      details: { starts_at: b.startsAt, recurring: b.isRecurring ?? false, event_type: b.eventType ?? null },
    });
    return reply.code(201).send({ id: rows[0]!.id });
  });

  app.get<{ Params: { contactId: string } }>('/contacts/:contactId/next-session', read, async (request) => {
    const contactId = z.uuid().parse(request.params.contactId);
    const session = await upcomingSession(app, contactId, todayChicago());
    return { session };
  });
}
