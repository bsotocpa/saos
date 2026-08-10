// Session recap routes (v4.2 #6).
//
// Approving a client-facing recap is a leadership act by design — the wireframe
// calls this panel "your voice, before it sends". Drafting is open to any staffer
// who can read meetings, because a preparer noticing a session has no recap yet
// should be able to queue one for Brian.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { approveAndSendRecap, draftRecap, recapQueue, updateRecap } from './recaps.ts';

export function registerRecapRoutes(app: FastifyInstance): void {
  const read = { preHandler: [app.authenticate, requirePermission('meetings.read')] };
  const approve = { preHandler: [app.authenticate, requirePermission('dashboards.executive')] };

  /** The approval queue + whether the send is armed (the UI says so before the tap). */
  app.get('/recaps', read, async () => recapQueue(app));

  app.post<{ Params: { id: string } }>('/meetings/:id/recap/draft', read, async (request) => {
    const id = z.uuid().parse(request.params.id);
    return draftRecap(app, id, request.staff!);
  });

  app.patch<{ Params: { id: string } }>('/meetings/:id/recap', approve, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = z
      .object({
        bodyEn: z.string().min(1).max(20_000).optional(),
        bodyEs: z.string().min(1).max(20_000).optional(),
      })
      .parse(request.body);
    await updateRecap(app, id, b, request.staff!);
    return { status: 'drafted' };
  });

  /** ONE TAP: approve and send. */
  app.post<{ Params: { id: string } }>('/meetings/:id/recap/approve', approve, async (request) => {
    const id = z.uuid().parse(request.params.id);
    return approveAndSendRecap(app, id, request.staff!);
  });
}
