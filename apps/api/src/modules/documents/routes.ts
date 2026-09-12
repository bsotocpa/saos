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
import { firstActiveByRole } from '../../staffing.ts';
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
  /** A signed 8879 (category signed_authorizations + taxEngagementId): the date on the signature and whose PTIN is on it. */
  signedOn: z.iso.date().optional(),
  preparerPtinHolderId: z.uuid().optional(),
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
      { type: 'client', id: client.portalUserId, label: client.displayName, ip: request.ip },
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

  /**
   * ATTACH A FILE IN MESSAGES (finding #11) — a portal upload that happens to start
   * in chat. Clients will try to send files in the conversation, so this meets them
   * there while keeping the pipeline underneath.
   *
   * It lives in THIS module, beside /portal/documents, and calls uploadDocument with
   * the identical actor and input shape. That is the point: Brian's requirement is
   * that downstream filing, chase and Documents logic cannot distinguish a
   * Messages-originated file from a direct portal upload. There is no source flag on
   * the document — nothing for that logic to branch on. The only linkage is
   * messages.document_id, pointing one way.
   *
   * No quarantine: the client is authenticated, exactly as on the Documents page.
   */
  app.post('/portal/messages/attachments', { preHandler: [app.authenticateClient] }, async (request, reply) => {
    const client = request.client!;
    const { data, buffer } = await readUpload(request);
    const fields = z
      .object({
        category: z.enum(CLIENT_CATEGORIES),
        taxYear: z.coerce.number().int().optional(),
        documentRequestItemId: z.uuid().optional(),
        threadId: z.uuid().optional(),
        /** Optional note the client typed with the file. */
        note: z.string().max(2000).optional(),
      })
      .parse(fieldValues(data));

    // IDENTICAL to /portal/documents — same actor shape, same inputs, same function.
    const doc = await uploadDocument(
      app,
      minio,
      { type: 'client', id: client.portalUserId, label: client.displayName, ip: request.ip },
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

    // Thread: reuse the one they are in, or open one.
    let threadId = fields.threadId ?? null;
    if (threadId) {
      const owned = await app.db.query(
        `SELECT 1 FROM message_threads WHERE id = $1 AND contact_id = $2`,
        [threadId, client.contactId]
      );
      if (!owned.rows[0]) throw new AppError(404, 'not_found', 'Thread not found.');
    } else {
      const t = await app.db.query<{ id: string }>(
        `INSERT INTO message_threads (contact_id, subject) VALUES ($1, $2) RETURNING id`,
        [client.contactId, 'Portal message']
      );
      threadId = t.rows[0]!.id;
    }

    // IMMUTABLE TEXT + REFERENCE (Brian's ruling). The sentence is written once and
    // never recomputed from the document, so the conversation still reads correctly
    // if the file is later deleted or refiled; document_id is ON DELETE SET NULL, so
    // the link degrades rather than leaving a hole.
    const note = fields.note?.trim();
    const body = note
      ? `${note}\n\n[Attached: ${data.filename}]`
      : `[Attached: ${data.filename}]`;
    await app.db.query(
      `INSERT INTO messages (thread_id, direction, channel, sender_type, body, language, document_id)
       VALUES ($1, 'inbound', 'portal', 'client', $2, $3, $4)`,
      [threadId, body, client.language, doc.id]
    );
    await app.db.query(
      `UPDATE message_threads SET last_message_at = now(), status = 'open' WHERE id = $1`,
      [threadId]
    );

    const rene = await firstActiveByRole(app.db, 'comms_billing');
    if (rene) {
      await app.db.query(
        `INSERT INTO notifications (staff_id, type, severity, title, contact_id, related_object_type, related_object_id)
         VALUES ($1, 'portal_message', 'info', $2, $3, 'message_thread', $4)`,
        [rene, `File sent in Messages by ${client.email}`, client.contactId, threadId]
      );
    }

    return reply.code(201).send({ threadId, documentId: doc.id, filename: data.filename });
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
        { type: 'client', id: client.portalUserId, label: client.displayName, ip: request.ip },
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
        { type: 'staff', id: staff.id, label: staff.fullName, ip: request.ip },
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
      /*
       * THE SIGNED 8879 (2026-09-12): uploading the scan under Signed Authorizations with the
       * signed date and the preparer of record IS the authorization. Nothing else stamps it.
       */
      let signed8879 = false;
      if (fields.category === 'signed_authorizations' && fields.taxEngagementId && fields.signedOn && fields.preparerPtinHolderId) {
        const { recordSigned8879 } = await import('../tax/signed-8879.ts');
        await recordSigned8879(app, { staffId: staff.id, label: staff.fullName, ip: request.ip, userAgent: request.headers['user-agent'] ?? null }, {
          taxEngagementId: fields.taxEngagementId, documentId: result.id, signedOn: fields.signedOn, preparerPtinHolderId: fields.preparerPtinHolderId,
        });
        signed8879 = true;
      }
      // Return delivery: notify the client + advance the stage (MP ATX handoff).
      let stageMoved = false;
      if (fields.category === 'return_deliverable' && fields.taxEngagementId) {
        const delivered = await afterReturnDelivered(
          app,
          { staffId: staff.id, label: staff.fullName },
          fields.taxEngagementId
        );
        stageMoved = delivered.stageMoved;
      }
      return reply.code(201).send({ ...result, stageMoved, signed8879 });
    }
  );

  /**
   * A client's document list (M28 — the client packet needs it).
   *
   * METADATA ONLY: filename, category, size, dates. No bytes and no presigned
   * URLs, so this is not a download path — but it IS an access to client document
   * information, and CLAUDE.md requires every document access to be logged. So it
   * writes an audit row naming the staffer and the client, exactly like the
   * contact record view does. Downloading a file remains a separate, separately
   * audited act below.
   */
  app.get(
    '/documents',
    { preHandler: [app.authenticate, requirePermission('documents.read')] },
    async (request) => {
      const q = z
        .object({ contactId: z.uuid(), category: z.string().max(60).optional() })
        .parse(request.query);
      const staff = request.staff!;
      const params: unknown[] = [q.contactId];
      let categoryClause = '';
      if (q.category) {
        params.push(q.category);
        categoryClause = ` AND d.category = $${params.length}::document_category`;
      }
      const { rows } = await app.db.query(
        `SELECT d.id, d.category::text AS category, d.filename AS original_filename,
                d.mime_type, d.size_bytes, d.tax_year, d.status::text AS status,
                d.uploaded_by_type, d.created_at
         FROM documents d
         WHERE d.contact_id = $1 AND d.archived_at IS NULL${categoryClause}
         ORDER BY d.created_at DESC
         LIMIT 200`,
        params
      );
      await writeAudit(app.db, {
        actorType: 'staff',
        actorId: staff.id,
        actorLabel: staff.fullName,
        action: 'documents.listed',
        objectType: 'contact',
        objectId: q.contactId,
        contactId: q.contactId,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        details: { count: rows.length, category: q.category ?? null },
      });
      return { documents: rows };
    }
  );

  /*
   * FINDING #16 — the firm-wide document surface for staff.
   *
   * Every document endpoint before this one was scoped to a single contact, which
   * means answering "what is quarantined right now?" or "what is stuck awaiting a
   * scan?" required knowing which client to ask about first. After #14 made scan
   * status a real thing, that gap became the difference between a compliance control
   * existing and anyone being able to see it.
   *
   * Returns counts alongside rows so the surface can show what is wrong before you
   * filter for it — a quarantined file you have to go looking for is not visible.
   */
  app.get(
    '/documents/overview',
    { preHandler: [app.authenticate, requirePermission('documents.read')] },
    async (request) => {
      const staff = request.staff!;
      const q = z
        .object({
          scanStatus: z
            .enum(['pending_scan', 'clean', 'infected', 'skipped', 'not_configured'])
            .optional(),
          category: z.string().max(60).optional(),
          contactId: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        })
        .parse(request.query);

      // Counts are unfiltered by scanStatus on purpose: the chips must show the
      // quarantine count even while you are looking at something else.
      const counts = await app.db.query<{ status: string; n: number }>(
        `SELECT scan_status::text AS status, count(*)::int AS n
           FROM documents WHERE archived_at IS NULL
          GROUP BY scan_status`
      );

      const { rows } = await app.db.query(
        `SELECT d.id, d.filename, d.category::text AS category, d.size_bytes, d.created_at,
                d.scan_status::text AS scan_status, d.scan_detail, d.scanned_at,
                d.scan_attempts, d.pending_request_item_id IS NOT NULL AS filing_deferred,
                d.contact_id,
                nullif(trim(concat_ws(' ', c.first_name, c.last_name)), '') AS contact_name,
                c.is_test AS contact_is_test
           FROM documents d
           JOIN contacts c ON c.id = d.contact_id
          WHERE d.archived_at IS NULL
            AND ($1::text IS NULL OR d.scan_status::text = $1)
            AND ($2::text IS NULL OR d.category::text = $2)
            AND ($3::uuid IS NULL OR d.contact_id = $3)
          -- Infected first, then whatever is stuck, then the boring ones. The order IS
          -- the triage: the top of this list is the work.
          ORDER BY CASE d.scan_status
                     WHEN 'infected' THEN 0
                     WHEN 'pending_scan' THEN 1
                     WHEN 'skipped' THEN 2
                     ELSE 3
                   END,
                   d.created_at DESC
          LIMIT $4`,
        [q.scanStatus ?? null, q.category ?? null, q.contactId ?? null, q.limit]
      );

      await writeAudit(app.db, {
        actorType: 'staff',
        actorId: staff.id,
        actorLabel: staff.fullName,
        action: 'documents.listed',
        objectType: 'documents',
        objectId: null,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        details: { scope: 'firm_wide', count: rows.length, filters: q },
      });

      return {
        documents: rows,
        counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])),
      };
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
        { type: 'staff', id: staff.id, label: staff.fullName, ip: request.ip },
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
        actorType: 'staff', actorId: request.staff!.id, actorLabel: request.staff!.fullName,
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
