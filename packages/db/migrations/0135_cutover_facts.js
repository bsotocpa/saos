/* eslint-disable camelcase */
/**
 * 0135 — THE TRELLO CUTOVER FACTS (Brian, 2026-09-27 batch 8 approval; batch 9 answers; 2026-09-29 R90).
 *
 * docs/proposals/2026-09-27-trello-cutover-facts.md, as approved and answered:
 *
 *   businesses.sales_tax_filed_by / _as_of   'client' when the card says the client files their own
 *                                            ST-1 (sales_tax_status = client_self_files), in
 *                                            qbo_paid_by's shape: unknown by default, a day whenever
 *                                            it is not unknown.
 *   contacts.sales_tax_filed_by / _as_of     the same fact's home for a person with no business row
 *                                            (batch 9 answer 2).
 *   businesses.books_current_through_unconfirmed
 *                                            the import says so and nobody has confirmed it: set
 *                                            when the card was last touched before 2026-09-21
 *                                            (R90). Nothing computes from a flagged value.
 *   service_fact_imports.card_last_activity  the card's last activity day as the extract gives it
 *                                            per fact (R90); NULL when the bundle carries none.
 *
 * Touches no row: every new column starts at its default.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`DO $$ BEGIN CREATE TYPE sales_tax_filer AS ENUM ('client', 'soto', 'unknown'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  for (const table of ['businesses', 'contacts']) {
    await pgm.db.query(`ALTER TABLE ${table}
      ADD COLUMN IF NOT EXISTS sales_tax_filed_by sales_tax_filer NOT NULL DEFAULT 'unknown',
      ADD COLUMN IF NOT EXISTS sales_tax_filed_by_as_of date`);
    await pgm.db.query(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_sales_tax_filed_by_as_of_matches
      CHECK ((sales_tax_filed_by = 'unknown') = (sales_tax_filed_by_as_of IS NULL))`);
  }
  await pgm.db.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS books_current_through_unconfirmed boolean NOT NULL DEFAULT false`);
  // A flagged value is still a value: the flag means nothing without one.
  await pgm.db.query(`ALTER TABLE businesses ADD CONSTRAINT businesses_books_unconfirmed_has_value
    CHECK (NOT books_current_through_unconfirmed OR books_current_through IS NOT NULL)`);
  await pgm.db.query(`ALTER TABLE service_fact_imports ADD COLUMN IF NOT EXISTS card_last_activity date`);
  await pgm.db.query(`
    COMMENT ON COLUMN businesses.books_current_through_unconfirmed IS
      'R90: the import wrote books_current_through from a card last touched before 2026-09-21 and no person has confirmed it. Nothing may compute from a flagged value.'
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`ALTER TABLE service_fact_imports DROP COLUMN IF EXISTS card_last_activity`);
  await pgm.db.query(`ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_books_unconfirmed_has_value`);
  await pgm.db.query(`ALTER TABLE businesses DROP COLUMN IF EXISTS books_current_through_unconfirmed`);
  for (const table of ['businesses', 'contacts']) {
    await pgm.db.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_sales_tax_filed_by_as_of_matches`);
    await pgm.db.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS sales_tax_filed_by_as_of, DROP COLUMN IF EXISTS sales_tax_filed_by`);
  }
  await pgm.db.query(`DROP TYPE IF EXISTS sales_tax_filer`);
};
