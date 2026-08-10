// Hilo event routes (M27).
//
// The /public/events/* routes are UNAUTHENTICATED by necessity: a workshop
// registration page has to work for someone who has never heard of us. They are
// deliberately narrow — read a published event, register, cancel your own
// registration by email — and they never expose the attendee list.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import {
  cancelRegistration, checkIn, checkInList, completeEvent, createEvent, eventImpact,
  publicEvent, publishEvent, recordSurvey,
} from './service.ts';

const EventBody = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use a lowercase kebab-case slug.').max(80),
  titleEn: z.string().min(3).max(200),
  titleEs: z.string().min(3).max(200),
  descriptionEn: z.string().min(10).max(20_000),
  descriptionEs: z.string().min(10).max(20_000),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime().nullable().optional(),
  capacity: z.number().int().min(1).max(10_000),
  location: z.string().max(300).nullable().optional(),
  isVirtual: z.boolean().optional(),
  program: z.string().max(120).nullable().optional(),
});

const RegistrationBody = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  email: z.email(),
  phone: z.string().max(40).nullable().optional(),
  language: z.enum(['en', 'es']).optional(),
  // TCPA: a workshop signup is not consent to be texted about anything else.
  smsOptIn: z.boolean().optional(),
});

export function registerEventRoutes(app: FastifyInstance): void {
  // Hilo events are Jackson's; leadership manages them.
  const manage = { preHandler: [app.authenticate, requirePermission('dashboards.executive')] };
  const anyStaff = { preHandler: [app.authenticate] };

  app.get('/events', anyStaff, async () => {
    const { rows } = await app.db.query(
      `SELECT e.slug, e.title_en, e.program, e.starts_at, e.capacity, e.status::text AS status,
              count(r.id) FILTER (WHERE r.status IN ('confirmed', 'attended'))::int AS confirmed,
              count(r.id) FILTER (WHERE r.status = 'waitlisted')::int AS waitlisted,
              count(r.id) FILTER (WHERE r.status = 'attended')::int AS attended
       FROM events e LEFT JOIN event_registrations r ON r.event_id = e.id
       GROUP BY e.id, e.slug, e.title_en, e.program, e.starts_at, e.capacity, e.status
       ORDER BY e.starts_at DESC LIMIT 100`
    );
    return { events: rows };
  });

  app.post('/events', manage, async (request, reply) => {
    const b = EventBody.parse(request.body);
    const result = await createEvent(app, b, request.staff!);
    reply.code(201);
    return result;
  });

  app.post<{ Params: { slug: string } }>('/events/:slug/publish', manage, async (request) => {
    const slug = z.string().max(80).parse(request.params.slug);
    await publishEvent(app, slug, request.staff!);
    return { status: 'published' };
  });

  /** The check-in list — staff only, obviously. */
  app.get<{ Params: { slug: string } }>('/events/:slug/check-in', anyStaff, async (request) => {
    const slug = z.string().max(80).parse(request.params.slug);
    return checkInList(app, slug);
  });

  app.post<{ Params: { id: string } }>('/event-registrations/:id/check-in', anyStaff, async (request) => {
    const id = z.uuid().parse(request.params.id);
    await checkIn(app, id, request.staff!);
    return { checkedIn: true };
  });

  app.post<{ Params: { id: string } }>('/event-registrations/:id/survey', anyStaff, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = z
      .object({
        satisfaction: z.number().int().min(1).max(5).optional(),
        nps: z.number().int().min(0).max(10).optional(),
        learned: z.string().max(4000).optional(),
        next: z.string().max(4000).optional(),
      })
      .parse(request.body);
    await recordSurvey(app, id, b, request.staff!);
    return { recorded: true };
  });

  /** Close out: no-shows recorded, out-survey sent, one follow-up task raised. */
  app.post<{ Params: { slug: string } }>('/events/:slug/complete', manage, async (request) => {
    const slug = z.string().max(80).parse(request.params.slug);
    return completeEvent(app, slug, request.staff!);
  });

  /** Funder-report numbers for one event. */
  app.get<{ Params: { slug: string } }>('/events/:slug/impact', anyStaff, async (request) => {
    const slug = z.string().max(80).parse(request.params.slug);
    return eventImpact(app, slug);
  });

  // ---------------------------------------------------------------- public --

  app.get<{ Params: { slug: string } }>('/public/events/:slug', async (request) => {
    const slug = z.string().max(80).parse(request.params.slug);
    return publicEvent(app, slug);
  });

  app.post<{ Params: { slug: string } }>('/public/events/:slug/register', async (request, reply) => {
    const slug = z.string().max(80).parse(request.params.slug);
    const b = RegistrationBody.parse(request.body);
    const result = await registerPublic(app, slug, b);
    reply.code(201);
    return result;
  });

  app.post<{ Params: { slug: string } }>('/public/events/:slug/cancel', async (request) => {
    const slug = z.string().max(80).parse(request.params.slug);
    const b = z.object({ email: z.email() }).parse(request.body);
    return cancelRegistration(app, slug, b.email);
  });
}

// Kept as a named indirection so the public handler reads plainly above.
async function registerPublic(
  app: FastifyInstance,
  slug: string,
  body: z.infer<typeof RegistrationBody>
) {
  const { registerForEvent } = await import('./service.ts');
  return registerForEvent(app, slug, body);
}
