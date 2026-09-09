/**
 * 0082 — the tokenized pay link (2026-09-09, Brian's ruling).
 *
 * The invoice email used to link to the portal's Invoices page, which needs a portal login
 * — and a brand-new lead who accepts a quote has no portal account yet. The pay link is now
 * its own credential: a random token scoped to ONE invoice, no login, Stripe Checkout is the
 * authentication. It dies when the invoice is paid or voided, or after 90 days.
 *
 *   pay_token_hash       SHA-256 of the token; the lookup key (the token itself never sits
 *                        in the table in clear).
 *   pay_token_enc        The token, encrypted with APP_ENCRYPTION_KEY, so a reminder or a
 *                        dunning email carries the SAME link as the original — rotating it on
 *                        every send would kill the link in the email the client already has.
 *   pay_token_expires_at 90 days from issue.
 *   pay_token_revoked_at Set on paid and on void.
 *
 * The portal invite (a magic link to the client's account) is a separate onboarding event
 * and is untouched by this.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS pay_token_hash        text,
      ADD COLUMN IF NOT EXISTS pay_token_enc         bytea,
      ADD COLUMN IF NOT EXISTS pay_token_expires_at  timestamptz,
      ADD COLUMN IF NOT EXISTS pay_token_revoked_at  timestamptz;
    CREATE UNIQUE INDEX IF NOT EXISTS invoices_pay_token_hash_idx ON invoices (pay_token_hash)
      WHERE pay_token_hash IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS invoices_pay_token_hash_idx;
    ALTER TABLE invoices
      DROP COLUMN IF EXISTS pay_token_hash,
      DROP COLUMN IF EXISTS pay_token_enc,
      DROP COLUMN IF EXISTS pay_token_expires_at,
      DROP COLUMN IF EXISTS pay_token_revoked_at;
  `);
};
