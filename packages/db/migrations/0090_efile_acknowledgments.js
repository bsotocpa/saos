/* eslint-disable camelcase */
/**
 * E-FILE ACKNOWLEDGMENTS, PER JURISDICTION (2026-09-12, Brian's ruling).
 *
 * Until now a return had one answer to "did the IRS accept it": `efile_accepted_at`, one stage,
 * one reject code. A return with a federal filing and a state filing is two submissions with
 * two acknowledgments that arrive on different days, and the state one had nowhere to land.
 * Laura, offshore, read the ATX acknowledgment report by hand and emailed each client.
 *
 * This is the record that replaces her inbox:
 *
 *   efile_ack_reports        one row per uploaded ATX report — the file itself (small CSV, kept
 *                            verbatim), its hash, who uploaded it, and what the parse found.
 *   efile_acknowledgments    one row per report line — the jurisdiction, the status, the
 *                            submission id, the date, and what SAOS DID with it: matched to which
 *                            return (or not, and why), queued for the client, held by the
 *                            preparer, sent, suppressed by the gate, or turned into a task.
 *
 * Two convenience dates on the return, so a page can say "federal accepted 09-12, state pending"
 * without joining. The existing `efile_accepted_at` keeps its meaning (federal acceptance is what
 * completes the return) and is set by the same path as before.
 *
 * NO SSN IS STORED. ATX exports carry a taxpayer id column; the parser keeps at most the last
 * four digits, in memory, to match against contacts.ssn_last4, and writes only the match result.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE efile_jurisdiction AS ENUM ('federal', 'state');
    CREATE TYPE efile_ack_status AS ENUM ('accepted', 'rejected', 'other');
    CREATE TYPE efile_ack_disposition AS ENUM (
      'queued',       -- matched + accepted; will send when the report is released
      'held',         -- the preparer held this row on the review screen
      'sent',         -- the client confirmation went out
      'suppressed',   -- released, but the automation is off: recorded, not sent
      'task',         -- rejected, unmatched or ambiguous: a task names the row and why
      'duplicate'     -- this jurisdiction was already acknowledged for this return
    );

    CREATE TABLE efile_ack_reports (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      filename        text NOT NULL,
      sha256          text NOT NULL,
      raw_text        text NOT NULL,
      uploaded_by     uuid NOT NULL REFERENCES staff(id),
      uploaded_at     timestamptz NOT NULL DEFAULT now(),
      released_by     uuid REFERENCES staff(id),
      released_at     timestamptz,
      row_count       int NOT NULL DEFAULT 0,
      matched_count   int NOT NULL DEFAULT 0,
      task_count      int NOT NULL DEFAULT 0,
      UNIQUE (sha256)
    );
    COMMENT ON TABLE efile_ack_reports IS
      'An uploaded ATX e-file acknowledgment report, kept verbatim. Idempotent on content hash: the same file twice is the same report.';

    CREATE TABLE efile_acknowledgments (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      report_id          uuid NOT NULL REFERENCES efile_ack_reports(id) ON DELETE CASCADE,
      row_index          int NOT NULL,
      tax_engagement_id  uuid REFERENCES tax_engagements(id),
      jurisdiction       efile_jurisdiction NOT NULL,
      state_code         text,
      status             efile_ack_status NOT NULL,
      status_raw         text NOT NULL,
      submission_id      text,
      acknowledged_on    date,
      reject_code        text,
      reject_reason      text,
      client_name_raw    text NOT NULL,
      tax_year           smallint,
      return_type_raw    text,
      disposition        efile_ack_disposition NOT NULL,
      disposition_note   text NOT NULL,
      task_id            uuid REFERENCES tasks(id),
      held_by            uuid REFERENCES staff(id),
      held_at            timestamptz,
      sent_at            timestamptz,
      created_at         timestamptz NOT NULL DEFAULT now(),
      UNIQUE (report_id, row_index)
    );
    CREATE INDEX idx_efile_acks_engagement ON efile_acknowledgments (tax_engagement_id) WHERE tax_engagement_id IS NOT NULL;
    -- One acknowledgment per (return, jurisdiction, state) that actually counted.
    CREATE UNIQUE INDEX idx_efile_acks_one_per_jurisdiction
      ON efile_acknowledgments (tax_engagement_id, jurisdiction, COALESCE(state_code, ''))
      WHERE tax_engagement_id IS NOT NULL AND status = 'accepted' AND disposition IN ('queued', 'held', 'sent', 'suppressed');

    ALTER TABLE tax_engagements
      ADD COLUMN IF NOT EXISTS federal_accepted_on date,
      ADD COLUMN IF NOT EXISTS state_accepted_on   date,
      ADD COLUMN IF NOT EXISTS state_accepted_code text;
    COMMENT ON COLUMN tax_engagements.federal_accepted_on IS 'Date on the federal acknowledgment. efile_accepted_at is the instant SAOS recorded it and still drives completion.';
    COMMENT ON COLUMN tax_engagements.state_accepted_on IS 'Date on the state acknowledgment, when there is one. A state acceptance does not complete the return; the federal one does.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE tax_engagements
      DROP COLUMN IF EXISTS state_accepted_code,
      DROP COLUMN IF EXISTS state_accepted_on,
      DROP COLUMN IF EXISTS federal_accepted_on;
    DROP TABLE IF EXISTS efile_acknowledgments;
    DROP TABLE IF EXISTS efile_ack_reports;
    DROP TYPE IF EXISTS efile_ack_disposition;
    DROP TYPE IF EXISTS efile_ack_status;
    DROP TYPE IF EXISTS efile_jurisdiction;
  `);
};
