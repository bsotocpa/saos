import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { createEngagement } from './service.ts';
import { configureRecurringEngagement, configuratorOptions, enterMaintenanceMode } from './configurator.ts';
import { scopeForEngagements, scopeName, scopeSummary } from './scope.ts';
import { closeEngagement } from './close.ts';
import { pauseEngagement, resumeEngagement } from './pause.ts';

const PREP = ['weekly', 'monthly', 'quarterly', 'semi_annual'] as const;
const SESSION = ['weekly', 'biweekly', 'monthly', 'quarterly', 'semi_annual', 'annual'] as const;
const RUNGS = ['registration_setup', 'review_audit', 'admin_training', 'full_management'] as const;

/*
 * `declined` is deliberately absent (#44). It describes a QUOTE, and `quotes.status` already
 * holds it with `decline_reason`. An engagement exists only because a quote was accepted, so
 * it cannot be declined — the case it might describe is `withdrawn` with a reason.
 */
const CloseBody = z.object({
  outcome: z.enum(['completed', 'withdrawn']),
  // Item 7a (2026-09-09): what happens to a paid, unapplied deposit on withdrawal.
  depositAction: z.enum(['transfer', 'refund']).optional(),
  transferToEngagementId: z.uuid().nullable().optional(),
  reason: z.string().max(2000).optional(),
  endedOn: z.iso.date().optional(),
});

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
                e.ended_on, e.close_reason,
                e.independence_override_at IS NOT NULL AS independence_overridden,
                e.created_at
         FROM engagements e ${where}
         -- active first, then on hold, then closed (completed/withdrawn/draft); newest first
         -- within each group (2026-09-09, Brian's ruling).
         ORDER BY CASE e.status WHEN 'active' THEN 0 WHEN 'on_hold' THEN 1 ELSE 2 END,
                  e.created_at DESC
         LIMIT 200`,
        params
      );
      /*
       * #47 — what each engagement covers. Staff read English; the Spanish text is on the
       * row and belongs to the client-facing surface, not this one.
       *
       * Two identical `tax`/`active` rows on one client (#41) are only distinguishable by
       * their scope, so this is the list that most needed it.
       */
      const scopes = await scopeForEngagements(app, rows.map((r) => String(r.id)));
      return {
        engagements: rows.map((r) => {
          const items = scopes.get(String(r.id)) ?? [];
          return {
            ...r,
            scopeName: scopeName(items, 'en'),
            scope: items,
            scopeSummary: scopeSummary(items),
          };
        }),
      };
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

  /*
   * CLOSING, HOLDING AND RESUMING (#44) — all three behind `engagements.write`.
   *
   * A separate permission from `engagements.create` on purpose: creating an engagement is
   * the start of a commitment and ending one is the end of it, and the roles that should be
   * able to do the second are not automatically the roles that can do the first. Today only
   * the wildcard holders have it, which is the conservative direction to be wrong in.
   *
   * NOT automation-gated. `isAutomationEnabled()` exists to stop the system messaging
   * clients on its own; a staff member clicking a button about a named engagement IS the
   * decision the gate stands in for. The audit row records who — Brian's ruling, restated
   * here because this is the third feature to sit on that line.
   */
  const closeGate = { preHandler: [app.authenticate, requirePermission('engagements.write')] };

  app.post<{ Params: { id: string } }>('/engagements/:id/close', closeGate, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = CloseBody.parse(request.body);
    return closeEngagement(
      app,
      id,
      {
        outcome: b.outcome,
        reason: b.reason ?? null,
        endedOn: b.endedOn ?? null,
        depositAction: b.depositAction,
        transferToEngagementId: b.transferToEngagementId ?? null,
      },
      { type: 'staff', id: request.staff!.id, label: request.staff!.email }
    );
  });

  /**
   * Item 7b (2026-09-09): move a paid, unapplied deposit invoice between two engagements of
   * the same client. billing.manage. Audit row on both engagements and on the invoice.
   */
  app.post<{ Params: { id: string } }>(
    '/engagements/:id/transfer-deposit',
    { preHandler: [app.authenticate, requirePermission('billing.manage')] },
    async (request) => {
      const toEngagementId = z.uuid().parse(request.params.id);
      const b = z.object({ invoiceId: z.uuid(), reason: z.string().trim().min(5).max(1000) }).parse(request.body);
      const { transferDeposit } = await import('./deposits.ts');
      return transferDeposit(app, { invoiceId: b.invoiceId, toEngagementId, reason: b.reason }, {
        type: 'staff', id: request.staff!.id, label: request.staff!.email,
      });
    }
  );

  /**
   * Decision 1 (2026-09-09): a legacy engagement's period, set by a person with a reason.
   * engagements.write. The partial unique index judges the result — two active engagements
   * on one line and period cannot both exist, so setting a colliding period is refused.
   */
  app.patch<{ Params: { id: string } }>('/engagements/:id/period', closeGate, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = z.object({ periodKey: z.string().trim().min(2).max(40), reason: z.string().trim().min(5).max(1000) }).parse(request.body);
    const { setEngagementPeriod } = await import('./period-set.ts');
    return setEngagementPeriod(app, id, b, { type: 'staff', id: request.staff!.id, label: request.staff!.email });
  });

  app.post<{ Params: { id: string } }>('/engagements/:id/pause', closeGate, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = z.object({ reason: z.string().min(1).max(2000) }).parse(request.body);
    return pauseEngagement(app, id, { reason: b.reason }, {
      type: 'staff', id: request.staff!.id, label: request.staff!.email,
    });
  });

  app.post<{ Params: { id: string } }>('/engagements/:id/resume', closeGate, async (request) => {
    const id = z.uuid().parse(request.params.id);
    return resumeEngagement(app, id, {
      type: 'staff', id: request.staff!.id, label: request.staff!.email,
    });
  });
}
