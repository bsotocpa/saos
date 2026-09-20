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

/**
 * THE SCAN THIS UPLOAD CARRIES, CHECKED ONCE (shared by the 8879 and the engagement letter).
 *
 * Both doors upload a signed paper into Signed Authorizations against one return and one date, so
 * both ask the same five questions: does the document exist, is it filed under the right category,
 * does it belong to this client, is it linked to some other return, and is the date a day that has
 * already happened and on which the year being authorized had actually closed. Answered here, in
 * one place, so the two doors cannot drift into refusing different things in different words.
 */
async function checkedSignedScan(
  app: FastifyInstance,
  row: { id: string; contact_id: string; tax_year: number; fiscal_year_end_month: number | null },
  input: { documentId: string; signedOn: string },
  what: string
): Promise<{ id: string }> {
  const doc = await app.db.query<{ id: string; category: string; tax_engagement_id: string | null; contact_id: string }>(
    `SELECT id, category::text AS category, tax_engagement_id, contact_id FROM documents WHERE id = $1`,
    [input.documentId]
  );
  const d = doc.rows[0];
  if (!d) throw new AppError(404, 'document_not_found', 'The signed authorization document was not found.');
  if (d.category !== 'signed_authorizations') throw new AppError(409, 'wrong_category', `A ${what} must be filed under Signed Authorizations, not '${d.category}'.`);
  if (d.contact_id !== row.contact_id) throw new AppError(409, 'wrong_client', 'That document belongs to a different client.');
  if (d.tax_engagement_id && d.tax_engagement_id !== row.id) throw new AppError(409, 'wrong_return', 'That document is linked to a different return.');

  /*
   * THE SIGNED DATE IS A PAST FACT (Brian, 2026-09-19): a paper signed before the SAOS record
   * existed is the ordinary case for work done in ATX; a date after today is not a signature
   * anyone has seen. Today in Chicago is the latest a scan can be dated.
   */
  if (calendarDay(input.signedOn, 'signedOn') > calendarDay(todayChicago(), 'today')) throw new AppError(409, 'signed_date_in_future', `The signed date ${input.signedOn} is after today; a signature is a thing that already happened.`);

  /*
   * NO BACKFILL MODE (Brian, 2026-09-19 evening, ruling 5). The other end of the same window: a
   * signed paper authorizes a return for a year, and nobody signs an authorization for a year that
   * has not finished. A date before the tax year ended is a typo, a wrong year on the record, or
   * the scan belonging to a different return — three things worth stopping, none of them worth
   * guessing at. The year end is the last day of the entity's fiscal year end month in the tax
   * year for a fiscal-year filer, December 31 of the tax year otherwise.
   */
  const yearEnd = taxYearEndedOn(row.tax_year, row.fiscal_year_end_month);
  if (calendarDay(input.signedOn, 'signedOn') < calendarDay(yearEnd, 'taxYearEnd')) {
    throw new AppError(
      409,
      'signed_before_year_end',
      `The signed date ${input.signedOn} is before this return's tax year ended on ${yearEnd}; a ${what} cannot authorize a year that had not closed yet.`
    );
  }
  return { id: d.id };
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

  const d = await checkedSignedScan(app, row, input, 'signed 8879');

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

/*
 * THE ENGAGEMENT LETTER SIGNED ON PAPER (Brian, 2026-09-20).
 *
 * Most clients sign the Master in the portal, and that signature stamps every return it covers
 * (recordMasterSignature). The client who signs across the desk has a scan and nothing else — and
 * the only writer that could stamp the return was a staff-only route on no screen, which is how a
 * compliance gate came to be closed by a curl. So the paper takes the same door the 8879 takes:
 * upload the scan under Signed Authorizations against the return, with the date on the signature,
 * and THE UPLOAD is what stamps gate 1. Same checks, same refusals, same words.
 *
 * NO PTIN HOLDER HERE: an engagement letter is signed by the client, and nobody's PTIN is on it.
 */
export interface SignedEngagementLetterInput {
  taxEngagementId: string;
  /** The uploaded scan, already in Signed Authorizations and linked to this return. */
  documentId: string;
  /** The date on the client's signature, a calendar day. */
  signedOn: string;
}

export async function recordSignedEngagementLetter(
  app: FastifyInstance,
  actor: { staffId: string; label: string; ip?: string | null; userAgent?: string | null },
  input: SignedEngagementLetterInput
): Promise<{ taxEngagementId: string; signedOn: string }> {
  const te = await app.db.query<{
    id: string; contact_id: string; engagement_letter_signed_at: Date | null;
    tax_year: number; fiscal_year_end_month: number | null;
  }>(
    `SELECT te.id, e.contact_id, te.engagement_letter_signed_at, te.tax_year, b.fiscal_year_end_month
       FROM tax_engagements te
       JOIN engagements e ON e.id = te.engagement_id
       LEFT JOIN businesses b ON b.id = e.business_id
      WHERE te.id = $1`,
    [input.taxEngagementId]
  );
  const row = te.rows[0];
  if (!row) throw new AppError(404, 'not_found', 'Tax engagement not found.');
  if (row.engagement_letter_signed_at) {
    throw new AppError(409, 'engagement_letter_already_on_file', 'The engagement letter is already signed on this return.');
  }

  const d = await checkedSignedScan(app, row, input, 'signed engagement letter');

  await app.db.query(
    `UPDATE tax_engagements SET engagement_letter_signed_at = $2::date::timestamptz WHERE id = $1`,
    [row.id, input.signedOn]
  );
  await app.db.query(`UPDATE documents SET tax_engagement_id = COALESCE(tax_engagement_id, $2) WHERE id = $1`, [d.id, row.id]);
  /*
   * The client's letter is the client's letter: the contact flag goes to 'signed' the same way the
   * portal signature sets it, so a return opened next week inherits the stamp instead of asking for
   * the same scan twice.
   */
  await app.db.query(`UPDATE contacts SET engagement_letter_status = 'signed' WHERE id = $1`, [row.contact_id]);
  // One queryable record of signature status, wet or portal — the table every envelope lives in.
  await app.db.query(
    `INSERT INTO signature_envelopes
       (contact_id, tax_engagement_id, type, status, signature_method, signed_document_id, completed_at, created_by_staff_id)
     VALUES ($1, $2, 'engagement_letter', 'completed', 'in_person_wet', $3, $4::date::timestamptz, $5)`,
    [row.contact_id, row.id, d.id, input.signedOn, actor.staffId]
  );
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.staffId, actorLabel: actor.label,
    action: 'signature.recorded_wet', objectType: 'tax_engagement', objectId: row.id, contactId: row.contact_id,
    ip: actor.ip ?? null, userAgent: actor.userAgent ?? null,
    details: { type: 'engagement_letter', document_id: d.id, signed_on: input.signedOn },
  });
  return { taxEngagementId: row.id, signedOn: input.signedOn };
}
