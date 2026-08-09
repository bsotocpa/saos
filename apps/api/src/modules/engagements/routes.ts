import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { createEngagement } from './service.ts';
import { configureRecurringEngagement, configuratorOptions, enterMaintenanceMode } from './configurator.ts';

const PREP = ['weekly', 'monthly', 'quarterly', 'semi_annual'] as const;
const SESSION = ['weekly', 'biweekly', 'monthly', 'quarterly', 'semi_annual', 'annual'] as const;
const RUNGS = ['registration_setup', 'review_audit', 'admin_training', 'full_management'] as const;

const ConfigureBody = z.object({
  prepCadence: z.enum(PREP),
  sessionCadence: z.enum(SESSION),
  scopeRung: z.enum(RUNGS).optional(),
  maintenanceMode: z.boolean().optional(),
  note: z.string().max(2000).nullable().optional(),
});

const CreateBody = z.object({
  contactId: z.uuid(),
  businessId: z.uuid().optional(),
  serviceLine: z.enum([
    'tax', 'bookkeeping', 'payroll', 'sales_tax', 'advisory',
    'coo', 'entity', 'attest', 'specialized_cpa', 'nonprofit_cfo',
  ]),
  title: z.string().optional(),
  leadStaffId: z.uuid().optional(),
  status: z.enum(['draft', 'active']).optional(),
  independenceOverrideNote: z.string().min(10, 'Document the override reason (min 10 chars).').optional(),
});

const ListQuery = z.object({ contactId: z.uuid().optional() });

export function registerEngagementRoutes(app: FastifyInstance): void {
  app.post(
    '/engagements',
    { preHandler: [app.authenticate, requirePermission('engagements.create')] },
    async (request, reply) => {
      const body = CreateBody.parse(request.body);
      const result = await createEngagement(app, request.staff!, body, {
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      return reply.code(201).send(result);
    }
  );

  app.get(
    '/engagements',
    { preHandler: [app.authenticate, requirePermission('engagements.read')] },
    async (request) => {
      const q = ListQuery.parse(request.query);
      const params: unknown[] = [];
      let where = '';
      if (q.contactId) {
        params.push(q.contactId);
        where = `WHERE e.contact_id = $1`;
      }
      const { rows } = await app.db.query(
        `SELECT e.id, e.contact_id, e.business_id, e.service_line, e.status, e.title,
                e.lead_staff_id, e.started_on, e.price_book_version_id,
                e.independence_override_at IS NOT NULL AS independence_overridden,
                e.created_at
         FROM engagements e ${where}
         ORDER BY e.created_at DESC LIMIT 200`,
        params
      );
      return { engagements: rows };
    }
  );

  /**
   * What the configurator will allow for this client — including which session
   * cadences the S corp floor forbids, so the UI can disable them rather than
   * letting staff pick one and be refused.
   */
  app.get<{ Params: { id: string } }>(
    '/contacts/:id/configurator-options',
    { preHandler: [app.authenticate, requirePermission('engagements.read')] },
    async (request) => configuratorOptions(app, z.uuid().parse(request.params.id))
  );

  /** Set the two dials + scope rung. The S corp session floor is enforced here. */
  app.post<{ Params: { id: string } }>(
    '/engagements/:id/configure',
    { preHandler: [app.authenticate, requirePermission('engagements.create')] },
    async (request) => {
      const id = z.uuid().parse(request.params.id);
      const body = ConfigureBody.parse(request.body);
      return configureRecurringEngagement(app, id, body, request.staff!);
    }
  );

  /**
   * Maintenance mode — hold prep cadence, reduce sessions. Routed through the
   * same gate as configure, because this is the likeliest way to walk an S corp
   * under the floor.
   */
  app.post<{ Params: { id: string } }>(
    '/engagements/:id/maintenance-mode',
    { preHandler: [app.authenticate, requirePermission('engagements.create')] },
    async (request) => {
      const id = z.uuid().parse(request.params.id);
      const b = z
        .object({ sessionCadence: z.enum(SESSION), note: z.string().max(2000).optional() })
        .parse(request.body);
      return enterMaintenanceMode(app, id, b.sessionCadence, request.staff!, b.note);
    }
  );
}
