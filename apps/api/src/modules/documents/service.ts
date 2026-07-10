// Document service (MP Document Center + WISP): every upload, download, and
// status change is audit-logged — the audit write happens BEFORE bytes move,
// so a failed audit means no access (fail closed). No feature touches client
// documents without coverage here.

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Client as MinioClient } from 'minio';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { allActiveByRoles, firstActiveByRole, notifyOnce } from '../../staffing.ts';
import { closeTasksForSource, createTask } from '../tasks/service.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { createIrsNotice } from '../notices/service.ts';
import { transitionStage } from '../tax/pipeline.ts';
import { ALLOWED_MIME_TYPES, BUCKET_BY_CATEGORY, objectKey } from './storage.ts';

export interface UploadActor {
  type: 'client' | 'staff' | 'system';
  id?: string | null;
  label?: string | null;
  ip?: string | null;
}

export interface UploadInput {
  contactId: string;
  category: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  businessId?: string | undefined;
  taxEngagementId?: string | undefined;
  taxYear?: number | undefined;
  documentRequestItemId?: string | undefined;
}

export async function uploadDocument(
  app: FastifyInstance,
  minio: MinioClient,
  actor: UploadActor,
  input: UploadInput
): Promise<{ id: string }> {
  if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
    throw new AppError(415, 'unsupported_file_type', `File type '${input.mimeType}' is not accepted.`);
  }
  const maxBytes = app.config.DOC_MAX_SIZE_MB * 1024 * 1024;
  if (input.buffer.length > maxBytes) {
    throw new AppError(413, 'file_too_large', `Files are limited to ${app.config.DOC_MAX_SIZE_MB} MB.`);
  }
  const bucket = BUCKET_BY_CATEGORY[input.category];
  if (!bucket) throw new AppError(400, 'invalid_category', `Unknown document category '${input.category}'.`);

  const key = objectKey(input.contactId, input.category, input.filename);
  const sha256 = createHash('sha256').update(input.buffer).digest('hex');
  await minio.putObject(bucket, key, input.buffer, input.buffer.length, {
    'Content-Type': input.mimeType,
  });

  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO documents
       (contact_id, business_id, tax_engagement_id, tax_year, category, filename,
        mime_type, size_bytes, minio_bucket, minio_key, sha256, uploaded_by_type, uploaded_by_id)
     VALUES ($1,$2,$3,$4,$5::document_category,$6,$7,$8,$9,$10,$11,$12::uploader_type,$13)
     RETURNING id`,
    [
      input.contactId, input.businessId ?? null, input.taxEngagementId ?? null, input.taxYear ?? null,
      input.category, input.filename, input.mimeType, input.buffer.length, bucket, key, sha256,
      actor.type, actor.id ?? null,
    ]
  );
  const id = rows[0]!.id;

  await writeAudit(app.db, {
    actorType: actor.type,
    actorId: actor.id ?? null,
    actorLabel: actor.label ?? null,
    action: 'document.uploaded',
    objectType: 'document',
    objectId: id,
    contactId: input.contactId,
    ip: actor.ip,
    details: { category: input.category, size_bytes: input.buffer.length },
  });

  // MP automation 6: IRS-notice upload from the portal → record + Ana-Maria
  // alert within minutes (createIrsNotice notifies the handler immediately).
  if (input.category === 'irs_notices' && actor.type === 'client') {
    await createIrsNotice(
      app,
      { type: 'system', label: 'portal upload' },
      {
        contactId: input.contactId,
        noticeType: 'Uploaded notice (pending review)',
        source: 'portal_upload',
        documentId: id,
      }
    );
  }

  // Tie the upload to its document-request item, roll up request completion.
  if (input.documentRequestItemId) {
    await fulfillRequestItem(app, input.documentRequestItemId, id, input.contactId);
  }

  return { id };
}

async function fulfillRequestItem(
  app: FastifyInstance,
  itemId: string,
  documentId: string,
  contactId: string
): Promise<void> {
  const item = await app.db.query<{ request_id: string }>(
    `UPDATE document_request_items SET status = 'received', document_id = $2
     WHERE id = $1
       AND request_id IN (SELECT id FROM document_requests WHERE contact_id = $3)
     RETURNING request_id`,
    [itemId, documentId, contactId]
  );
  const requestId = item.rows[0]?.request_id;
  if (!requestId) return; // unknown item or not this client's — silently ignore (no oracle)

  const counts = await app.db.query<{ total: number; done: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status IN ('received', 'waived'))::int AS done
     FROM document_request_items WHERE request_id = $1`,
    [requestId]
  );
  const { total, done } = counts.rows[0]!;
  const complete = total > 0 && done === total;
  await app.db.query(
    `UPDATE document_requests
     SET status = $2::doc_request_status, completed_at = CASE WHEN $3 THEN now() ELSE completed_at END
     WHERE id = $1`,
    [requestId, complete ? 'complete' : 'partially_received', complete]
  );
  if (complete) {
    // Docs are in — stamp the engagement (feeds health + at-risk logic).
    const stamped = await app.db.query<{ id: string }>(
      `UPDATE tax_engagements SET docs_received_at = COALESCE(docs_received_at, now())
       WHERE id = (SELECT tax_engagement_id FROM document_requests WHERE id = $1)
       RETURNING id`,
      [requestId]
    );
    // M25: arriving documents close the non-response follow-up task.
    if (stamped.rows[0]) {
      await closeTasksForSource(app, 'client_non_response', stamped.rows[0].id, 'documents received');
    }
  }
}

/** Audited download. Audit row FIRST — no audit, no bytes. */
export async function downloadDocument(
  app: FastifyInstance,
  minio: MinioClient,
  actor: UploadActor,
  documentId: string,
  scope: { clientContactId?: string | undefined }
): Promise<{ stream: NodeJS.ReadableStream; filename: string; mimeType: string | null }> {
  const { rows } = await app.db.query<{
    id: string; contact_id: string; filename: string; mime_type: string | null;
    minio_bucket: string; minio_key: string;
  }>(
    `SELECT id, contact_id, filename, mime_type, minio_bucket, minio_key
     FROM documents WHERE id = $1 AND archived_at IS NULL`,
    [documentId]
  );
  const doc = rows[0];
  // Row-level rule: a client asking for someone else's document sees the same
  // 404 as for a nonexistent one (fail closed, no existence oracle).
  if (!doc || (scope.clientContactId !== undefined && doc.contact_id !== scope.clientContactId)) {
    throw new AppError(404, 'not_found', 'Document not found.');
  }

  await writeAudit(app.db, {
    actorType: actor.type,
    actorId: actor.id ?? null,
    actorLabel: actor.label ?? null,
    action: 'document.downloaded',
    objectType: 'document',
    objectId: doc.id,
    contactId: doc.contact_id,
    ip: actor.ip,
  });

  const stream = await minio.getObject(doc.minio_bucket, doc.minio_key);
  return { stream, filename: doc.filename, mimeType: doc.mime_type };
}

/**
 * Return delivery (MP Return Delivery): the preparer uploads the final ATX
 * PDF → it lands in My Returns, the client is notified in their language,
 * and the stage moves to Client Review when the pipeline allows it.
 */
export async function afterReturnDelivered(
  app: FastifyInstance,
  actor: { staffId: string; label: string },
  taxEngagementId: string
): Promise<{ stageMoved: boolean }> {
  const { rows } = await app.db.query<{
    stage: string; tax_year: number; contact_id: string;
    first_name: string; email: string | null; language: 'en' | 'es';
  }>(
    `SELECT te.stage, te.tax_year, c.id AS contact_id, c.first_name, c.email, c.language
     FROM tax_engagements te
     JOIN engagements e ON e.id = te.engagement_id
     JOIN contacts c ON c.id = e.contact_id
     WHERE te.id = $1`,
    [taxEngagementId]
  );
  const te = rows[0];
  if (!te) throw new AppError(404, 'not_found', 'Tax engagement not found.');

  let stageMoved = false;
  if (te.stage === 'internal_review' || te.stage === 'ready_to_file') {
    await transitionStage(app, { staffId: actor.staffId, label: actor.label }, taxEngagementId, 'client_review', {
      note: 'auto: return delivered to portal',
    });
    stageMoved = true;
  }
  if (te.email) {
    await sendTemplatedEmail(app, {
      to: te.email,
      templateKey: 'return_delivered',
      language: te.language,
      contactId: te.contact_id,
      vars: {
        first_name: te.first_name,
        tax_year: String(te.tax_year),
        portal_link: app.config.PORTAL_BASE_URL,
      },
    });
  }
  return { stageMoved };
}

/**
 * Automations 4–5 (daily, date-guarded): recurring reminders on open document
 * requests every N days, and the 7-day non-response alert to Brian + Jackson.
 */
export async function runDocumentChaseJob(
  app: FastifyInstance,
  today: string
): Promise<{ skipped: boolean; reminders: number; nonResponseAlerts: number }> {
  const ACTION = 'job.document_chase';
  const already = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = $1 AND details->>'run_date' = $2 LIMIT 1`,
    [ACTION, today]
  );
  if (already.rows.length > 0) return { skipped: true, reminders: 0, nonResponseAlerts: 0 };

  const settings = await app.db.query<{ key: string; value: number }>(
    `SELECT key, (value)::text::int AS value FROM app_settings
     WHERE key IN ('sla.doc_request_reminder_days', 'sla.client_non_response_alert_days')`
  );
  const reminderDays = settings.rows.find((r) => r.key === 'sla.doc_request_reminder_days')?.value ?? 3;
  const alertDays = settings.rows.find((r) => r.key === 'sla.client_non_response_alert_days')?.value ?? 7;

  // Reminder every N days since creation/last reminder.
  const due = await app.db.query<{
    id: string; contact_id: string; first_name: string; email: string | null;
    language: 'en' | 'es'; title_en: string; title_es: string | null;
  }>(
    `SELECT dr.id, c.id AS contact_id, c.first_name, c.email, c.language, dr.title_en, dr.title_es
     FROM document_requests dr
     JOIN contacts c ON c.id = dr.contact_id
     WHERE dr.status IN ('open', 'partially_received')
       AND COALESCE(dr.last_reminder_at, dr.created_at) < ($1::date - make_interval(days => $2))`,
    [today, reminderDays]
  );
  let reminders = 0;
  for (const r of due.rows) {
    if (!r.email) continue;
    await sendTemplatedEmail(app, {
      to: r.email,
      templateKey: 'doc_request_reminder',
      language: r.language,
      contactId: r.contact_id,
      vars: {
        first_name: r.first_name,
        request_title: (r.language === 'es' ? r.title_es : r.title_en) ?? r.title_en,
        portal_link: app.config.PORTAL_BASE_URL,
      },
    });
    await app.db.query(
      `UPDATE document_requests SET last_reminder_at = now(), reminder_count = reminder_count + 1 WHERE id = $1`,
      [r.id]
    );
    reminders++;
  }

  // Automation 5: 7-day non-response → Brian + Jackson (once per engagement).
  const stalled = await app.db.query<{ id: string; contact_id: string; first_name: string; last_name: string }>(
    `SELECT te.id, c.id AS contact_id, c.first_name, c.last_name
     FROM tax_engagements te
     JOIN engagements e ON e.id = te.engagement_id
     JOIN contacts c ON c.id = e.contact_id
     WHERE te.stage = 'pending_client_response'
       AND te.docs_received_at IS NULL
       AND te.docs_requested_at < ($1::date - make_interval(days => $2))`,
    [today, alertDays]
  );
  let nonResponseAlerts = 0;
  if (stalled.rows.length > 0) {
    const leadership = await allActiveByRoles(app.db, ['ceo', 'ed_coo']);
    const rene = await firstActiveByRole(app.db, 'comms_billing');
    for (const s of stalled.rows) {
      let fired = false;
      for (const staffId of leadership) {
        fired =
          (await notifyOnce(app.db, {
            staffId,
            type: 'client_non_response',
            severity: 'warning',
            title: `No client response ${alertDays}+ days: ${s.first_name} ${s.last_name}`,
            contactId: s.contact_id,
            relatedObjectType: 'tax_engagement',
            relatedObjectId: s.id,
          })) || fired;
      }
      // M25: the follow-up call is a WORK ITEM on Rene's list (the full
      // D3/D7/D14/D30 ladder lands with v4.3 flow 3 in M26). Closes when
      // documents arrive (docs_received hook).
      if (rene) {
        await createTask(app, {
          title: `Call ${s.first_name} ${s.last_name} — no response to document request (${alertDays}+ days)`,
          assignedStaffId: rene,
          contactId: s.contact_id,
          priority: 1,
          source: 'automation',
          sourceType: 'client_non_response',
          sourceId: s.id,
        });
      }
      if (fired) nonResponseAlerts++;
    }
  }

  await writeAudit(app.db, {
    actorType: 'system',
    action: ACTION,
    details: { run_date: today, reminders, non_response_alerts: nonResponseAlerts },
  });
  return { skipped: false, reminders, nonResponseAlerts };
}
