// Inbound attachment pipeline (decided 2026-08-09): ACCEPT, NEVER REJECT.
// Email/MMS attachments are virus-scanned on arrival and held in the
// saos-quarantine bucket, attached to the client THREAD — never a document
// folder. A warm auto-ack nudges the sender to the secure portal link for
// next time (the block-and-nudge rule, both channels). Staff file/reassign/
// discard from the unified inbox; filing goes through uploadDocument (full
// audit, notice hooks, request fulfillment) with origin channel + confirming
// staffer recorded. Unmatched senders never get category auto-suggestions.

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { firstActiveByRole, notifyOnce } from '../../staffing.ts';
import { makeMinioClient } from '../documents/storage.ts';
import { uploadDocument } from '../documents/service.ts';
import { scanBuffer } from './scan.ts';

export const QUARANTINE_BUCKET = 'saos-quarantine';

export interface IngestInput {
  channel: 'email' | 'mms';
  originRef: string;
  sender: string;
  contactId?: string | null | undefined;
  threadId?: string | null | undefined;
  messageId?: string | null | undefined;
  filename: string;
  mimeType?: string | null | undefined;
  buffer: Buffer;
}

/**
 * Suggested filing category from filename/mime heuristics. ONLY for matched
 * senders — an unmatched sender's attachment is triage-only by rule, so the
 * caller must pass contactMatched=false and get null.
 */
export function suggestCategory(filename: string, mimeType: string | null, contactMatched: boolean): string | null {
  if (!contactMatched) return null;
  const f = filename.toLowerCase();
  if (/(irs|cp\d{2,4}|lt\d{2}|notice|letter[ _-]?from)/.test(f)) return 'irs_notices';
  if (/(w-?2|1099|1098|k-?1|w-?9|tax|return|8879|schedule)/.test(f)) return 'tax_documents';
  if (/(license|passport|id[ _-]|dl[ _-]|identification)/.test(f)) return 'id_verification';
  if (/(bank|statement|invoice|receipt|payroll|p&l|profit|ledger|balance)/.test(f)) return 'business_records';
  if (mimeType?.startsWith('image/') || mimeType === 'application/pdf') return 'tax_documents';
  return 'other';
}

export async function ingestInboundAttachment(
  app: FastifyInstance,
  input: IngestInput
): Promise<{ id: string; scanStatus: string }> {
  const minio = makeMinioClient(app.config);
  const sha256 = createHash('sha256').update(input.buffer).digest('hex');
  const scan = await scanBuffer(app.config, input.buffer);

  const safeName = input.filename.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'attachment';
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO inbound_attachments
       (channel, origin_ref, sender, contact_id, thread_id, message_id, filename, mime_type,
        size_bytes, minio_bucket, minio_key, sha256, scan_status, scan_detail, suggested_category)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::attachment_scan_status,$14,$15::document_category)
     RETURNING id`,
    [
      input.channel, input.originRef, input.sender, input.contactId ?? null, input.threadId ?? null,
      input.messageId ?? null, safeName, input.mimeType ?? null, input.buffer.length,
      QUARANTINE_BUCKET, 'pending', sha256, scan.status, scan.detail,
      suggestCategory(safeName, input.mimeType ?? null, Boolean(input.contactId)),
    ]
  );
  const id = rows[0]!.id;
  const key = `${input.channel}/${id}/${safeName}`;
  await minio.putObject(QUARANTINE_BUCKET, key, input.buffer, input.buffer.length, {
    'Content-Type': input.mimeType ?? 'application/octet-stream',
  });
  await app.db.query(`UPDATE inbound_attachments SET minio_key = $2 WHERE id = $1`, [id, key]);

  await writeAudit(app.db, {
    actorType: 'system', actorLabel: `${input.channel}-inbound`,
    action: 'attachment.quarantined', objectType: 'inbound_attachment', objectId: id,
    contactId: input.contactId ?? null,
    details: { channel: input.channel, origin_ref: input.originRef, scan: scan.status, size_bytes: input.buffer.length },
  });

  // Unified inbox alert — Rene owns triage.
  const rene = await firstActiveByRole(app.db, 'comms_billing');
  if (rene) {
    await notifyOnce(app.db, {
      staffId: rene,
      type: 'attachment_quarantined',
      severity: 'info',
      title: `Attachment received by ${input.channel.toUpperCase()} — review and file`,
      contactId: input.contactId ?? null,
      relatedObjectType: 'inbound_attachment',
      relatedObjectId: id,
    });
  }

  return { id, scanStatus: scan.status };
}

interface AttachmentRow {
  id: string; channel: string; origin_ref: string; sender: string;
  contact_id: string | null; thread_id: string | null; filename: string;
  mime_type: string | null; size_bytes: string; minio_bucket: string; minio_key: string;
  scan_status: string; status: string; suggested_category: string | null;
}

async function loadQuarantined(app: FastifyInstance, id: string): Promise<AttachmentRow> {
  const { rows } = await app.db.query<AttachmentRow>(
    `SELECT id, channel, origin_ref, sender, contact_id, thread_id, filename, mime_type,
            size_bytes::text AS size_bytes, minio_bucket, minio_key, scan_status, status, suggested_category
     FROM inbound_attachments WHERE id = $1`,
    [id]
  );
  if (!rows[0]) throw new AppError(404, 'not_found', 'Attachment not found.');
  if (rows[0].status !== 'quarantined') throw new AppError(409, 'already_resolved', `Attachment is already ${rows[0].status}.`);
  return rows[0];
}

/** The confirm tap: quarantine → encrypted client folder, origin audited. */
export async function fileAttachment(
  app: FastifyInstance,
  id: string,
  opts: { category: string; contactId?: string | null; actor: { id: string; email: string }; ip?: string | null }
): Promise<{ documentId: string }> {
  const att = await loadQuarantined(app, id);
  if (att.scan_status === 'infected') {
    throw new AppError(409, 'infected', 'This attachment failed the virus scan — it cannot be filed. Discard it and request a portal re-upload.');
  }
  const contactId = opts.contactId ?? att.contact_id;
  if (!contactId) throw new AppError(400, 'no_contact', 'Assign a contact before filing (unmatched senders are triage-only).');

  const minio = makeMinioClient(app.config);
  const stream = await minio.getObject(att.minio_bucket, att.minio_key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const buffer = Buffer.concat(chunks);

  const doc = await uploadDocument(
    app, minio,
    { type: 'staff', id: opts.actor.id, label: opts.actor.email, ip: opts.ip ?? null },
    { contactId, category: opts.category, filename: att.filename, mimeType: att.mime_type ?? 'application/octet-stream', buffer }
  );

  await minio.removeObject(att.minio_bucket, att.minio_key);
  await app.db.query(
    `UPDATE inbound_attachments
     SET status = 'filed', contact_id = $2, filed_document_id = $3, confirmed_by_staff_id = $4, confirmed_at = now()
     WHERE id = $1`,
    [id, contactId, doc.id, opts.actor.id]
  );
  await writeAudit(app.db, {
    actorType: 'staff', actorId: opts.actor.id, actorLabel: opts.actor.email,
    action: 'attachment.filed', objectType: 'inbound_attachment', objectId: id,
    contactId, ip: opts.ip ?? null,
    details: { origin_channel: att.channel, origin_ref: att.origin_ref, category: opts.category, document_id: doc.id },
  });
  return { documentId: doc.id };
}

export async function reassignAttachment(
  app: FastifyInstance,
  id: string,
  contactId: string,
  actor: { id: string; email: string }
): Promise<void> {
  const att = await loadQuarantined(app, id);
  const contact = await app.db.query(`SELECT 1 FROM contacts WHERE id = $1`, [contactId]);
  if (contact.rows.length === 0) throw new AppError(404, 'not_found', 'Contact not found.');
  await app.db.query(
    `UPDATE inbound_attachments SET contact_id = $2, suggested_category = $3::document_category WHERE id = $1`,
    [id, contactId, suggestCategory(att.filename, att.mime_type, true)]
  );
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'attachment.reassigned', objectType: 'inbound_attachment', objectId: id,
    contactId,
    details: { origin_channel: att.channel, from_contact: att.contact_id },
  });
}

export async function discardAttachment(
  app: FastifyInstance,
  id: string,
  actor: { id: string; email: string },
  reason?: string
): Promise<void> {
  const att = await loadQuarantined(app, id);
  const minio = makeMinioClient(app.config);
  await minio.removeObject(att.minio_bucket, att.minio_key).catch(() => undefined);
  await app.db.query(
    `UPDATE inbound_attachments SET status = 'discarded', confirmed_by_staff_id = $2, confirmed_at = now() WHERE id = $1`,
    [id, actor.id]
  );
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'attachment.discarded', objectType: 'inbound_attachment', objectId: id,
    contactId: att.contact_id,
    details: { origin_channel: att.channel, origin_ref: att.origin_ref, reason: reason ?? null, scan: att.scan_status },
  });
}
