/* eslint-disable camelcase */
/**
 * 0137 — A TIME ENTRY'S DAY IS CHICAGO'S (Brian, 2026-09-30, R104).
 *
 * time_entries.entry_date defaulted to CURRENT_DATE (0006), the database's UTC day: an hour logged
 * after 19:00 Chicago without a day was dated tomorrow. The default is now the Chicago day, the same
 * expression the API uses (apps/api/src/chicago-day.ts CHICAGO_TODAY). Rows already written keep the
 * day they were given.
 */
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE time_entries ALTER COLUMN entry_date SET DEFAULT ((now() AT TIME ZONE 'America/Chicago')::date)`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE time_entries ALTER COLUMN entry_date SET DEFAULT CURRENT_DATE`);
};
