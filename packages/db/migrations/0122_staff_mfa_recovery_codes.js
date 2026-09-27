/* eslint-disable camelcase */
/**
 * MFA RECOVERY CODES FOR STAFF (Brian, 2026-09-26, R65).
 *
 * Until now a staff member who lost their authenticator had no way back in: no recovery codes, no
 * reset route. Enrolment now mints eight single-use recovery codes, shown once on the enrolment
 * screen and stored here hashed the way passwords are (argon2). A code signs in once in place of
 * the authenticator code and is consumed in the same statement that accepts it; using one raises
 * an Ops alert task for the CEO. A new set (from Account, or a CEO's Reset MFA) replaces the old
 * set whole.
 *
 * WHAT THIS HOLDS, one row per code:
 *
 *   staff_id    whose code
 *   code_hash   argon2 of the code; the plaintext is shown once at enrolment and never stored
 *   used_at     when the code signed someone in; NULL while it is live. A used code stays as the
 *               record of its use until the set is replaced.
 *   created_at  when the set was minted
 *
 * Only hashes touch the database. The audit rows name the event, never the code.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS staff_mfa_recovery_codes (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      staff_id    uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      code_hash   text NOT NULL,
      used_at     timestamptz,
      created_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_staff_mfa_recovery_codes_live
      ON staff_mfa_recovery_codes (staff_id) WHERE used_at IS NULL
  `);
  await pgm.db.query(`
    COMMENT ON TABLE staff_mfa_recovery_codes IS
      'R65: single-use MFA recovery codes for staff, argon2-hashed; shown once at enrolment, consumed on sign-in, replaced as a set.'
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS staff_mfa_recovery_codes`);
};
