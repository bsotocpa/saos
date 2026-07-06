import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { createEngagement } from './service.ts';

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
}
