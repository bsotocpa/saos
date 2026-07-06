import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { AppError } from '../../types.ts';
import { makeMinioClient } from '../documents/storage.ts';
import { makeDocusealAdapter } from './docuseal.ts';
import {
  completeEnvelopeBySubmission,
  createEnvelope,
  resolveKba,
  sendEnvelope,
  startRemote8879,
  templateKeyFor,
} from './service.ts';

const CreateBody = z.object({
  contactId: z.uuid(),
  type: z.enum(['engagement_letter', 'consent_7216', 'w9', 'grant_agreement', 'other']),
  engagementId: z.uuid().optional(),
  taxEngagementId: z.uuid().optional(),
  serviceLine: z.string().optional(), // picks the engagement-letter variant
  docusealTemplateId: z.string().optional(),
});

const SimulateBody = z.object({
  outcome: z.enum(['passed', 'failed']),
  failureReason: z.string().optional(),
});

function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function registerSignatureRoutes(app: FastifyInstance): void {
  const docuseal = makeDocusealAdapter(app.config);
  const minio = makeMinioClient(app.config);
  const manage = { preHandler: [app.authenticate, requirePermission('engagements.tax.manage')] };

  // Create (draft — intake and staff queue these; sending is the gated step).
  app.post('/signature-envelopes', manage, async (request, reply) => {
    const b = CreateBody.parse(request.body);
    const result = await createEnvelope(
      app,
      { type: 'staff', id: request.staff!.id, label: request.staff!.email },
      {
        contactId: b.contactId,
        type: b.type,
        engagementId: b.engagementId,
        taxEngagementId: b.taxEngagementId,
        templateKey: templateKeyFor(b.type, b.serviceLine ?? null),
        docusealTemplateId: b.docusealTemplateId,
      }
    );
    return reply.code(201).send(result);
  });

  app.post<{ Params: { id: string } }>('/signature-envelopes/:id/send', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const result = await sendEnvelope(
      app,
      docuseal,
      { type: 'staff', id: request.staff!.id, label: request.staff!.email },
      id
    );
    return { status: 'ok', ...result };
  });

  app.get('/signature-envelopes', manage, async (request) => {
    const q = z.object({ contactId: z.uuid().optional(), status: z.string().optional() }).parse(request.query);
    const clauses: string[] = ['true'];
    const params: unknown[] = [];
    if (q.contactId) { params.push(q.contactId); clauses.push(`se.contact_id = $${params.length}`); }
    if (q.status) { params.push(q.status); clauses.push(`se.status = $${params.length}::envelope_status`); }
    const { rows } = await app.db.query(
      `SELECT se.id, se.type, se.status, se.signature_method, se.template_key, se.sent_at, se.completed_at,
              se.signed_document_id, c.id AS contact_id, c.first_name, c.last_name
       FROM signature_envelopes se JOIN contacts c ON c.id = se.contact_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY se.created_at DESC LIMIT 200`,
      params
    );
    return { envelopes: rows };
  });

  // Remote 8879: KBA first, Docuseal only after a pass (MP compliance flow).
  app.post<{ Params: { id: string } }>('/tax-engagements/:id/signatures/remote-8879', manage, async (request, reply) => {
    const id = z.uuid().parse(request.params.id);
    const result = await startRemote8879(app, { id: request.staff!.id, label: request.staff!.email }, id);
    return reply.code(201).send(result);
  });

  // Sandbox-only: resolve a KBA session (real vendors resolve via their webhook).
  app.post<{ Params: { kbaId: string } }>('/kba/:kbaId/simulate', manage, async (request) => {
    if (app.config.KBA_MODE !== 'sandbox') {
      throw new AppError(409, 'not_sandbox', 'KBA simulation exists only in sandbox mode.');
    }
    const kbaId = z.uuid().parse(request.params.kbaId);
    const b = SimulateBody.parse(request.body);
    const result = await resolveKba(app, docuseal, kbaId, b.outcome, b.failureReason);
    return { status: 'ok', ...result };
  });

  // Docuseal webhook: completion → signed PDF to MinIO → gates updated.
  app.post('/webhooks/docuseal', async (request, reply) => {
    const secret = request.headers['x-webhook-secret'];
    if (typeof secret !== 'string' || !secretsMatch(secret, app.config.WEBHOOK_SECRET)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = z
      .object({
        event_type: z.string(),
        data: z.looseObject({ submission_id: z.union([z.string(), z.number()]).optional(), id: z.union([z.string(), z.number()]).optional() }),
      })
      .parse(request.body);
    if (body.event_type !== 'form.completed' && body.event_type !== 'submission.completed') {
      return { status: 'ignored' };
    }
    const submissionId = String(body.data.submission_id ?? body.data.id ?? '');
    if (!submissionId) return { status: 'ignored' };
    const result = await completeEnvelopeBySubmission(app, docuseal, minio, submissionId);
    return { status: 'ok', matched: result !== null };
  });

  // Portal: the client's "Sign Documents" list — scoped to the session contact.
  app.get('/portal/signature-envelopes', { preHandler: [app.authenticateClient] }, async (request) => {
    const client = request.client!;
    const { rows } = await app.db.query(
      `SELECT id, type, status, sent_at, completed_at, signed_document_id
       FROM signature_envelopes
       WHERE contact_id = $1 AND status NOT IN ('voided', 'declined')
       ORDER BY created_at DESC`,
      [client.contactId]
    );
    return { envelopes: rows };
  });
}
