/* eslint-disable camelcase */
/**
 * WHAT THIS MIGRATION HOLDS (Brian, 2026-09-20, item h): the sales-tax FILING FREQUENCY, on the
 * engagement that does the filing.
 *
 *   engagements.filing_frequency  monthly | quarterly | annual | quarterly_or_annual
 *
 * WHY IT IS NOT prep_cadence. prep_cadence is a bookkeeping dial: how often we close the books and
 * sit with the client. A sales-tax return's frequency is assigned by the state from the client's
 * liability, and the two move independently — monthly books with an annual ST-1 is an ordinary
 * client. Reusing prep_cadence would have made one client's two answers overwrite each other.
 *
 * WHY 'quarterly_or_annual' IS A REAL MEMBER, and the one judgement call in this migration. Eleven
 * of the bundle's 53 sales-tax rows say "quarterly-or-annual": the Trello card never recorded which
 * one the state assigned. That is not a frequency the state offers — it is the record's own
 * ambiguity, and it has to survive the import as ambiguity. Folding it into 'quarterly' would
 * invent a fact (R16: no fabricated facts); dropping it would lose eleven clients' sales-tax
 * service. A member that reads as unresolved is the honest third option, and it is the value a
 * report can filter on to go and ask.
 *
 * SCOPED BY A CHECK, not by convention: the column is only meaningful on a sales_tax engagement, so
 * a frequency on a tax or bookkeeping engagement is refused at the database. Without that, the
 * column becomes a second cadence field on every engagement and the distinction above rots.
 *
 * ADDS ONE COLUMN AND ONE CHECK. Touches no rows.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`ALTER TABLE engagements ADD COLUMN filing_frequency text`);
  await pgm.db.query(`
    ALTER TABLE engagements
      ADD CONSTRAINT engagements_filing_frequency_values
        CHECK (filing_frequency IS NULL
               OR filing_frequency IN ('monthly', 'quarterly', 'annual', 'quarterly_or_annual'))
  `);
  await pgm.db.query(`
    ALTER TABLE engagements
      ADD CONSTRAINT engagements_filing_frequency_is_sales_tax
        CHECK (filing_frequency IS NULL OR service_line = 'sales_tax')
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN engagements.filing_frequency IS
      'How often this sales-tax engagement files, as the state assigned it. NULL = not recorded. quarterly_or_annual means the source record did not say which — the ambiguity is kept rather than resolved by guess (Trello import, 2026-09-20).'
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE engagements
      DROP CONSTRAINT IF EXISTS engagements_filing_frequency_is_sales_tax,
      DROP CONSTRAINT IF EXISTS engagements_filing_frequency_values,
      DROP COLUMN IF EXISTS filing_frequency
  `);
};
