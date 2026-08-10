// SOP knowledge base routes (M27).
//
// READING is open to any authenticated staffer — the entire point is that a new
// hire can find the procedure. WRITING and PUBLISHING are leadership: an SOP is
// the firm's answer to "how do we do this", and it should not change because
// someone was mid-task and disagreed.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import {
  createSop, getSop, publishSop, searchSops, seedSopFromMeeting, taskTypeSopRegistry, updateSop,
} from './service.ts';

const SopBody = z.object({
  slug: z.string().min(3).max(80),
  title: z.string().min(3).max(200),
  bodyMd: z.string().min(1).max(100_000),
  roleKey: z.string().max(40).nullable().optional(),
  process: z.string().max(120).nullable().optional(),
});

export function registerSopRoutes(app: FastifyInstance): void {
  const anyStaff = { preHandler: [app.authenticate] };
  const author = { preHandler: [app.authenticate, requirePermission('dashboards.executive')] };

  /** Search / browse. Published only unless an author asks for drafts. */
  app.get('/sops', anyStaff, async (request) => {
    const q = z
      .object({
        q: z.string().max(200).optional(),
        roleKey: z.string().max(40).optional(),
        includeDrafts: z.coerce.boolean().optional(),
      })
      .parse(request.query);
    // Drafts are for the people who write SOPs, not for everyone searching.
    const canSeeDrafts =
      q.includeDrafts === true && request.staff!.permissions.includes('dashboards.executive');
    return searchSops(app, {
      ...(q.q !== undefined ? { q: q.q } : {}),
      ...(q.roleKey !== undefined ? { roleKey: q.roleKey } : {}),
      includeDrafts: canSeeDrafts || request.staff!.permissions.includes('*') ? q.includeDrafts : false,
    });
  });

  /**
   * The registry: every task type, its SOP, and whether that SOP is written yet.
   * `mappedButUnwritten` is the honest measure of how far this layer really goes.
   */
  app.get('/sops/task-types', anyStaff, async () => taskTypeSopRegistry(app));

  app.get<{ Params: { slug: string } }>('/sops/:slug', anyStaff, async (request) => {
    const slug = z.string().min(3).max(80).parse(request.params.slug);
    return getSop(app, slug);
  });

  app.post('/sops', author, async (request, reply) => {
    const b = SopBody.parse(request.body);
    const result = await createSop(app, b, request.staff!);
    reply.code(201);
    return result;
  });

  app.patch<{ Params: { slug: string } }>('/sops/:slug', author, async (request) => {
    const slug = z.string().min(3).max(80).parse(request.params.slug);
    const b = SopBody.partial().omit({ slug: true }).parse(request.body);
    await updateSop(app, slug, b, request.staff!);
    return { status: 'ok' };
  });

  app.post<{ Params: { slug: string } }>('/sops/:slug/publish', author, async (request) => {
    const slug = z.string().min(3).max(80).parse(request.params.slug);
    const b = z.object({ note: z.string().max(500).optional() }).parse(request.body ?? {});
    return publishSop(app, slug, request.staff!, b.note);
  });

  /** Seed a DRAFT from a recorded handoff session (approval before publish). */
  app.post<{ Params: { id: string } }>('/meetings/:id/seed-sop', author, async (request, reply) => {
    const meetingId = z.uuid().parse(request.params.id);
    const b = z
      .object({
        slug: z.string().min(3).max(80),
        title: z.string().min(3).max(200),
        roleKey: z.string().max(40).optional(),
        process: z.string().max(120).optional(),
      })
      .parse(request.body);
    const result = await seedSopFromMeeting(app, meetingId, b, request.staff!);
    reply.code(201);
    return result;
  });
}
