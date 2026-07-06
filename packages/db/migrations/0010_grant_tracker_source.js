/**
 * M22: grants imported from the Grant Tracker sheet carry their true source.
 * (import_source already had 'grant_tracker'; the per-record record_source
 * enum did not.)
 */

exports.up = (pgm) => {
  pgm.sql(`ALTER TYPE record_source ADD VALUE IF NOT EXISTS 'grant_tracker';`);
};

exports.down = (pgm) => {
  // Postgres cannot drop an enum value: remove rows that use it, then
  // rebuild the type. Destructive for grant_tracker-sourced rows — which is
  // what down means here.
  pgm.sql(`
    DELETE FROM grants_received WHERE source = 'grant_tracker';
    DELETE FROM contacts        WHERE source = 'grant_tracker';
    DELETE FROM businesses      WHERE source = 'grant_tracker';

    ALTER TYPE record_source RENAME TO record_source_old;
    CREATE TYPE record_source AS ENUM ('native', 'dubsado', 'zoho');

    ALTER TABLE contacts        ALTER COLUMN source DROP DEFAULT;
    ALTER TABLE businesses      ALTER COLUMN source DROP DEFAULT;
    ALTER TABLE grants_received ALTER COLUMN source DROP DEFAULT;

    ALTER TABLE contacts        ALTER COLUMN source TYPE record_source USING source::text::record_source;
    ALTER TABLE businesses      ALTER COLUMN source TYPE record_source USING source::text::record_source;
    ALTER TABLE grants_received ALTER COLUMN source TYPE record_source USING source::text::record_source;

    ALTER TABLE contacts        ALTER COLUMN source SET DEFAULT 'native';
    ALTER TABLE businesses      ALTER COLUMN source SET DEFAULT 'native';
    ALTER TABLE grants_received ALTER COLUMN source SET DEFAULT 'native';

    DROP TYPE record_source_old;
  `);
};
