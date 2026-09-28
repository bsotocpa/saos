/* eslint-disable camelcase */
/**
 * 0133 — DISPLAY NAMES CARRY THE FORM NUMBER (Brian, 2026-09-27, R81).
 *
 * "Form 1040 — Single" for the base individual returns; the 1040's schedules read "Schedule B/D (1040)
 * — …". Presentation metadata, like group_key and sort_order (0116): written on every version's rows
 * by item_code, never a new price-book version, and the book's own name_en/name_es stay as priced.
 * The builders' catalog and the line a new quote snapshots read the display name when there is one,
 * so the filter finds "1040", and the client's proposal reads the same words. A quote already sent
 * keeps the words it was sent with. This migration adds the two columns; the seed writes the names.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`ALTER TABLE price_book_items ADD COLUMN IF NOT EXISTS display_name_en text`);
  await pgm.db.query(`ALTER TABLE price_book_items ADD COLUMN IF NOT EXISTS display_name_es text`);
  await pgm.db.query(`
    COMMENT ON COLUMN price_book_items.display_name_en IS
      'R81: presentation only (never a version change): the name the builders and a new quote read, carrying the form number. NULL reads name_en.'
  `);
  // The names themselves are the seed's (seeds/data/price_book_display_names.mjs): set where a row has
  // none, on every deploy, so a fresh book gets them and a name edited later is never overwritten.
};

exports.down = async (pgm) => {
  await pgm.db.query(`ALTER TABLE price_book_items DROP COLUMN IF EXISTS display_name_es`);
  await pgm.db.query(`ALTER TABLE price_book_items DROP COLUMN IF EXISTS display_name_en`);
};

