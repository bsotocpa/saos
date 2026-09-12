/* eslint-disable camelcase */
/**
 * STAFF NAMES AND TEMPORARY PASSWORDS (2026-09-12, Brian's rulings 1 and 9 on staff accounts).
 *
 * NAMES. A staff row had one name. Jaqueline Flores is "Jackson" to the team and "Jaqueline
 * Flores" on anything contractual, and the record has to carry both without either being a
 * guess. `legal_name` is the person's name; `display_name` is what the team calls them, and
 * it defaults to the legal name. The old `full_name` column stays as a STORED generated alias
 * of `legal_name`, so the dozens of `st.full_name` reads keep working while every writer moves
 * to the real columns. Anything client-facing that ever uses a staff name uses `legal_name`
 * (nothing does today); the preparer of record, the money digest and every audit label use
 * `display_name`.
 *
 * TEMPORARY PASSWORDS. POST /staff minted a password that never expired and was never forced
 * to change. Now: `temp_password_expires_at` is set 72 hours out at creation, it is consumed on
 * the first successful sign-in, and `must_change_password` stays true until the person sets
 * their own. A session that still owes a password change can reach /auth/* and nothing else.
 *
 * Existing rows: legal_name and display_name are backfilled from full_name; no temporary
 * password state is set on them (the one account is Brian's).
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE staff RENAME COLUMN full_name TO legal_name;
    ALTER TABLE staff
      ADD COLUMN display_name text,
      ADD COLUMN full_name text GENERATED ALWAYS AS (legal_name) STORED,
      ADD COLUMN temp_password_expires_at timestamptz,
      ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
    UPDATE staff SET display_name = legal_name WHERE display_name IS NULL;
    ALTER TABLE staff ALTER COLUMN display_name SET NOT NULL;
    COMMENT ON COLUMN staff.legal_name IS 'The person''s legal name. Used on anything client-facing or contractual that carries a staff name.';
    COMMENT ON COLUMN staff.display_name IS 'What the team calls them. Defaults to legal_name. Used in Ops, audit labels, the preparer of record and the money digest.';
    COMMENT ON COLUMN staff.full_name IS 'Generated alias of legal_name kept for existing reads. Write legal_name and display_name.';
    COMMENT ON COLUMN staff.temp_password_expires_at IS 'Set 72h out when an account is created with a temporary password; set to now() on first successful sign-in (consumed). NULL when the password is the person''s own.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE staff
      DROP COLUMN must_change_password,
      DROP COLUMN temp_password_expires_at,
      DROP COLUMN full_name,
      DROP COLUMN display_name;
    ALTER TABLE staff RENAME COLUMN legal_name TO full_name;
  `);
};
