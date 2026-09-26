/* eslint-disable camelcase */
/**
 * THE 8879 SENT FOR SIGNATURE (Brian, 2026-09-26, R53).
 *
 * Remote clients sign Form 8879 through Adobe Sign, outside SAOS; a walk-in signs across the desk;
 * some are mailed a paper copy. Until now the return knew nothing between "delivered to the client"
 * and "the signed scan is on file", so a preparer could not tell a return waiting on a signature
 * from one nobody had sent, and the preparer queue could not say "awaiting signature".
 *
 * WHAT THIS HOLDS, on tax_engagements:
 *
 *   f8879_sent_method            adobe_sign | in_office | mailed — how the form reached the client.
 *                                NULL is allowed only for a record the Trello import declared, where
 *                                the card said "awaiting signature" and nothing about how (flagged
 *                                below); a person recording it always says how.
 *   f8879_sent_on                the calendar day it was sent or handed over (a DATE, no zone).
 *   f8879_sent_recorded_by/_at   who recorded it and when. A later record REPLACES the earlier one
 *                                (the audit row carries what it replaced); this is a state, not a log.
 *   f8879_sent_declared_by_import   true when the import wrote it from a Trello card under the R16
 *                                attestation — the same honesty flag 0114 gave imported jurisdictions.
 *
 * No Adobe integration and no send from SAOS: this records a fact about something that happened
 * elsewhere. The 8879 gate itself (a signed scan on file, 0093) is untouched.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'f8879_sent_method') THEN
        CREATE TYPE f8879_sent_method AS ENUM ('adobe_sign', 'in_office', 'mailed');
      END IF;
    END $$
  `);
  await pgm.db.query(`
    ALTER TABLE tax_engagements
      ADD COLUMN IF NOT EXISTS f8879_sent_method f8879_sent_method,
      ADD COLUMN IF NOT EXISTS f8879_sent_on date,
      ADD COLUMN IF NOT EXISTS f8879_sent_recorded_by uuid REFERENCES staff(id),
      ADD COLUMN IF NOT EXISTS f8879_sent_recorded_at timestamptz,
      ADD COLUMN IF NOT EXISTS f8879_sent_declared_by_import boolean NOT NULL DEFAULT false
  `);
  // A record is whole or absent: a day with no recording, or a recording with no day, is neither.
  await pgm.db.query(`
    ALTER TABLE tax_engagements
      DROP CONSTRAINT IF EXISTS tax_engagements_f8879_sent_whole,
      ADD CONSTRAINT tax_engagements_f8879_sent_whole
        CHECK ((f8879_sent_on IS NULL) = (f8879_sent_recorded_at IS NULL))
  `);
  // The method is said by every person; only an import may leave it unsaid, and says so.
  await pgm.db.query(`
    ALTER TABLE tax_engagements
      DROP CONSTRAINT IF EXISTS tax_engagements_f8879_sent_method_said,
      ADD CONSTRAINT tax_engagements_f8879_sent_method_said
        CHECK (f8879_sent_on IS NULL OR f8879_sent_method IS NOT NULL OR f8879_sent_declared_by_import)
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN tax_engagements.f8879_sent_method IS
      'R53: how Form 8879 reached the client for signature (Adobe Sign, in office, mailed). NULL only on an import-declared record. Recorded, never sent, by SAOS.'
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN tax_engagements.f8879_sent_declared_by_import IS
      'R53/R16: true when the Trello import declared the 8879 as sent from a card that said awaiting signature; the method was not on the card and is null.'
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE tax_engagements
      DROP CONSTRAINT IF EXISTS tax_engagements_f8879_sent_method_said,
      DROP CONSTRAINT IF EXISTS tax_engagements_f8879_sent_whole,
      DROP COLUMN IF EXISTS f8879_sent_declared_by_import,
      DROP COLUMN IF EXISTS f8879_sent_recorded_at,
      DROP COLUMN IF EXISTS f8879_sent_recorded_by,
      DROP COLUMN IF EXISTS f8879_sent_on,
      DROP COLUMN IF EXISTS f8879_sent_method
  `);
  await pgm.db.query(`DROP TYPE IF EXISTS f8879_sent_method`);
};
