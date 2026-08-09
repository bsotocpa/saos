/**
 * Flow 3 correction (Brian, 2026-08-09): the fixed Mar 25 / Apr 1 lane cutoffs
 * were a spec error — a protective-extension sweep AFTER the Mar 15 deadline is
 * useless. The sweep is now DERIVED PER ENGAGEMENT from the authoritative
 * deadline table: cutoff = original due date − offset (default 10 days,
 * admin-editable). 1065/1120-S sweep ~Mar 5, 1040/1120 ~Apr 5, 990s ~May 5,
 * and fiscal-year filers and every future return type handle themselves with
 * zero settings maintenance. Fixed dates rot; the table doesn't.
 *
 * Batches therefore key on the DEADLINE they protect, not an invented lane.
 */

exports.up = (pgm) => {
  pgm.sql(`
    DELETE FROM extension_batch_items;
    DELETE FROM extension_batches;
    ALTER TABLE extension_batches
      DROP CONSTRAINT extension_batches_tax_year_lane_key,
      DROP COLUMN lane,
      ADD COLUMN deadline_date date NOT NULL,
      ADD CONSTRAINT extension_batches_year_deadline_key UNIQUE (tax_year, deadline_date);
    COMMENT ON COLUMN extension_batches.deadline_date IS
      'The ORIGINAL due date this batch protects (from THE_TABLE). cutoff_date is when the sweep ran = deadline − offset.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM extension_batch_items;
    DELETE FROM extension_batches;
    ALTER TABLE extension_batches
      DROP CONSTRAINT extension_batches_year_deadline_key,
      DROP COLUMN deadline_date,
      ADD COLUMN lane text NOT NULL DEFAULT 'business' CHECK (lane IN ('business', 'individual')),
      ADD CONSTRAINT extension_batches_tax_year_lane_key UNIQUE (tax_year, lane);
  `);
};
