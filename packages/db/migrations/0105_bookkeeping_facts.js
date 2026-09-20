/* eslint-disable camelcase */
/**
 * WHAT THIS MIGRATION HOLDS (Brian, 2026-09-20, item h): the two bookkeeping facts the Trello
 * bundle carries that SAOS has nowhere to put, and the cadence value it uses that the enum does
 * not hold.
 *
 *   businesses.books_current_through          — the last month the books are closed through
 *   businesses.books_current_through_as_of    — the day that fact was true
 *   prep_cadence += 'annual'                  — 35 of the 109 bookkeeping clients are annual
 *
 * ONE MIGRATION FOR THREE THINGS because they are one fact between them: "these books are
 * current through December 2025, as of 1 July 2026, on an annual cadence" is a single sentence a
 * person says about a client, and splitting it across three deploys would let the middle state
 * exist — a cadence the enum refuses while the column that describes it is already there.
 *
 * THE AS-OF DATE IS NOT OPTIONAL, and that is the whole reason this migration is two columns
 * rather than one. The bundle's own README says the bookkeeping facts are as of 2026-07-01 and to
 * treat them as stale; a "books current through Dec 2025" with no as-of date reads as current
 * today, which is a claim nobody made. The CHECK below refuses the one without the other.
 *
 * WHY A DATE AND NOT A MONTH. The bundle says "Dec 2025". The importer writes the LAST DAY of that
 * month (2025-12-31), because "current through December" means through its end, and a date sorts,
 * compares against a close cycle's period_end, and needs no second column to say what granularity
 * it is. The derivation is the importer's, recorded in its own audit row; nothing here guesses.
 *
 * ADDS COLUMNS AND ONE ENUM VALUE. Touches no rows.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  // lessons.md: pgm.sql() is queued until this function returns, so a migration that also reads or
  // writes rows does every statement through pgm.db.query, in order. This one writes no rows, and
  // uses the same discipline so a later edit that adds a backfill cannot inherit the trap.
  await pgm.db.query(`ALTER TYPE prep_cadence ADD VALUE IF NOT EXISTS 'annual'`);

  await pgm.db.query(`
    ALTER TABLE businesses
      ADD COLUMN books_current_through       date,
      ADD COLUMN books_current_through_as_of date
  `);
  await pgm.db.query(`
    ALTER TABLE businesses
      ADD CONSTRAINT businesses_books_current_through_has_as_of
        CHECK (books_current_through IS NULL OR books_current_through_as_of IS NOT NULL)
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN businesses.books_current_through IS
      'The last day of the last period the books are closed through (the importer writes a month-end). NULL = nobody has said. Derived from a close cycle when one exists; the Trello import sets it from the card, with its as-of date.'
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN businesses.books_current_through_as_of IS
      'The day books_current_through was true. Required whenever books_current_through is set: a stale fact with no as-of date reads as current. The 2026-09-20 Trello bundle carries 2026-07-01 for all of them.'
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE businesses
      DROP CONSTRAINT IF EXISTS businesses_books_current_through_has_as_of,
      DROP COLUMN IF EXISTS books_current_through,
      DROP COLUMN IF EXISTS books_current_through_as_of
  `);

  /*
   * Postgres cannot drop an enum value, so the type is rebuilt. DESTRUCTIVE BY DESIGN and refused
   * rather than silently destructive: a row already on the annual cadence would have to lose its
   * cadence for the type to shrink, and a down migration that quietly blanks a client's dials is
   * worse than one that stops and says which rows are in the way.
   */
  const { rows } = await pgm.db.query(`
    SELECT (SELECT count(*) FROM engagements WHERE prep_cadence = 'annual')::int AS engagements,
           (SELECT count(*) FROM engagement_config_history WHERE prep_cadence = 'annual')::int AS history
  `);
  const { engagements, history } = rows[0];
  if (engagements > 0 || history > 0) {
    throw new Error(
      `0105 down: ${engagements} engagement(s) and ${history} config-history row(s) are on the ` +
        `'annual' cadence. Postgres cannot drop an enum value while it is in use, and this ` +
        `migration will not blank a client's cadence to shrink a type. Move those rows first.`
    );
  }
  await pgm.db.query(`ALTER TYPE prep_cadence RENAME TO prep_cadence_old`);
  await pgm.db.query(`CREATE TYPE prep_cadence AS ENUM ('weekly', 'monthly', 'quarterly', 'semi_annual')`);
  await pgm.db.query(`ALTER TABLE engagements ALTER COLUMN prep_cadence TYPE prep_cadence USING prep_cadence::text::prep_cadence`);
  await pgm.db.query(`ALTER TABLE engagement_config_history ALTER COLUMN prep_cadence TYPE prep_cadence USING prep_cadence::text::prep_cadence`);
  await pgm.db.query(`DROP TYPE prep_cadence_old`);
};
