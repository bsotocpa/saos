// Broadcast + review-request routes (M27).
//
// The unsubscribe endpoint is UNAUTHENTICATED by necessity: CAN-SPAM requires a
// one-click opt-out that works without an account, and the HMAC in the link is
// the credential. It is also idempotent — a client who clicks twice, or whose
// mail client pre-fetches the link, must not see an error.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import {
  approveBroadcast, createBroadcast, optOutOfBroadcasts, previewAudience,
  resubscribeToBroadcasts, sendBroadcast, submitForApproval,
} from './broadcast.ts';
import { requestReview, reviewAskDecision } from './review-requests.ts';

const SegmentSchema = z.object({
  sotoStatus: z.enum(['active', 'lead', 'former']).optional(),
  serviceLine: z.string().min(1).optional(),
  language: z.enum(['en', 'es']).optional(),
  portalOnly: z.boolean().optional(),
});

const CreateBody = z.object({
  name: z.string().min(3).max(200),
  channel: z.enum(['email', 'sms', 'both']),
  segment: SegmentSchema.default({}),
  subjectEn: z.string().max(300).optional(),
  subjectEs: z.string().max(300).optional(),
  bodyEn: z.string().min(1).max(20000),
  bodyEs: z.string().min(1).max(20000),
  smsEn: z.string().max(480).optional(),
  smsEs: z.string().max(480).optional(),
});

export function registerBroadcastRoutes(app: FastifyInstance): void {
  const manage = { preHandler: [app.authenticate, requirePermission('inbox.manage')] };
  // Approving a bulk client send is a leadership act, not a comms act.
  const approve = { preHandler: [app.authenticate, requirePermission('dashboards.executive')] };

  /** Who would this reach, and who would be suppressed — before approval. */
  app.post('/broadcasts/preview', manage, async (request) => {
    const b = z
      .object({ segment: SegmentSchema.default({}), channel: z.enum(['email', 'sms', 'both']) })
      .parse(request.body);
    return previewAudience(app, b.segment, b.channel);
  });

  app.post('/broadcasts', manage, async (request, reply) => {
    const b = CreateBody.parse(request.body);
    const result = await createBroadcast(app, b, request.staff!);
    reply.code(201);
    return result;
  });

  app.get('/broadcasts', manage, async () => {
    const { rows } = await app.db.query(
      `SELECT b.id, b.name, b.channel::text, b.status::text, b.segment, b.subject_en,
              b.intended_count, b.sent_count, b.suppressed_count,
              b.approved_at, b.sent_at, b.created_at,
              a.full_name AS approved_by, cr.full_name AS created_by
       FROM broadcasts b
       LEFT JOIN staff a ON a.id = b.approved_by_staff_id
       LEFT JOIN staff cr ON cr.id = b.created_by_staff_id
       ORDER BY b.created_at DESC LIMIT 100`
    );
    return { broadcasts: rows };
  });

  app.get<{ Params: { id: string } }>('/broadcasts/:id', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = await app.db.query(
      `SELECT b.*, a.full_name AS approved_by FROM broadcasts b
       LEFT JOIN staff a ON a.id = b.approved_by_staff_id WHERE b.id = $1`,
      [id]
    );
    // Suppressions grouped by reason — the audit view of a send.
    const suppressed = await app.db.query(
      `SELECT COALESCE(suppressed_reason, 'sent') AS reason, channel, count(*)::int AS count
       FROM broadcast_recipients WHERE broadcast_id = $1
       GROUP BY 1, 2 ORDER BY 3 DESC`,
      [id]
    );
    return { broadcast: b.rows[0] ?? null, outcomes: suppressed.rows };
  });

  app.post<{ Params: { id: string } }>('/broadcasts/:id/submit', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    await submitForApproval(app, id, request.staff!);
    return { status: 'pending_approval' };
  });

  app.post<{ Params: { id: string } }>('/broadcasts/:id/approve', approve, async (request) => {
    const id = z.uuid().parse(request.params.id);
    await approveBroadcast(app, id, request.staff!);
    return { status: 'approved' };
  });

  app.post<{ Params: { id: string } }>('/broadcasts/:id/send', approve, async (request) => {
    const id = z.uuid().parse(request.params.id);
    return sendBroadcast(app, id, request.staff!);
  });

  app.post<{ Params: { id: string } }>('/broadcasts/:id/cancel', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const { rowCount } = await app.db.query(
      `UPDATE broadcasts SET status = 'cancelled', cancelled_at = now()
       WHERE id = $1 AND status IN ('draft', 'pending_approval', 'approved')`,
      [id]
    );
    return { cancelled: (rowCount ?? 0) > 0 };
  });

  /** Would we ask this client for a review right now, and if not, why not. */
  app.get<{ Params: { id: string } }>('/contacts/:id/review-ask-decision', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    return reviewAskDecision(app, id);
  });

  /** Manual ask — still runs every suppression rule and the kill switch. */
  app.post<{ Params: { id: string } }>('/contacts/:id/review-request', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    return requestReview(app, { contactId: id, trigger: 'onboarding_complete', sourceType: 'manual' });
  });

  app.post<{ Params: { id: string } }>('/contacts/:id/resubscribe', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = z.object({ note: z.string().min(3).max(500) }).parse(request.body);
    await resubscribeToBroadcasts(app, id, request.staff!, b.note);
    return { resubscribed: true };
  });

  // ---------------------------------------------------------------- public --
  // CAN-SPAM one-click opt-out. No session, idempotent, GET and POST both work
  // because some mail clients will only follow a link.
  const unsubscribe = async (request: { params: { id: string; token: string } }) => {
    const id = z.uuid().parse(request.params.id);
    const token = z.string().min(20).max(200).parse(request.params.token);
    return optOutOfBroadcasts(app, id, token, 'email-footer-link');
  };
  app.get<{ Params: { id: string; token: string } }>('/public/unsubscribe/:id/:token', unsubscribe);
  app.post<{ Params: { id: string; token: string } }>('/public/unsubscribe/:id/:token', unsubscribe);
}
