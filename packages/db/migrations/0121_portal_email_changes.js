/* eslint-disable camelcase */
/**
 * THE SIGN-IN MOVES ONLY WHEN THE NEW ADDRESS CONFIRMS IT (Brian, 2026-09-26, R45).
 *
 * All client mail goes to the contact email, and a portal user is always created on it. When the
 * contact email changes while a portal user exists, Ops offers to move the sign-in with it; the move
 * is not made by the offer. One confirmation link goes to the NEW address, and the sign-in changes
 * when the person holding that inbox presses the button on its page (never on the GET, the R37 rule).
 *
 * WHAT THIS HOLDS, one row per request:
 *
 *   portal_user_id   whose sign-in moves
 *   new_email        the address the sign-in moves to — the contact email at the time of the request
 *   token_hash       SHA-256 of the link token; the plaintext is emailed once and never stored
 *                    (the magic-link rule)
 *   expires_at       when the link stops working
 *   confirmed_at     set by the button press that moved portal_users.email; NULL until then
 *   superseded_at    set when a later request (a resend, a further email change) replaces this one;
 *                    a superseded link is dead even if unexpired
 *   requested_by     the staff member who accepted the offer (or pressed Resend)
 *
 * Only token hashes touch the database. The audit rows name fields, never addresses.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS portal_email_changes (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      portal_user_id  uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
      new_email       citext NOT NULL,
      token_hash      text NOT NULL UNIQUE,
      expires_at      timestamptz NOT NULL,
      confirmed_at    timestamptz,
      superseded_at   timestamptz,
      requested_by    uuid REFERENCES staff(id),
      created_at      timestamptz NOT NULL DEFAULT now(),
      -- A row is confirmed or superseded, never both: the press that moves the sign-in must find it live.
      CHECK (confirmed_at IS NULL OR superseded_at IS NULL)
    )
  `);
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_portal_email_changes_pending
      ON portal_email_changes (portal_user_id) WHERE confirmed_at IS NULL AND superseded_at IS NULL
  `);
  await pgm.db.query(`
    COMMENT ON TABLE portal_email_changes IS
      'R45: a pending move of a portal sign-in to the contact email, confirmed by a link sent to the new address and pressed there. Token hashes only.'
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS portal_email_changes`);
};
