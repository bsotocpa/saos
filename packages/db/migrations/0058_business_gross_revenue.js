/*
 * GROSS REVENUE AS A FIGURE, NOT A BUCKET (Brian, 2026-08-16, finding #29).
 *
 * The intake asked `revenue_range` — a bucketed select, "<$50K" through "$1M+". Brian's
 * ruling: the exact figure supersedes it and we do not ask twice, so the range question
 * leaves the intake entirely.
 *
 * `revenue_range` the COLUMN stays. Staff still set it from the client record (crm
 * routes), 500-odd migrated businesses carry it, and a bucket someone recorded years ago
 * is not made false by our now asking for a number.
 *
 * THE YEAR IS STORED WITH THE NUMBER. Brian's reason for naming the year in the question
 * — "relative labels rot in January" — applies with more force to the stored value: a
 * bare revenue figure read in 2028 is unusable if nobody wrote down what year it was.
 *
 * bigint, not integer. In cents, int4 tops out near $21.4M, which is a plausible number
 * for a client to type and a silly place to overflow.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE businesses
      ADD COLUMN IF NOT EXISTS gross_revenue_cents bigint,
      ADD COLUMN IF NOT EXISTS gross_revenue_year  integer;

    COMMENT ON COLUMN businesses.gross_revenue_cents IS
      'Gross revenue as the client reported it, in cents. Client-supplied and optional — a number they did not know is not a blocker, and the books are the authority anyway.';
    COMMENT ON COLUMN businesses.gross_revenue_year IS
      'WHICH year gross_revenue_cents describes. Derived from currentTaxYear() at collection; never inferred later from the row timestamp.';
  `);

  /*
   * A figure without its year is not interpretable, and a year without a figure is
   * noise. Enforced rather than promised, because these are filled by two different
   * paths (intake and the client record) and only the constraint holds both.
   */
  pgm.sql(`
    ALTER TABLE businesses
      ADD CONSTRAINT businesses_gross_revenue_has_year CHECK (
        (gross_revenue_cents IS NULL) = (gross_revenue_year IS NULL)
      );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE businesses
      DROP CONSTRAINT IF EXISTS businesses_gross_revenue_has_year,
      DROP COLUMN IF EXISTS gross_revenue_cents,
      DROP COLUMN IF EXISTS gross_revenue_year;
  `);
};
