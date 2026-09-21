/**
 * 0117 — The quote's client link, kept (Brian, 2026-09-20, the Quotes card).
 *
 * Only the link token's SHA-256 was stored, so "Copy client link" had to mint a fresh link and
 * retire the one the client had been emailed — a copy that changed the record. The same shape
 * invoices use since 0082 (pay_token_enc): the token is also kept encrypted under
 * APP_ENCRYPTION_KEY, written whenever a link is minted (send, resend, rotate), so a copy reads it
 * back and changes nothing. public_token_hash stays the lookup key; the public route never reads
 * the encrypted copy. A quote sent before this column existed has no stored token: copying its
 * link rotates once, and the control says so.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS client_token_enc bytea;
    COMMENT ON COLUMN quotes.client_token_enc IS
      'The client link token, encrypted with APP_ENCRYPTION_KEY, so Copy client link reads the emailed link back instead of minting another. NULL for quotes sent before 0117.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE quotes DROP COLUMN IF EXISTS client_token_enc;`);
};
