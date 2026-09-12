/*
 * THE SIGNED 8879 IS A DOCUMENT (2026-09-12, Brian's ruling).
 *
 * The remote e-sign path is retired: no KBA vendor, no Docuseal template. Form 8879 is signed
 * wet, in the office, scanned, and uploaded to the return as a Signed Authorization with the
 * date it was signed and whose PTIN is on it. THAT UPLOAD is what moves the return past the
 * authorization gate. Nothing else in SAOS may stamp `f8879_signed_at`, and the filed gate
 * checks for the document, not just the timestamp — a timestamp with no document behind it is
 * exactly the claim this rule forbids.
 */
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types.ts';
import { writeAudit } from '../../audit.ts';

export interface Signed8879Input {
  taxEngagementId: string;
  /** The uploaded scan, already in Signed Authorizations and linked to this return. */
  documentId: string;
  /** The date on the signature, a calendar day. */
  signedOn: string;
  /** Whose PTIN is on the 8879 — the paid preparer of record. */
  preparerPtinHolderId: string;
}

export async function recordSigned8879(
  app: FastifyInstance,
  actor: { staffId: string; label: string; ip?: string | null; userAgent?: string | null },
  input: Signed8879Input
): Promise<{ taxEngagementId: string; signedOn: string }> {
  const te = await app.db.query<{ id: string; contact_id: string; f8879_document_id: string | null; preparer_ptin_holder_id: string | null }>(
    `SELECT te.id, e.contact_id, te.f8879_document_id, te.preparer_ptin_holder_id
       FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id WHERE te.id = $1`,
    [input.taxEngagementId]
  );
  const row = te.rows[0];
  if (!row) throw new AppError(404, 'not_found', 'Tax engagement not found.');
  if (row.f8879_document_id) throw new AppError(409, 'f8879_already_on_file', 'A signed 8879 is already on file for this return.');

  const doc = await app.db.query<{ id: string; category: string; tax_engagement_id: string | null; contact_id: string }>(
    `SELECT id, category::text AS category, tax_engagement_id, contact_id FROM documents WHERE id = $1`,
    [input.documentId]
  );
  const d = doc.rows[0];
  if (!d) throw new AppError(404, 'document_not_found', 'The signed authorization document was not found.');
  if (d.category !== 'signed_authorizations') throw new AppError(409, 'wrong_category', `A signed 8879 must be filed under Signed Authorizations, not '${d.category}'.`);
  if (d.contact_id !== row.contact_id) throw new AppError(409, 'wrong_client', 'That document belongs to a different client.');
  if (d.tax_engagement_id && d.tax_engagement_id !== row.id) throw new AppError(409, 'wrong_return', 'That document is linked to a different return.');

  const holder = await app.db.query(`SELECT 1 FROM staff WHERE id = $1 AND is_active`, [input.preparerPtinHolderId]);
  if (!holder.rows.length) throw new AppError(409, 'preparer_unknown', 'The preparer of record must be an active staff member.');

  await app.db.query(
    `UPDATE tax_engagements
        SET f8879_signed_at = $2::date::timestamptz,
            f8879_signature_method = 'in_person_wet',
            f8879_document_id = $3,
            preparer_ptin_holder_id = COALESCE(preparer_ptin_holder_id, $4::uuid)
      WHERE id = $1`,
    [row.id, input.signedOn, d.id, input.preparerPtinHolderId]
  );
  await app.db.query(`UPDATE documents SET tax_engagement_id = COALESCE(tax_engagement_id, $2) WHERE id = $1`, [d.id, row.id]);
  // One queryable record of signature status, the same table the retired remote path used.
  await app.db.query(
    `INSERT INTO signature_envelopes
       (contact_id, tax_engagement_id, type, status, signature_method, signed_document_id, completed_at, created_by_staff_id)
     VALUES ($1, $2, 'f8879', 'completed', 'in_person_wet', $3, $4::date::timestamptz, $5)`,
    [row.contact_id, row.id, d.id, input.signedOn, actor.staffId]
  );
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.staffId, actorLabel: actor.label,
    action: 'signature.recorded_wet', objectType: 'tax_engagement', objectId: row.id, contactId: row.contact_id,
    ip: actor.ip ?? null, userAgent: actor.userAgent ?? null,
    details: { type: 'f8879', document_id: d.id, signed_on: input.signedOn, preparer_ptin_holder_id: input.preparerPtinHolderId },
  });
  return { taxEngagementId: row.id, signedOn: input.signedOn };
}
