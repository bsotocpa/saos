/**
 * M24 (spec v4.3): authoritative deadline table coverage.
 *  - return_type gains 1041 (estate/trust), 1120-F without US office
 *    (Jun 15/Dec 15 — the existing '1120f' is the with-US-office variant),
 *    1040 expat (Jun 15 automatic/Oct 15), and FBAR (FinCEN 114).
 *  - contacts.estimate_reminders_enabled: the client-portal estimate toggle
 *    (default ON per spec); the staff deadline board ignores it.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TYPE return_type ADD VALUE IF NOT EXISTS '1041';
    ALTER TYPE return_type ADD VALUE IF NOT EXISTS '1120f_foreign';
    ALTER TYPE return_type ADD VALUE IF NOT EXISTS '1040_expat';
    ALTER TYPE return_type ADD VALUE IF NOT EXISTS 'fbar';
  `);
  pgm.sql(`
    ALTER TABLE contacts ADD COLUMN estimate_reminders_enabled boolean NOT NULL DEFAULT true;
    COMMENT ON COLUMN contacts.estimate_reminders_enabled IS
      'v4.3: client-portal toggle for quarterly estimated-payment dates/reminders (default ON). Staff deadline board always shows estimates.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE contacts DROP COLUMN estimate_reminders_enabled;`);
  // Enum values cannot be dropped: remove dependent rows, rebuild the type.
  pgm.sql(`
    DELETE FROM tax_engagements WHERE return_type IN ('1041', '1120f_foreign', '1040_expat', 'fbar');

    ALTER TYPE return_type RENAME TO return_type_old;
    CREATE TYPE return_type AS ENUM ('1040', '1065', '1120s', '1120', '990', '990ez', '1120c', '1120f', '1120h', '1120pol', 'w7_itin');
    ALTER TABLE tax_engagements ALTER COLUMN return_type TYPE return_type USING return_type::text::return_type;
    DROP TYPE return_type_old;
  `);
};
