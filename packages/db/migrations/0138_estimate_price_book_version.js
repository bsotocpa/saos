/* eslint-disable camelcase */
/**
 * 0138 — A LOCKED ESTIMATE NAMES THE PRICE BOOK IT WAS LOCKED UNDER (Brian, 2026-09-30, R109).
 *
 * The return's "Estimate locked … (price book vN)" read the version in force when the page was read,
 * not the one the lock used: Brian's 1040, locked 2026-09-27 under v5 (its quote and the engagement's
 * price lock both pin v5), read "v6" once v6 came into force. The lock now records its version:
 *   estimate_price_book_version_id   set with estimated_fee_*_cents at the lock, never moved after.
 * Backfill, for every return already locked: the engagement's price lock where it has one, otherwise
 * the version in force on the Chicago day of estimate_locked_at.
 */
exports.up = async (pgm) => {
  await pgm.db.query(`ALTER TABLE tax_engagements ADD COLUMN IF NOT EXISTS estimate_price_book_version_id uuid REFERENCES price_book_versions(id)`);
  await pgm.db.query(`
    UPDATE tax_engagements te
       SET estimate_price_book_version_id = COALESCE(
             (SELECT e.price_book_version_id FROM engagements e WHERE e.id = te.engagement_id),
             (SELECT v.id FROM price_book_versions v
               WHERE v.effective_from <= (te.estimate_locked_at AT TIME ZONE 'America/Chicago')::date
                 AND (v.effective_to IS NULL OR v.effective_to > (te.estimate_locked_at AT TIME ZONE 'America/Chicago')::date)
               ORDER BY v.version_number DESC LIMIT 1))
     WHERE te.estimate_locked_at IS NOT NULL AND te.estimate_price_book_version_id IS NULL`);
};

exports.down = async (pgm) => {
  await pgm.db.query(`ALTER TABLE tax_engagements DROP COLUMN IF EXISTS estimate_price_book_version_id`);
};
