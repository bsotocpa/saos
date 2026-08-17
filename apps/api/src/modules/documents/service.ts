// Document service (MP Document Center + WISP): every upload, download, and
// status change is audit-logged — the audit write happens BEFORE bytes move,
// so a failed audit means no access (fail closed). No feature touches client
// documents without coverage here.

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Client as MinioClient } from 'minio';
import { writeAudit } from '../../audit.ts';
import { isAutomationEnabled } from '../../automations.ts';
import { AppError } from '../../types.ts';
import { allActiveByRoles, firstActiveByRole, notifyOnce, ownerForRole } from '../../staffing.ts';
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

  /*
   * FINDING #14 — scan on intake, but NEVER refuse on intake.
   *
   * Brian's ruling: an upload is always accepted and stored. Our scanner being
   * wedged is our problem, not the client's, and refusing uploads would put it on
   * them at the surface they use most. What IS gated is filing: the document does
   * not satisfy a document request until the verdict is clean.
   *
   * A scan failure must not fail the upload either — the bytes are already in MinIO
   * and the row already exists, so an exception here would report failure for work
   * that succeeded, and the client would upload again.
   */
  const verdict = await recordScan(app, id, input.buffer, input.contactId, actor).catch(
    (err): ScanStatus => {
      app.log.error({ err, documentId: id }, 'scan bookkeeping failed — leaving pending_scan for the rescan job');
      return 'pending_scan';
    }
  );

  // Tie the upload to its document-request item, roll up request completion — only
  // when the verdict permits FILING (see mayFile). Anything else defers, and the
  // rescan job finishes the job when the scanner comes back. A skipped scan is not a
  // pass; the client keeps their file either way.
  if (input.documentRequestItemId) {
    if (mayFile(verdict)) {
      await fulfillRequestItem(app, input.documentRequestItemId, id, input.contactId);
    } else {
      await app.db.query(`UPDATE documents SET pending_request_item_id = $2 WHERE id = $1`, [
        id,
        input.documentRequestItemId,
      ]);
    }
  }

  /*
   * PORTAL-UPLOAD ACK (Brian's ruling, 2026-08-13).
   *
   * The rehearsal exercises the ack system on the path real clients use most, and
   * attachment_acks does not cover it — that one exists to redirect people away from
   * emailing files, and its copy points at the portal. Sending it to someone who just
   * used the portal would tell them to do the thing they did.
   *
   * Client uploads only: a staff upload is not something to thank the client for.
   * Never for an infected file — that conversation is Brian's, not an automation's.
   * Throttled, because ten files in one sitting is one session, not ten receipts.
   */
  if (actor.type === 'client' && verdict !== 'infected') {
    await maybeAckPortalUpload(app, input.contactId, input.filename).catch((err) =>
      // A failed ack must not fail an upload that already succeeded.
      app.log.error({ err, documentId: id }, 'portal upload ack failed')
    );
  }

  return { id };
}

/**
 * Send at most one upload receipt per client per throttle window.
 *
 * The throttle reads the audit log rather than keeping its own state: `document.ack_sent`
 * is already the durable record of what we told the client, so a second source of truth
 * would only be able to disagree with it.
 */
async function maybeAckPortalUpload(
  app: FastifyInstance,
  contactId: string,
  filename: string
): Promise<void> {
  if (!(await isAutomationEnabled(app, 'portal_upload_acks'))) {
    await writeAudit(app.db, {
      actorType: 'system',
      actorLabel: 'portal upload ack',
      action: 'document.ack_suppressed',
      objectType: 'contact',
      objectId: contactId,
      contactId,
      details: { reason: 'automation_disabled' },
    });
    return;
  }

  const throttle = await app.db.query<{ minutes: number }>(
    `SELECT (value)::text::int AS minutes FROM app_settings
      WHERE key = 'documents.upload_ack_throttle_minutes'`
  );
  const minutes = throttle.rows[0]?.minutes ?? 30;

  if (minutes > 0) {
    const recent = await app.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE action = 'document.ack_sent' AND contact_id = $1
          AND occurred_at > now() - ($2 || ' minutes')::interval`,
      [contactId, String(minutes)]
    );
    if (recent.rows[0]!.n > 0) {
      await writeAudit(app.db, {
        actorType: 'system',
        actorLabel: 'portal upload ack',
        action: 'document.ack_suppressed',
        objectType: 'contact',
        objectId: contactId,
        contactId,
        details: { reason: 'throttled', window_minutes: minutes },
      });
      return;
    }
  }

  const contact = await app.db.query<{ first_name: string; email: string | null; language: 'en' | 'es' }>(
    `SELECT first_name, email, language FROM contacts WHERE id = $1`,
    [contactId]
  );
  const c = contact.rows[0];
  if (!c?.email) return;

  await sendTemplatedEmail(app, {
    to: c.email,
    templateKey: 'portal_upload_received_email',
    language: c.language,
    contactId,
    vars: {
      first_name: c.first_name,
      // Names the file when there is one, stays honest when a session had several.
      document_summary: `your upload (${filename})`,
    },
  });

  await writeAudit(app.db, {
    actorType: 'system',
    actorLabel: 'portal upload ack',
    action: 'document.ack_sent',
    objectType: 'contact',
    objectId: contactId,
    contactId,
    details: { filename },
  });
}

/**
 * A client uploaded the wrong file and needs an undo.
 *
 * Brian's ruling (2026-08-13): WITHDRAW, not delete. Client documents are audit-logged,
 * virus-scanned and filed against document requests, and the retention rule says every
 * access and change is recorded — so a hard delete would satisfy the button and violate
 * the rule behind it.
 *
 * Withdrawing:
 *   · hides the file from the client's active list and from staff filing surfaces
 *   · UN-FULFILS the document request it was satisfying, so the chase RESUMES — the
 *     alternative is a request that looks answered by a file nobody can see
 *   · keeps the row and the stored object, stamped with who withdrew it and when
 *
 * Idempotent: withdrawing an already-withdrawn document is a no-op, not an error, so a
 * double tap on a phone cannot produce a confusing failure.
 */
export async function withdrawDocument(
  app: FastifyInstance,
  documentId: string,
  actor: UploadActor,
  opts: { reason?: string | undefined; clientContactId?: string | undefined } = {}
): Promise<{ withdrawn: boolean; requestItemReopened: boolean }> {
  const { rows } = await app.db.query<{
    id: string; contact_id: string; filename: string; withdrawn_at: Date | null;
  }>(
    `SELECT id, contact_id, filename, withdrawn_at FROM documents WHERE id = $1 AND archived_at IS NULL`,
    [documentId]
  );
  const doc = rows[0];
  // Same fail-closed rule as download: someone else's document does not exist to you.
  if (!doc || (opts.clientContactId !== undefined && doc.contact_id !== opts.clientContactId)) {
    throw new AppError(404, 'not_found', 'Document not found.');
  }
  if (doc.withdrawn_at) return { withdrawn: true, requestItemReopened: false };

  await app.db.query(
    `UPDATE documents
        SET withdrawn_at = now(), withdrawn_by_type = $2::uploader_type,
            withdrawn_by_id = $3, withdrawn_reason = $4
      WHERE id = $1`,
    [documentId, actor.type, actor.id ?? null, opts.reason ?? null]
  );

  // Re-open whatever this file was answering. A request that still reads "received"
  // while the file is gone is worse than one that plainly still wants something.
  const reopened = await app.db.query(
    `UPDATE document_request_items
        SET status = 'pending', document_id = NULL
      WHERE document_id = $1
      RETURNING request_id`,
    [documentId]
  );
  for (const r of reopened.rows) {
    await app.db.query(
      `UPDATE document_requests
          SET status = 'open', completed_at = NULL
        WHERE id = $1`,
      [(r as { request_id: string }).request_id]
    );
  }
  // The deferred-filing pointer must go too, or the rescan job would re-file it.
  await app.db.query(`UPDATE documents SET pending_request_item_id = NULL WHERE id = $1`, [documentId]);

  await writeAudit(app.db, {
    actorType: actor.type,
    actorId: actor.id ?? null,
    actorLabel: actor.label ?? null,
    action: 'document.withdrawn',
    objectType: 'document',
    objectId: documentId,
    contactId: doc.contact_id,
    ip: actor.ip,
    details: { filename: doc.filename, reason: opts.reason ?? null, request_items_reopened: reopened.rowCount },
  });

  return { withdrawn: true, requestItemReopened: (reopened.rowCount ?? 0) > 0 };
}

export type ScanStatus = 'pending_scan' | 'clean' | 'infected' | 'skipped' | 'not_configured';

/**
 * May a document with this verdict be FILED — i.e. count as satisfying a document
 * request, so we stop chasing the client for it?
 *
 * 'clean' obviously. 'not_configured' because a deployment with no scanner at all is
 * dev or test, where the alternative is that no document can ever file and every
 * local flow is broken. Production cannot be in that state: loadConfig() refuses to
 * boot without CLAMAV_HOST. The safety lives in that assertion, not here.
 *
 * Everything else — pending_scan, skipped, infected — is fail-closed. A skipped scan
 * is not a pass.
 */
export function mayFile(status: ScanStatus): boolean {
  return status === 'clean' || status === 'not_configured';
}

/**
 * Scan bytes and record the verdict on the document. Returns the stored status.
 *
 * Every verdict is audit-logged, including 'skipped' — an unscanned client document
 * is exactly the kind of thing that must be reconstructable later, and "we never
 * scanned it because clamd was down for thirteen hours" is only provable if the
 * skip left a row.
 */
export async function recordScan(
  app: FastifyInstance,
  documentId: string,
  buffer: Buffer,
  contactId: string,
  actor: UploadActor
): Promise<ScanStatus> {
  const { scanBuffer } = await import('../comms/scan.ts');
  const result = await scanBuffer(app.config, buffer);
  // 'skipped' covers two very different worlds: a scanner that is BROKEN and a
  // deployment that has none. Config is authoritative about which — never the detail
  // string, which is prose and could be reworded by anyone.
  const status: ScanStatus =
    result.status === 'skipped' && !app.config.CLAMAV_HOST ? 'not_configured' : result.status;

  await app.db.query(
    `UPDATE documents
        SET scan_status = $2::document_scan_status, scan_detail = $3, scanned_at = now(),
            scan_attempts = scan_attempts + 1
      WHERE id = $1`,
    [documentId, status, result.detail]
  );

  await writeAudit(app.db, {
    actorType: 'system',
    actorId: null,
    actorLabel: 'virus scan',
    action: `document.scan.${status}`,
    objectType: 'document',
    objectId: documentId,
    contactId,
    ip: actor.ip ?? null,
    details: { status, detail: result.detail },
  });

  if (status === 'infected') {
    // Internal alert, never gated: nothing is sent to the client. They are not told
    // their file is infected by an automated message — Brian decides how that
    // conversation happens.
    const owner = await firstActiveByRole(app.db, 'ceo');
    await createTask(app, {
      title: 'Infected client upload quarantined',
      description:
        `A client upload failed the virus scan (${result.detail ?? 'no detail recorded'}).\n\n` +
        'The file is stored but cannot be filed against a document request and cannot be ' +
        'downloaded by anyone. It does not satisfy whatever we asked the client for, so the ' +
        'request is still outstanding.\n\n' +
        'Decide how to ask for a replacement. The system deliberately does NOT tell the client ' +
        'their file was infected — that message is yours to write, and an automated ' +
        '"your file has a virus" email to a client who is probably not at fault is not it.',
      contactId,
      assignedStaffId: owner,
      source: 'system',
      sourceType: 'document_infected',
      sourceId: documentId,
      priority: 2,
    }).catch((err) => app.log.error({ err, documentId }, 'could not raise infected-file task'));
  }

  return status;
}

export async function fulfillRequestItem(
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
    minio_bucket: string; minio_key: string; scan_status: string;
  }>(
    `SELECT id, contact_id, filename, mime_type, minio_bucket, minio_key,
            scan_status::text AS scan_status
     FROM documents WHERE id = $1 AND archived_at IS NULL`,
    [documentId]
  );
  const doc = rows[0];
  // Row-level rule: a client asking for someone else's document sees the same
  // 404 as for a nonexistent one (fail closed, no existence oracle).
  if (!doc || (scope.clientContactId !== undefined && doc.contact_id !== scope.clientContactId)) {
    throw new AppError(404, 'not_found', 'Document not found.');
  }

  /*
   * FINDING #14: an infected file is not downloadable by ANYONE — not staff, not the
   * client who uploaded it. Handing malware to a staff machine because the row
   * happens to be in a client folder would defeat the point of scanning it.
   *
   * Only 'infected' blocks. 'pending_scan' and 'skipped' still download: intake never
   * refuses, so a client must be able to see and retrieve the file they just sent,
   * and blocking staff during a scanner outage would break normal work over an
   * infrastructure problem. Those states are blocked from FILING, which is the gate
   * Brian specified.
   */
  if (doc.scan_status === 'infected') {
    throw new AppError(
      409,
      'infected',
      'This file failed the virus scan and cannot be downloaded. Ask the client to re-upload it through the portal.'
    );
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
): Promise<{ skipped: boolean; reminders: number; nonResponseAlerts: number; suppressed?: number }> {
  const ACTION = 'job.document_chase';
  const already = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = $1 AND details->>'run_date' = $2 LIMIT 1`,
    [ACTION, today]
  );
  if (already.rows.length > 0) return { skipped: true, reminders: 0, nonResponseAlerts: 0 };

  // Kill switch covers the CLIENT reminder only — the internal 7-day
  // non-response alert to leadership still fires below.
  const chaseArmed = await isAutomationEnabled(app, 'document_chase');

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
  let suppressed = 0;
  for (const r of due.rows) {
    if (!r.email) continue;
    if (!chaseArmed) { suppressed++; continue; }
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
    const rene = await ownerForRole(app.db, 'comms_billing');
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
    details: { run_date: today, reminders, non_response_alerts: nonResponseAlerts, suppressed, automation_disabled: !chaseArmed },
  });
  return { skipped: false, reminders, nonResponseAlerts, suppressed };
}
