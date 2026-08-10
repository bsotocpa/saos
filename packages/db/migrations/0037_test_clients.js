/**
 * Flagged TEST clients (Brian's dress-rehearsal request, 2026-08-09).
 *
 * Rehearsing the first-client sequence needs a real client record in PRODUCTION —
 * real Docuseal envelope, real email to a real inbox, real portal login. That is
 * the only way to learn what the day of the real invite actually feels like.
 *
 * The danger is obvious: a test client silently becomes part of the numbers. 433
 * active clients becomes 434. A test deposit becomes revenue. A test portal login
 * counts toward the Dubsado retirement trigger. Six months later nobody remembers
 * which row was the rehearsal.
 *
 * So the rule this flag encodes:
 *
 *   TEST CLIENTS ARE EXCLUDED FROM MEASUREMENT AND VISIBLE IN OPERATIONS.
 *
 * Excluded from: every report, the Executive dashboard, health scoring, funder
 * metrics, pipeline conversion, the Dubsado retirement count, and — most
 * importantly — every broadcast segment, so a rehearsal client can never receive a
 * real announcement.
 *
 * Still fully visible in: contact search, the client packet, the preparer queue,
 * the deadline board, tasks, documents, and every send path a rehearsal needs to
 * exercise. A test client you cannot work is not a rehearsal.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE contacts
      ADD COLUMN is_test   boolean NOT NULL DEFAULT false,
      ADD COLUMN test_note text,
      -- A test flag with no explanation becomes a mystery row. Require the why.
      ADD CONSTRAINT contacts_test_has_note CHECK (
        NOT is_test OR (test_note IS NOT NULL AND length(btrim(test_note)) >= 10)
      );

    COMMENT ON COLUMN contacts.is_test IS
      'Rehearsal/test client. EXCLUDED from all measurement (reports, dashboards, health, funder metrics, pipeline conversion, retirement trigger) and from every broadcast segment. Still fully visible in operations so the record can actually be worked.';

    -- Partial index: the flag is rare, so this stays tiny while making every
    -- "exclude test" filter cheap.
    CREATE INDEX idx_contacts_is_test ON contacts (id) WHERE is_test;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_contacts_is_test;
    ALTER TABLE contacts
      DROP CONSTRAINT contacts_test_has_note,
      DROP COLUMN test_note,
      DROP COLUMN is_test;
  `);
};
