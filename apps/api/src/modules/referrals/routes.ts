import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import {
  approveReferral,
  createReferral,
  declineReferral,
  sendReferral,
  sotoCtaState,
  transitionPrefill,
  transitionSubmit,
} from './service.ts';

const CreateBody = z.object({
  contactId: z.uuid(),
  direction: z.enum(['hilo_to_soto', 'soto_to_hilo']),
  source: z.enum(['session_summary', 'manual', 'portal_cta', 'intake', 'directory']).default('manual'),
  notes: z.string().max(2000).optional(),
});

const TransitionSubmitBody = z.object({
  rt: z.string().min(1),
  services: z.array(z.string()).min(1),
  disclosureAcknowledged: z.boolean(),
  communicationConsent: z.boolean(),
  esignConsent: z.boolean(),
  ein: z.string().optional(),
  smsOk: z.boolean().optional(),
});

export function registerReferralRoutes(app: FastifyInstance): void {
  // Referral work spans both entities — contacts.write covers the staff who
  // drive it; approval taps are one-tap from Jackson/Brian ('*' roles).
  /*
   * SUGGESTING A REFERRAL (2026-09-12). ed_coo lost the wildcard and never held contacts.write,
   * but the Hilo attribution rule depends on Jaqueline being the suggester. referrals.suggest is
   * the named grant for exactly that; contacts.write holders keep it too.
   */
  const staff = {
    preHandler: [app.authenticate, async (request: FastifyRequest, reply: FastifyReply) => {
      const p = request.staff?.permissions ?? [];
      if (p.includes('*') || p.includes('referrals.suggest') || p.includes('contacts.write')) return;
      await reply.code(403).send({ error: 'forbidden', permission: 'referrals.suggest' });
    }],
  };
  const approve = { preHandler: [app.authenticate, requirePermission('referrals.approve')] };

  app.post('/referrals', staff, async (request, reply) => {
    const b = CreateBody.parse(request.body);
    const result = await createReferral(
      app,
      { type: 'staff', id: request.staff!.id, label: request.staff!.fullName },
      b
    );
    return reply.code(201).send(result);
  });

  app.get('/referrals', staff, async (request) => {
    const q = z
      .object({
        status: z.enum(['suggested', 'pending_approval', 'approved', 'sent', 'converted', 'declined', 'expired']).optional(),
        direction: z.enum(['hilo_to_soto', 'soto_to_hilo']).optional(),
      })
      .parse(request.query);
    const clauses: string[] = ['true'];
    const params: unknown[] = [];
    if (q.status) { params.push(q.status); clauses.push(`r.status = $${params.length}::referral_status`); }
    if (q.direction) { params.push(q.direction); clauses.push(`r.direction = $${params.length}::referral_direction`); }
    const { rows } = await app.db.query(
      `SELECT r.id, r.direction, r.status, r.source, r.sent_at, r.converted_at,
              r.disclosure_shown_at, r.disclosure_policy_version,
              c.id AS contact_id, c.first_name, c.last_name
       FROM referrals r JOIN contacts c ON c.id = r.contact_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY r.created_at DESC LIMIT 200`,
      params
    );
    return { referrals: rows };
  });

  app.post<{ Params: { id: string } }>('/referrals/:id/approve', approve, async (request) => {
    const id = z.uuid().parse(request.params.id);
    await approveReferral(app, { id: request.staff!.id, label: request.staff!.fullName }, id);
    return { status: 'ok' };
  });

  app.post<{ Params: { id: string } }>('/referrals/:id/decline', approve, async (request) => {
    const id = z.uuid().parse(request.params.id);
    await declineReferral(app, { id: request.staff!.id, label: request.staff!.fullName }, id);
    return { status: 'ok' };
  });

  app.post<{ Params: { id: string } }>('/referrals/:id/send', approve, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const result = await sendReferral(app, { id: request.staff!.id, label: request.staff!.fullName }, id);
    return { status: 'ok', ...result };
  });

  // ── Form 3 (public, token-authed) ────────────────────────────────────────
  app.get('/public/transition', async (request) => {
    const q = z.object({ rt: z.string().min(1) }).parse(request.query);
    return transitionPrefill(app, q.rt);
  });

  app.post('/public/transition/submit', async (request) => {
    const b = TransitionSubmitBody.parse(request.body);
    const result = await transitionSubmit(app, b.rt, b, { ip: request.ip });
    return { status: 'converted', contactId: result.contactId };
  });

  // ── Automation 15: the Soto CTA (Hilo portal consumes this in Phase 2) ──
  app.get('/portal/soto-cta', { preHandler: [app.authenticateClient] }, async (request) => {
    return sotoCtaState(app, request.client!.contactId);
  });

  app.post('/portal/soto-cta/request', { preHandler: [app.authenticateClient] }, async (request, reply) => {
    const client = request.client!;
    const state = await sotoCtaState(app, client.contactId);
    if (!state.show) return reply.code(409).send({ error: 'cta_not_available' });
    const result = await createReferral(
      app,
      { type: 'client', label: client.displayName },
      { contactId: client.contactId, direction: 'hilo_to_soto', source: 'portal_cta' }
    );
    return reply.code(201).send(result);
  });
}
