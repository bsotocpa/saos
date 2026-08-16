/*
 * SOMEWHERE FOR "OTHER" TO LAND (Brian, 2026-08-16, finding #28).
 *
 * The intake now asks what "Other" means, and an answer nobody stores is the same dead
 * end in a longer form. Both of these columns hold TEXT THE CLIENT WROTE, so they are
 * deliberately free-form and never validated against a list — the whole point is that
 * the list did not fit them.
 *
 * `industry_other` earns its column: `businesses.industry` drives NAICS mapping and the
 * Form 5 module routing, so "other" is the one value that tells the system nothing. What
 * the client typed is the only way to fix that later, by hand or by adding an option.
 *
 * Hilo's `business_kind_other` gets NO column, on purpose: `business_kind` itself is not
 * copied to any record — it lives in the submission — so its companion lives there too.
 * A column for the exception but not the rule would be the odd thing.
 *
 * And nothing is added for demo_race, which keeps its closed list so that no free text
 * about a person can enter the funder-reporting path.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS industry_other text;
    ALTER TABLE contacts   ADD COLUMN IF NOT EXISTS how_heard_other text;

    COMMENT ON COLUMN businesses.industry_other IS
      'What the client typed when the industry list did not fit them. Free text by design. industry drives NAICS and Form 5 module routing, so "other" is the value that routes nowhere — this is what makes it recoverable.';
    COMMENT ON COLUMN contacts.how_heard_other IS
      'What the client typed when the how-heard list did not fit them. Free text by design.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE businesses DROP COLUMN IF EXISTS industry_other;
    ALTER TABLE contacts   DROP COLUMN IF EXISTS how_heard_other;
  `);
};
