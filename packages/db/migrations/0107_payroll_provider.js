/* eslint-disable camelcase */
/**
 * WHAT THIS MIGRATION HOLDS (Brian, 2026-09-20, item h): WHOSE payroll system a payroll engagement
 * runs in.
 *
 *   engagements.payroll_provider  text, free-form, scoped to service_line = 'payroll'
 *
 * WHY A COLUMN AND NOT NOTES. Thirty-five of the bundle's 67 payroll clients name a provider, and
 * today it would land in engagements.notes, where no report can group by it. The questions this
 * answers are operational and get asked out loud: which clients are on QBO Payroll when a QBO
 * price changes, which are somewhere else when a provider has an outage. A free-text note cannot
 * answer either.
 *
 * WHY text AND NOT AN ENUM. The bundle carries exactly one value today ('QBO Payroll'), and an
 * enum built from a sample of one is a migration every time a client brings a provider we have not
 * seen. An enum earns its place when the set is closed and the code branches on it; this set is
 * open and nothing branches on it yet. If something ever does, it becomes an enum then, with the
 * real list in hand.
 *
 * SCOPED BY A CHECK: a payroll provider on a tax engagement is a data error, not a fact.
 *
 * ADDS ONE COLUMN AND ONE CHECK. Touches no rows.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`ALTER TABLE engagements ADD COLUMN payroll_provider text`);
  await pgm.db.query(`
    ALTER TABLE engagements
      ADD CONSTRAINT engagements_payroll_provider_is_payroll
        CHECK (payroll_provider IS NULL OR service_line = 'payroll')
  `);
  await pgm.db.query(`
    ALTER TABLE engagements
      ADD CONSTRAINT engagements_payroll_provider_not_blank
        CHECK (payroll_provider IS NULL OR length(btrim(payroll_provider)) > 0)
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN engagements.payroll_provider IS
      'The payroll system this engagement runs in, as a person would name it ("QBO Payroll"). NULL = not recorded. Free text on purpose: the set is open and no code branches on it.'
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE engagements
      DROP CONSTRAINT IF EXISTS engagements_payroll_provider_not_blank,
      DROP CONSTRAINT IF EXISTS engagements_payroll_provider_is_payroll,
      DROP COLUMN IF EXISTS payroll_provider
  `);
};
