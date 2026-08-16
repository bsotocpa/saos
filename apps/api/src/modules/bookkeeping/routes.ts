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
import { createTask } from '../tasks/service.ts';
import { firstActiveByRole } from '../../staffing.ts';
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

  /*
   * ASK FOR A MEETING TO BE SCHEDULED, from the client record (#33).
   *
   * THE CALENDAR CROSS-CHECK IS ENFORCED HERE, not in the button. CLAUDE.md: never
   * create a session-scheduling task without first checking for an existing session with
   * that client — attach to the existing one, and only create a task when none exists.
   *
   * So a client who already has something on the calendar gets a 409, and the screen
   * re-reads their next session and shows it instead. Putting the rule in the endpoint rather
   * than the UI is the difference between a rule and a habit: a second surface that
   * forgets to look cannot double-book through this route.
   *
   * SCOPED TO AN OPEN ENGAGEMENT, per the finding. "Book a meeting" with no subject
   * produces a task nobody can prioritise; naming the engagement says what the meeting
   * is for and puts it on that piece of work.
   */
  const clientWrite = { preHandler: [app.authenticate, requirePermission('contacts.write')] };
  app.post<{ Params: { contactId: string } }>('/contacts/:contactId/schedule-session', clientWrite, async (request, reply) => {
    const contactId = z.uuid().parse(request.params.contactId);
    const b = z
      .object({ engagementId: z.uuid().optional(), note: z.string().max(500).optional() })
      .parse(request.body ?? {});
    const actor = request.staff!;

    const existing = await upcomingSession(app, contactId, todayChicago());
    if (existing) {
      // The refusal carries no payload: the error handler serialises `error` and
      // `message` only, so attaching the session here would look informative and arrive
      // nowhere. The screen re-reads /contacts/:id/next-session and shows it from there.
      throw new AppError(
        409,
        'session_already_scheduled',
        'This client already has a session on the calendar. Attach to that one rather than booking a second.'
      );
    }

    // The engagement has to be this client's AND open — a meeting cannot be "for" work
    // that belongs to someone else or finished last year.
    let engagementTitle: string | null = null;
    if (b.engagementId) {
      const eng = await app.db.query<{ id: string; service_line: string }>(
        `SELECT id, service_line::text AS service_line FROM engagements
          WHERE id = $1 AND contact_id = $2 AND status = 'active'`,
        [b.engagementId, contactId]
      );
      if (!eng.rows[0]) {
        throw new AppError(404, 'engagement_not_open', 'That engagement is not open for this client.');
      }
      engagementTitle = eng.rows[0].service_line;
    }

    const owner = await firstActiveByRole(app.db, 'comms_billing');
    const task = await createTask(app, {
      title: engagementTitle
        ? `Schedule a meeting — ${engagementTitle}`
        : 'Schedule a meeting with this client',
      description: b.note ?? 'Requested from the client record. Nothing is on their calendar.',
      assignedStaffId: owner,
      contactId,
      engagementId: b.engagementId ?? null,
      priority: 1,
      source: 'manual',
      sourceType: 'client_session_scheduling',
      createdByStaffId: actor.id,
    });

    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
      action: 'client_session.scheduling_requested', objectType: 'task', objectId: task.id,
      contactId, ip: request.ip,
      details: { engagement_id: b.engagementId ?? null },
    });
    return reply.code(201).send({ taskId: task.id, created: task.created });
  });
}
