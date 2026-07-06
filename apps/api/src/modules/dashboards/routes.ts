import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { AppError } from '../../types.ts';
import { executiveDashboard, hiloDashboard } from './service.ts';
import { makePusher, runPushSweep } from '../../notify/push.ts';

export function registerDashboardRoutes(app: FastifyInstance): void {
  // Executive-level views are leadership-only ('*' roles: Brian, Jackson).
  // Staff scorecards (own-only) are Phase 4.
  const leadership = { preHandler: [app.authenticate, requirePermission('dashboards.executive')] };
  const authed = { preHandler: [app.authenticate] };

  app.get('/dashboards/executive', leadership, async () => executiveDashboard(app));
  app.get('/dashboards/hilo', leadership, async () => hiloDashboard(app));

  // Alert Center: the signed-in staffer's notifications.
  app.get('/notifications', authed, async (request) => {
    const q = z.object({ unread: z.enum(['true', 'false']).optional() }).parse(request.query);
    const clauses = ['staff_id = $1'];
    if (q.unread === 'true') clauses.push('read_at IS NULL');
    const { rows } = await app.db.query(
      `SELECT id, type, severity, title, body, contact_id, related_object_type, related_object_id,
              read_at, pushed_at, created_at
       FROM notifications WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC LIMIT 100`,
      [request.staff!.id]
    );
    return { notifications: rows };
  });

  app.post<{ Params: { id: string } }>('/notifications/:id/read', authed, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const res = await app.db.query(
      `UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND staff_id = $2`,
      [id, request.staff!.id]
    );
    if (res.rowCount === 0) throw new AppError(404, 'not_found', 'Notification not found.');
    return { status: 'ok' };
  });

  app.post('/jobs/push-sweep', { preHandler: [app.authenticate, requirePermission('jobs.run')] }, async () => {
    return runPushSweep(app, makePusher(app.config));
  });
}
