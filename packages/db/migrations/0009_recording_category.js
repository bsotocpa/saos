/**
 * 0009 — 'recording' document category (M17 meeting intelligence).
 * Recordings live in the saos-recordings bucket; audio never leaves owned
 * infrastructure (MP: LLM API fallback receives cleaned text only).
 *
 * Note: ALTER TYPE ... ADD VALUE is allowed inside a transaction on PG12+ as
 * long as the new value isn't used in the same transaction (it isn't).
 */

exports.up = (pgm) => {
  pgm.sql(`ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'recording';`);
};

exports.down = () => {
  // Enum values cannot be dropped in PostgreSQL; leaving the value in place
  // is harmless (no rows reference it after a rollback of dependent code).
};
