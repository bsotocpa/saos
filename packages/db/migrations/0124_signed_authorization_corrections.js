/* eslint-disable camelcase */
/**
 * THE SIGNED AUTHORIZATION, CORRECTED AND NAMED (Brian, 2026-09-26/27, R69 and R66).
 *
 * R69 — THE SIGNED DATE IS CORRECTABLE, AND SO IS THE SCAN. The day on the signed 8879 lives on
 * tax_engagements.f8879_signed_at (written as the calendar day the upload said, read everywhere as
 * f8879_signed_at::date). It was written once by the upload and could not be put right: Brian's own
 * 8879-CORP was recorded signed 2026-09-20 during the walk and the paper is dated 2026-09-15. The
 * correction door (0119) now moves that column with a reason. When the scan itself was the wrong
 * file, the door takes a replacement: the previous document row is KEPT and marked superseded,
 * never deleted — still downloadable, still audited — and the return points at the new one.
 *
 *   documents.superseded_by   the document that replaced this one (a later upload, same client,
 *                             same return); documents.superseded_at the instant. Both or neither.
 *
 * R66 — WHICH 8879 THE PAPER IS. One Form 8879 is four forms: 8879 (an individual return),
 * 8879-CORP (a corporation), 8879-PE (a partnership), 8879-TE (an exempt organization). The upload
 * takes the variant, defaulted from the return type, and the row prints it; correcting it goes
 * through the same correction door. Stored on the DOCUMENT row because the document is the 8879.
 * Existing rows: the variant is derived once here from the return the scan authorizes, printed
 * below by document id and return type (no names), so a signed authorization already on file
 * reads its form rather than nothing.
 */
exports.shorthands = undefined;

const F8879_VARIANTS = ['8879', '8879-CORP', '8879-PE', '8879-TE'];

/** The same default the API applies (apps/api/src/modules/tax/signed-8879.ts f8879VariantFor). */
function variantFor(returnType) {
  if (returnType === '1065') return '8879-PE';
  if (returnType.startsWith('1120')) return '8879-CORP';
  if (returnType.startsWith('990')) return '8879-TE';
  return '8879';
}

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE documents
      ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES documents(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
      ADD COLUMN IF NOT EXISTS f8879_variant text
  `);
  await pgm.db.query(`
    ALTER TABLE documents
      DROP CONSTRAINT IF EXISTS documents_superseded_whole,
      ADD CONSTRAINT documents_superseded_whole CHECK ((superseded_by IS NULL) = (superseded_at IS NULL)),
      DROP CONSTRAINT IF EXISTS documents_f8879_variant_values,
      ADD CONSTRAINT documents_f8879_variant_values CHECK (f8879_variant IS NULL OR f8879_variant IN (${F8879_VARIANTS.map((v) => `'${v}'`).join(', ')}))
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN documents.superseded_by IS
      'R69: the document that replaced this one through the filing-correction door. The row is kept, downloadable and audited; never deleted.'
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN documents.f8879_variant IS
      'R66: which Form 8879 this signed authorization is (8879, 8879-CORP, 8879-PE, 8879-TE), defaulted from the return type at upload; corrected through the filing-correction door.'
  `);

  // Existing signed 8879s take the variant their return implies, once, with the derivation printed.
  const { rows } = await pgm.db.query(`
    SELECT d.id, te.return_type::text AS return_type
      FROM documents d JOIN tax_engagements te ON te.f8879_document_id = d.id
     WHERE d.f8879_variant IS NULL
     ORDER BY d.created_at
  `);
  console.log(`0124: naming the form on ${rows.length} signed 8879(s) already on file (from the return type):`);
  for (const r of rows) console.log(`0124:   document ${r.id}  ·  ${r.return_type.toUpperCase()}  ·  f8879_variant → ${variantFor(r.return_type)}`);
  if (rows.length === 0) console.log('0124:   (none)');
  for (const r of rows) {
    await pgm.db.query(`UPDATE documents SET f8879_variant = $2 WHERE id = $1`, [r.id, variantFor(r.return_type)]);
  }
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE documents
      DROP CONSTRAINT IF EXISTS documents_f8879_variant_values,
      DROP CONSTRAINT IF EXISTS documents_superseded_whole,
      DROP COLUMN IF EXISTS f8879_variant,
      DROP COLUMN IF EXISTS superseded_at,
      DROP COLUMN IF EXISTS superseded_by
  `);
};
