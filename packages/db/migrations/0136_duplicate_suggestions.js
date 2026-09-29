/* eslint-disable camelcase */
/**
 * 0136 — SAME-NAME PAIRS, HANDLED WITHOUT A SPREADSHEET (Brian, 2026-09-29, R97).
 *
 * Most name-only pairs (two live records with one name and no shared email, phone or address) are one
 * person recorded twice by Dubsado. A pair where one record holds nothing is resolved by archiving that
 * record with a redirect (merged_into_contact_id, the way a merge leaves one) and no merge. Every other
 * pair is a suggestion: both client pages carry a banner until a person merges the two (the R92 door)
 * or says they are not one person, with a reason. This table holds those suggestions:
 *
 *   status   open (the banner shows) · merged (the pair door joined them) · dismissed (not a duplicate,
 *            with the reason, who and when) · resolved (one side left for another reason: archived).
 *   a < b    one row per pair, whichever page it is read from.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`DO $$ BEGIN CREATE TYPE duplicate_suggestion_status AS ENUM ('open', 'merged', 'dismissed', 'resolved'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS contact_duplicate_suggestions (
      id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      a_contact_id           uuid NOT NULL REFERENCES contacts(id),
      b_contact_id           uuid NOT NULL REFERENCES contacts(id),
      kind                   text NOT NULL DEFAULT 'same_name',
      status                 duplicate_suggestion_status NOT NULL DEFAULT 'open',
      dismissed_reason       text,
      closed_by_staff_id     uuid REFERENCES staff(id),
      closed_at              timestamptz,
      created_at             timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT contact_duplicate_suggestions_ordered CHECK (a_contact_id < b_contact_id),
      CONSTRAINT contact_duplicate_suggestions_pair UNIQUE (a_contact_id, b_contact_id),
      CONSTRAINT contact_duplicate_suggestions_dismissed_has_reason CHECK (status <> 'dismissed' OR (dismissed_reason IS NOT NULL AND closed_by_staff_id IS NOT NULL))
    )`);
  await pgm.db.query(`CREATE INDEX IF NOT EXISTS contact_duplicate_suggestions_open_a ON contact_duplicate_suggestions (a_contact_id) WHERE status = 'open'`);
  await pgm.db.query(`CREATE INDEX IF NOT EXISTS contact_duplicate_suggestions_open_b ON contact_duplicate_suggestions (b_contact_id) WHERE status = 'open'`);
};

exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS contact_duplicate_suggestions`);
  await pgm.db.query(`DROP TYPE IF EXISTS duplicate_suggestion_status`);
};
