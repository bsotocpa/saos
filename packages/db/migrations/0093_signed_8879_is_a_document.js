/* eslint-disable camelcase */
/**
 * THE SIGNED 8879 IS A DOCUMENT (2026-09-12, Brian's rulings 2 and 3 on the 8879).
 *
 * The remote e-sign path is retired. There is no KBA vendor and no Docuseal 8879 template —
 * the report that said one existed had a config value and a foreign key, not a template. Form
 * 8879 is wet-signed in the office, scanned, and uploaded to the return as a Signed
 * Authorization with the signed date and the PTIN holder recorded. That upload is what moves
 * the return past the authorization gate.
 *
 * `f8879_document_id` is the proof. The filed gate (tax/pipeline.ts) requires it alongside
 * `f8879_signed_at`; a timestamp with no document behind it no longer authorizes anything.
 * A trigger holds the invariant at the database too: a signed_at with no document is refused,
 * so no code path — including a future one — can claim a return is authorized without the scan.
 *
 * Existing rows on production: none carry f8879_signed_at (checked 2026-09-12: zero f8879
 * envelopes of any method), so the trigger is added without a backfill and nothing is at risk.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tax_engagements
      ADD COLUMN IF NOT EXISTS f8879_document_id uuid REFERENCES documents(id) ON DELETE RESTRICT;
    COMMENT ON COLUMN tax_engagements.f8879_document_id IS
      'The uploaded, signed Form 8879 (Signed Authorizations). Required alongside f8879_signed_at; the filed gate checks this, not just the timestamp.';

    CREATE OR REPLACE FUNCTION tax_engagements_f8879_needs_document() RETURNS trigger AS $$
    BEGIN
      IF NEW.f8879_signed_at IS NOT NULL AND NEW.f8879_document_id IS NULL THEN
        RAISE EXCEPTION 'f8879_document_required: a return cannot be marked authorized (f8879_signed_at) without the uploaded signed 8879 (tax_engagement %)', NEW.id
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS tax_engagements_f8879_needs_document ON tax_engagements;
    CREATE TRIGGER tax_engagements_f8879_needs_document
      BEFORE INSERT OR UPDATE OF f8879_signed_at, f8879_document_id ON tax_engagements
      FOR EACH ROW EXECUTE FUNCTION tax_engagements_f8879_needs_document();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS tax_engagements_f8879_needs_document ON tax_engagements;
    DROP FUNCTION IF EXISTS tax_engagements_f8879_needs_document();
    ALTER TABLE tax_engagements DROP COLUMN IF EXISTS f8879_document_id;
  `);
};
