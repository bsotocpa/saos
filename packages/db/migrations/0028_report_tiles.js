/**
 * M27 reports & KPIs: per-staff configurable dashboard tiles.
 *
 * NULL and '[]' mean different things and the API relies on it: NULL is "never
 * configured" (serve the sensible default set), '[]' is "deliberately cleared"
 * (serve an empty board). Collapsing them would make it impossible to turn all
 * tiles off.
 *
 * No new table — one jsonb column on staff is the whole feature. The report
 * definitions themselves live in code, not in the database, so there is nothing
 * to reference.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE staff ADD COLUMN dashboard_tiles jsonb;
    COMMENT ON COLUMN staff.dashboard_tiles IS
      'Ordered array of report keys this staffer pinned to their dashboard. NULL = never configured (defaults apply); [] = deliberately empty.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE staff DROP COLUMN dashboard_tiles;`);
};
