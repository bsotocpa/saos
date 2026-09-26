/**
 * 0118 — The acknowledgment record takes the shape of the real ATX export (Brian, 2026-09-26, R43).
 *
 * The 2026-09-20 upload of the firm's E-Files.csv met a parser written against an imagined report:
 * it read "Client #" (empty) as the client, found no tax-year column, raised one task per row and
 * kept the file verbatim — full SSNs and EINs in efile_ack_reports.raw_text. This migration carries
 * what the rebuilt parser needs:
 *
 *   efile_acknowledgments  taxpayer_last4 (the LAST FOUR only — the identifier the row was matched
 *                          on; never the full value), sub_type (Federal/Return/Extension/Amended),
 *                          accepted_with_messages (AcceptedWithMessages counts as accepted, flagged),
 *                          status_at (the Central-time status date as an instant), extension_form
 *                          (an extension row proposing an R12 record: 4868, 7004 or 8868).
 *   efile_ack_status       + 'pending' (Created, Held, TransmittedToAgency: no action).
 *   efile_ack_disposition  + 'unmatched' (most rows of a firm-wide export; listed, counted, no task),
 *                          + 'pending', + 'extension_proposed', + 'extension_recorded'.
 *   efile_ack_reports      unmatched/pending/extension counts, and the WITHDRAW door: withdrawn_at/by/
 *                          reason. The content-hash uniqueness becomes partial (live reports only) so
 *                          a withdrawn upload's file can be uploaded again.
 *   tax_engagements        extension_form admits '8868' (a 990 extends on 8868, R43).
 *
 * The raw file is kept MASKED from now on (the parser rewrites every identifier to its last four
 * before the INSERT), and the purge door rewrites the reports uploaded before this. Nothing here
 * touches data; the purge is a door with an audit row, run by a person.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TYPE efile_ack_status ADD VALUE IF NOT EXISTS 'pending';
    ALTER TYPE efile_ack_disposition ADD VALUE IF NOT EXISTS 'unmatched';
    ALTER TYPE efile_ack_disposition ADD VALUE IF NOT EXISTS 'pending';
    ALTER TYPE efile_ack_disposition ADD VALUE IF NOT EXISTS 'extension_proposed';
    ALTER TYPE efile_ack_disposition ADD VALUE IF NOT EXISTS 'extension_recorded';

    ALTER TABLE efile_acknowledgments
      ADD COLUMN IF NOT EXISTS taxpayer_last4 text,
      ADD COLUMN IF NOT EXISTS sub_type text,
      ADD COLUMN IF NOT EXISTS accepted_with_messages boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS status_at timestamptz,
      ADD COLUMN IF NOT EXISTS extension_form text;
    ALTER TABLE efile_acknowledgments DROP CONSTRAINT IF EXISTS efile_acknowledgments_taxpayer_last4_shape;
    ALTER TABLE efile_acknowledgments
      ADD CONSTRAINT efile_acknowledgments_taxpayer_last4_shape CHECK (taxpayer_last4 IS NULL OR taxpayer_last4 ~ '^[0-9]{4}$');
    ALTER TABLE efile_acknowledgments DROP CONSTRAINT IF EXISTS efile_acknowledgments_extension_form_values;
    ALTER TABLE efile_acknowledgments
      ADD CONSTRAINT efile_acknowledgments_extension_form_values CHECK (extension_form IS NULL OR extension_form IN ('4868', '7004', '8868'));
    COMMENT ON COLUMN efile_acknowledgments.taxpayer_last4 IS
      'The last four digits of the SSN/EIN on the report row. The full identifier is never persisted (R43).';
    COMMENT ON COLUMN efile_acknowledgments.status_at IS
      'The Status Date on the row, read as America/Chicago and stored as an instant. acknowledged_on is the same date as printed.';

    ALTER TABLE efile_ack_reports
      ADD COLUMN IF NOT EXISTS unmatched_count int NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS pending_count int NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS extension_count int NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz,
      ADD COLUMN IF NOT EXISTS withdrawn_by uuid REFERENCES staff(id),
      ADD COLUMN IF NOT EXISTS withdrawn_reason text;
    ALTER TABLE efile_ack_reports DROP CONSTRAINT IF EXISTS efile_ack_reports_sha256_key;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_efile_ack_reports_sha256_live ON efile_ack_reports (sha256) WHERE withdrawn_at IS NULL;
    COMMENT ON TABLE efile_ack_reports IS
      'An uploaded ATX e-file export, kept with every identifier masked to its last four. Idempotent on content hash among live (not withdrawn) reports: the same file twice is the same report; a withdrawn report''s file may be uploaded again.';
    COMMENT ON COLUMN efile_ack_reports.withdrawn_at IS
      'Set by the withdraw door (R43): the report is void — its queued rows never send, and its file may be uploaded again.';

    ALTER TABLE tax_engagements DROP CONSTRAINT IF EXISTS tax_engagements_extension_form_values;
    ALTER TABLE tax_engagements
      ADD CONSTRAINT tax_engagements_extension_form_values
        CHECK (extension_form IS NULL OR extension_form IN ('4868', '7004', '8868'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE tax_engagements DROP CONSTRAINT IF EXISTS tax_engagements_extension_form_values;
    ALTER TABLE tax_engagements
      ADD CONSTRAINT tax_engagements_extension_form_values
        CHECK (extension_form IS NULL OR extension_form IN ('4868', '7004'));
    DROP INDEX IF EXISTS idx_efile_ack_reports_sha256_live;
    ALTER TABLE efile_ack_reports ADD CONSTRAINT efile_ack_reports_sha256_key UNIQUE (sha256);
    ALTER TABLE efile_ack_reports
      DROP COLUMN IF EXISTS withdrawn_reason,
      DROP COLUMN IF EXISTS withdrawn_by,
      DROP COLUMN IF EXISTS withdrawn_at,
      DROP COLUMN IF EXISTS extension_count,
      DROP COLUMN IF EXISTS pending_count,
      DROP COLUMN IF EXISTS unmatched_count;
    ALTER TABLE efile_acknowledgments
      DROP CONSTRAINT IF EXISTS efile_acknowledgments_extension_form_values,
      DROP CONSTRAINT IF EXISTS efile_acknowledgments_taxpayer_last4_shape,
      DROP COLUMN IF EXISTS extension_form,
      DROP COLUMN IF EXISTS status_at,
      DROP COLUMN IF EXISTS accepted_with_messages,
      DROP COLUMN IF EXISTS sub_type,
      DROP COLUMN IF EXISTS taxpayer_last4;
    -- Enum values are not removable in place; the added labels stay (unused) on a down.
  `);
};
