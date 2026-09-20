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
import { calendarDay, todayChicago } from './deadlines.ts';
import { AppError } from '../../types.ts';
import { writeAudit } from '../../audit.ts';

/**
 * The last calendar day of a return's tax year: the end of the entity's fiscal year end month
 * inside `taxYear` for a fiscal-year filer, else December 31 of `taxYear`. `null` or 12 is a
 * calendar-year filer, which is every individual and most entities.
 */
export function taxYearEndedOn(taxYear: number, fiscalYearEndMonth: number | null | undefined): string {
  const month = fiscalYearEndMonth && fiscalYearEndMonth >= 1 && fiscalYearEndMonth <= 12 ? fiscalYearEndMonth : 12;
  // Day 0 of the next month is the last day of this one, leap years included.
  const lastDay = new Date(Date.UTC(taxYear, month, 0)).getUTCDate();
  return `${taxYear}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

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
  const te = await app.db.query<{
    id: string; contact_id: string; f8879_document_id: string | null; preparer_ptin_holder_id: string | null;
    tax_year: number; fiscal_year_end_month: number | null;
  }>(
    `SELECT te.id, e.contact_id, te.f8879_document_id, te.preparer_ptin_holder_id, te.tax_year, b.fiscal_year_end_month
       FROM tax_engagements te
       JOIN engagements e ON e.id = te.engagement_id
       LEFT JOIN businesses b ON b.id = e.business_id
      WHERE te.id = $1`,
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

  /*
   * THE SIGNED DATE IS A PAST FACT (Brian, 2026-09-19): an 8879 signed before the SAOS record
   * existed is the ordinary case for a return filed in ATX; a date after today is not a signature
   * anyone has seen. Today in Chicago is the latest a scan can be dated.
   */
  if (calendarDay(input.signedOn, 'signedOn') > calendarDay(todayChicago(), 'today')) throw new AppError(409, 'signed_date_in_future', `The signed date ${input.signedOn} is after today; a signature is a thing that already happened.`);

  /*
   * NO BACKFILL MODE (Brian, 2026-09-19 evening, ruling 5). The other end of the same window: an
   * 8879 authorizes a return for a year, and nobody signs an authorization for a year that has not
   * finished. A date before the tax year ended is a typo, a wrong year on the record, or the scan
   * belonging to a different return — three things worth stopping, none of them worth guessing at.
   * The year end is the last day of the entity's fiscal year end month in the tax year for a
   * fiscal-year filer, December 31 of the tax year otherwise.
   */
  const yearEnd = taxYearEndedOn(row.tax_year, row.fiscal_year_end_month);
  if (calendarDay(input.signedOn, 'signedOn') < calendarDay(yearEnd, 'taxYearEnd')) {
    throw new AppError(
      409,
      'signed_before_year_end',
      `The signed date ${input.signedOn} is before this return's tax year ended on ${yearEnd}; an 8879 cannot authorize a year that had not closed yet.`
    );
  }

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
