// Document routes. Client uploads/downloads scope by the SESSION contact —
// never a client-supplied id. Staff paths are RBAC'd. Every byte moved is
// audit-logged in the service layer.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { makeMinioClient } from './storage.ts';
import { afterReturnDelivered, downloadDocument, runDocumentChaseJob, uploadDocument } from './service.ts';
import { todayChicago } from '../tax/deadlines.ts';

const CLIENT_CATEGORIES = ['tax_documents', 'business_records', 'id_verification', 'irs_notices', 'other'] as const;
const STAFF_CATEGORIES = [...CLIENT_CATEGORIES, 'signed_authorizations', 'return_deliverable'] as const;

const ClientUploadFields = z.object({
  category: z.enum(CLIENT_CATEGORIES),
  taxYear: z.coerce.number().int().optional(),
  documentRequestItemId: z.uuid().optional(),
});

const StaffUploadFields = z.object({
  contactId: z.uuid(),
  category: z.enum(STAFF_CATEGORIES),
  taxYear: z.coerce.number().int().optional(),
  taxEngagementId: z.uuid().optional(),
  businessId: z.uuid().optional(),
});

const StatusBody = z.object({
  status: z.enum(['uploaded', 'under_review', 'accepted', 'needs_replacement', 'archived']),
});

function fieldValues(data: MultipartFile): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(data.fields)) {
    const f = Array.isArray(field) ? field[0] : field;
    if (f && f.type === 'field') out[name] = (f as { value: unknown }).value;
  }
  return out;
}

async function readUpload(request: FastifyRequest): Promise<{ data: MultipartFile; buffer: Buffer }> {
  const data = await request.file();
  if (!data) throw new AppError(400, 'file_required', 'Attach exactly one file.');
  const buffer = await data.toBuffer(); // throws 413 when over the configured limit
  return { data, buffer };
}

export function registerDocumentRoutes(app: FastifyInstance): void {
  const minio = makeMinioClient(app.config);

  // ── Client portal ─────────────────────────────────────────────────────────
  app.post('/portal/documents', { preHandler: [app.authenticateClient] }, async (request, reply) => {
    const client = request.client!;
    const { data, buffer } = await readUpload(request);
    const fields = ClientUploadFields.parse(fieldValues(data));
    const result = await uploadDocument(
      app,
      minio,
      { type: 'client', id: client.portalUserId, label: client.email, ip: request.ip },
      {
        contactId: client.contactId, // ALWAYS the session contact
        category: fields.category,
        filename: data.filename,
        mimeType: data.mimetype,
        buffer,
        taxYear: fields.taxYear,
        documentRequestItemId: fields.documentRequestItemId,
      }
    );
    return reply.code(201).send(result);
  });

  app.get<{ Params: { id: string } }>(
    '/portal/documents/:id/download',
    { preHandler: [app.authenticateClient] },
    async (request, reply) => {
      const client = request.client!;
      const id = z.uuid().parse(request.params.id);
      const doc = await downloadDocument(
        app,
        minio,
        { type: 'client', id: client.portalUserId, label: client.email, ip: request.ip },
        id,
        { clientContactId: client.contactId }
      );
      reply.header('content-disposition', `attachment; filename="${doc.filename.replace(/"/g, '')}"`);
      if (doc.mimeType) reply.type(doc.mimeType);
      return reply.send(doc.stream);
    }
  );

  // Open document requests + items — what the portal shows under "we need from you".
  app.get('/portal/document-requests', { preHandler: [app.authenticateClient] }, async (request) => {
    const client = request.client!;
    const { rows } = await app.db.query(
      `SELECT dr.id, dr.status, dr.title_en, dr.title_es, dr.note_en, dr.note_es, dr.due_date,
              COALESCE(json_agg(json_build_object(
                'id', i.id, 'labelEn', i.label_en, 'labelEs', i.label_es, 'status', i.status
              ) ORDER BY i.created_at) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
       FROM document_requests dr
       LEFT JOIN document_request_items i ON i.request_id = dr.id
       WHERE dr.contact_id = $1 AND dr.status IN ('open', 'partially_received')
       GROUP BY dr.id
       ORDER BY dr.created_at DESC`,
      [client.contactId]
    );
    return { requests: rows };
  });

  // ── Staff ─────────────────────────────────────────────────────────────────
  app.post(
    '/documents',
    { preHandler: [app.authenticate, requirePermission('documents.write')] },
    async (request, reply) => {
      const staff = request.staff!;
      const { data, buffer } = await readUpload(request);
      const fields = StaffUploadFields.parse(fieldValues(data));
      const result = await uploadDocument(
        app,
        minio,
        { type: 'staff', id: staff.id, label: staff.email, ip: request.ip },
        {
          contactId: fields.contactId,
          category: fields.category,
          filename: data.filename,
          mimeType: data.mimetype,
          buffer,
          taxYear: fields.taxYear,
          taxEngagementId: fields.taxEngagementId,
          businessId: fields.businessId,
        }
      );
      // Return delivery: notify the client + advance the stage (MP ATX handoff).
      let stageMoved = false;
      if (fields.category === 'return_deliverable' && fields.taxEngagementId) {
        const delivered = await afterReturnDelivered(
          app,
          { staffId: staff.id, label: staff.email },
          fields.taxEngagementId
        );
        stageMoved = delivered.stageMoved;
      }
      return reply.code(201).send({ ...result, stageMoved });
    }
  );

  app.get<{ Params: { id: string } }>(
    '/documents/:id/download',
    { preHandler: [app.authenticate, requirePermission('documents.read')] },
    async (request, reply) => {
      const staff = request.staff!;
      const id = z.uuid().parse(request.params.id);
      const doc = await downloadDocument(
        app,
        minio,
        { type: 'staff', id: staff.id, label: staff.email, ip: request.ip },
        id,
        {}
      );
      reply.header('content-disposition', `attachment; filename="${doc.filename.replace(/"/g, '')}"`);
      if (doc.mimeType) reply.type(doc.mimeType);
      return reply.send(doc.stream);
    }
  );

  app.patch<{ Params: { id: string } }>(
    '/documents/:id',
    { preHandler: [app.authenticate, requirePermission('documents.write')] },
    async (request) => {
      const id = z.uuid().parse(request.params.id);
      const b = StatusBody.parse(request.body);
      const { rows } = await app.db.query<{ contact_id: string }>(
        `UPDATE documents SET status = $2::document_status,
                archived_at = CASE WHEN $2 = 'archived' THEN now() ELSE archived_at END
         WHERE id = $1 RETURNING contact_id`,
        [id, b.status]
      );
      if (!rows[0]) throw new AppError(404, 'not_found', 'Document not found.');
      await writeAudit(app.db, {
        actorType: 'staff', actorId: request.staff!.id, actorLabel: request.staff!.email,
        action: 'document.status_changed', objectType: 'document', objectId: id,
        contactId: rows[0].contact_id, ip: request.ip,
        details: { status: b.status },
      });
      return { status: 'ok' };
    }
  );

  app.post('/jobs/document-chase', { preHandler: [app.authenticate, requirePermission('jobs.run')] }, async (request) => {
    const q = z.object({ asOf: z.iso.date().optional() }).parse(request.query);
    return runDocumentChaseJob(app, q.asOf ?? todayChicago());
  });
}
