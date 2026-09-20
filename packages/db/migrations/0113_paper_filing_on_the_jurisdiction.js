/* eslint-disable camelcase */
/**
 * PAPER FILING IS A PROPERTY OF THE JURISDICTION (Brian, 2026-09-20, ruling 15).
 *
 * WHAT THIS HOLDS. Four things on tax_engagement_jurisdictions, and nothing else:
 *
 *   filing_method       'efile' or 'paper' — HOW this jurisdiction was filed. Defaulted from the
 *                       year-derived lane (current + 2 prior e-file, older paper) and settable per
 *                       jurisdiction by the preparer in the Mark filed modal, because one return
 *                       can go out electronically to the IRS and on paper to a state that will not
 *                       take it any other way.
 *   mailed_on           the day the paper filing went in the mail. This is what SATISFIES a paper
 *                       jurisdiction: there is no acknowledgment to wait for, so an e-file
 *                       acceptance date is a thing that can never arrive and a return declared on
 *                       paper could never complete. A recorded mailing is the paper lane's
 *                       acceptance, and completion reads it beside accepted_on.
 *   mailing_method      certified / first-class / hand-delivered / mailed by client — what was
 *                       actually done, in the words the preparer would use. Certified is the one
 *                       that earns a follow-up task (the tracking is checked before the receipt is
 *                       assumed); the others are recorded and nothing is chased.
 *   tracking_number     the carrier's number when there is one. Optional: a hand-delivered return
 *                       has none, and demanding one would make people type a placeholder.
 *   receipt_document_id the scanned receipt, when it was uploaded — a document, in the document
 *                       system, under the new 'mailing_receipts' category, never a file path here.
 *
 * WHY THE COLUMN IS NULLABLE rather than DEFAULT 'efile'. A default cannot read the row's tax
 * year, so a 2021 return written by anything other than the filing route would claim e-file — the
 * one lane that year cannot use. NULL means "nobody said", and every reader derives the lane from
 * the year when it finds one (pipeline.ts filingMethodOf). Every writer sets it explicitly.
 *
 * ALSO: one new document category, 'mailing_receipts'. A certified-mail receipt is neither a tax
 * document nor a signed authorization; it is proof of a filing, and the §7216 wall treats it as
 * return-adjacent (documents/wall.ts).
 *
 * TOUCHES ROWS. Every declared jurisdiction that carries no filing method is given the one its
 * return's YEAR implies, and each row is printed below by return id, year, return type and
 * jurisdiction — no client names, no PII. There are none on production: no return there is at or
 * past 'filed', so nothing has declared a jurisdiction yet. The list prints empty and says so.
 */
exports.shorthands = undefined;

/** E-file covers the current tax year and the two before it; older is paper (tax/resolution.ts). */
const EFILE_YEAR_SPAN = 2;
/** The tax year being prepared today: through the season, last calendar year (tax/resolution.ts). */
const currentTaxYear = (today) => Number(today.slice(0, 4)) - 1;
const laneFor = (taxYear, today) => (currentTaxYear(today) - taxYear <= EFILE_YEAR_SPAN ? 'efile' : 'paper');

exports.up = async (pgm) => {
  // DDL and row work both through pgm.db.query(), in order: pgm.sql() is queued until this
  // function returns, and the backfill below must see the columns.
  await pgm.db.query(`
    ALTER TABLE tax_engagement_jurisdictions
      ADD COLUMN IF NOT EXISTS filing_method       text,
      ADD COLUMN IF NOT EXISTS mailed_on           date,
      ADD COLUMN IF NOT EXISTS mailing_method      text,
      ADD COLUMN IF NOT EXISTS tracking_number     text,
      ADD COLUMN IF NOT EXISTS receipt_document_id uuid REFERENCES documents(id) ON DELETE SET NULL
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN tax_engagement_jurisdictions.filing_method IS
      $$'efile' or 'paper': how this jurisdiction was filed. Defaulted from the year-derived lane (current + 2 prior e-file, older paper) and set per jurisdiction in the Mark filed modal. NULL means nobody said, and the reader derives it from the return's year.$$
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN tax_engagement_jurisdictions.mailed_on IS
      'The day a paper filing was mailed. This satisfies a paper jurisdiction the way accepted_on satisfies an e-file one: there is no acknowledgment to wait for.'
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN tax_engagement_jurisdictions.mailing_method IS
      $$certified / first_class / hand_delivered / mailed_by_client. A certified mailing earns a follow-up task; the others are recorded and nothing is chased.$$
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN tax_engagement_jurisdictions.receipt_document_id IS
      'The scanned mailing receipt, filed in the document system under the mailing_receipts category. Never a path or a blob here.'
  `);

  /*
   * THE VALUES, CHECKED IN THE DATABASE. An enum type would do the same and would have to be
   * created, granted and dropped for two and four values that are read as text everywhere; the
   * CHECK is the same invariant where the column is.
   */
  await pgm.db.query(`
    ALTER TABLE tax_engagement_jurisdictions
      ADD CONSTRAINT tax_engagement_jurisdictions_filing_method_values
        CHECK (filing_method IS NULL OR filing_method IN ('efile', 'paper'))
  `);
  await pgm.db.query(`
    ALTER TABLE tax_engagement_jurisdictions
      ADD CONSTRAINT tax_engagement_jurisdictions_mailing_method_values
        CHECK (mailing_method IS NULL OR mailing_method IN ('certified', 'first_class', 'hand_delivered', 'mailed_by_client'))
  `);
  /*
   * A MAILING IS A DATE AND A METHOD TOGETHER. Half a mailing — a date with no method, or a
   * tracking number with no date — is a record nobody can act on: completion would count the
   * jurisdiction as filed while nothing says how, or the follow-up rule would have nothing to
   * read. Both halves or neither.
   */
  await pgm.db.query(`
    ALTER TABLE tax_engagement_jurisdictions
      ADD CONSTRAINT tax_engagement_jurisdictions_mailing_is_whole
        CHECK ((mailed_on IS NULL) = (mailing_method IS NULL))
  `);

  // One new document category for the receipt scan. Allowed inside the transaction on PG12+ as
  // long as the value is not USED in it (it is not — nothing here writes a document).
  await pgm.db.query(`ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'mailing_receipts'`);

  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await pgm.db.query(
    `SELECT j.tax_engagement_id, j.jurisdiction, te.tax_year, te.return_type::text AS return_type, te.stage::text AS stage
       FROM tax_engagement_jurisdictions j
       JOIN tax_engagements te ON te.id = j.tax_engagement_id
      WHERE j.filing_method IS NULL
      ORDER BY te.tax_year, j.tax_engagement_id, (j.jurisdiction <> 'federal'), j.jurisdiction`
  );
  console.log(`0113: giving a filing method to ${rows.length} declared jurisdiction row(s) (the year decides):`);
  const assigned = rows.map((r) => ({
    tax_engagement_id: r.tax_engagement_id,
    jurisdiction: r.jurisdiction,
    filing_method: laneFor(Number(r.tax_year), today),
  }));
  for (const [i, r] of rows.entries()) {
    console.log(
      `0113:   ${r.tax_engagement_id}  ·  ${r.tax_year} ${r.return_type.toUpperCase()}  ·  ${r.stage}  ·  ` +
        `${r.jurisdiction} → ${assigned[i].filing_method}`
    );
  }
  if (assigned.length === 0) {
    console.log('0113:   (none — no return has declared a jurisdiction yet)');
    return;
  }

  await pgm.db.query(
    `UPDATE tax_engagement_jurisdictions j
        SET filing_method = x.filing_method
       FROM jsonb_to_recordset($1::jsonb) AS x(tax_engagement_id uuid, jurisdiction text, filing_method text)
      WHERE j.tax_engagement_id = x.tax_engagement_id AND j.jurisdiction = x.jurisdiction`,
    [JSON.stringify(assigned)]
  );
  await pgm.db.query(
    `INSERT INTO audit_log (actor_type, actor_label, action, object_type, object_id, details)
     SELECT 'system', 'migration 0113', 'tax_engagement.filing_methods_recorded', 'tax_engagement', x.id,
            jsonb_build_object(
              'reason', 'a declared jurisdiction now records how it was filed; each existing row was given the method its return year implies',
              'filing_methods', x.methods)
       FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, methods jsonb)`,
    [
      JSON.stringify(
        [...new Set(assigned.map((a) => a.tax_engagement_id))].map((id) => ({
          id,
          methods: Object.fromEntries(
            assigned.filter((a) => a.tax_engagement_id === id).map((a) => [a.jurisdiction, a.filing_method])
          ),
        }))
      ),
    ]
  );
};

exports.down = (pgm) => {
  // document_category keeps 'mailing_receipts' (enum values cannot be dropped).
  pgm.sql(`
    ALTER TABLE tax_engagement_jurisdictions
      DROP CONSTRAINT IF EXISTS tax_engagement_jurisdictions_mailing_is_whole,
      DROP CONSTRAINT IF EXISTS tax_engagement_jurisdictions_mailing_method_values,
      DROP CONSTRAINT IF EXISTS tax_engagement_jurisdictions_filing_method_values,
      DROP COLUMN IF EXISTS receipt_document_id,
      DROP COLUMN IF EXISTS tracking_number,
      DROP COLUMN IF EXISTS mailing_method,
      DROP COLUMN IF EXISTS mailed_on,
      DROP COLUMN IF EXISTS filing_method;
  `);
};
