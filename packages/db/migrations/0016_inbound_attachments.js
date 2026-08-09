/**
 * Inbound attachment policy (decided 2026-08-09): accept, never reject.
 * Email/MMS attachments land in a QUARANTINE holding area attached to the
 * client thread — never the document folders. Virus-scan on arrival, warm
 * auto-ack with the secure upload link, staff one-tap file/reassign/discard
 * from the unified inbox. Nothing reaches a client document folder without
 * the staff confirm tap (enforced by the filing endpoint, audited with
 * origin channel + confirming staffer).
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE inbound_attachment_status AS ENUM ('quarantined', 'filed', 'discarded');
    CREATE TYPE attachment_scan_status AS ENUM ('pending', 'clean', 'infected', 'skipped');

    CREATE TABLE inbound_attachments (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      channel               text NOT NULL CHECK (channel IN ('email', 'mms')),
      origin_ref            text NOT NULL,             -- Twilio MessageSid / inbound email message-id
      sender                text NOT NULL,             -- phone number or email address as received
      contact_id            uuid REFERENCES contacts(id),
      thread_id             uuid REFERENCES message_threads(id),
      message_id            uuid REFERENCES messages(id),
      filename              text NOT NULL,
      mime_type             text,
      size_bytes            bigint NOT NULL,
      minio_bucket          text NOT NULL,
      minio_key             text NOT NULL,
      sha256                text NOT NULL,
      scan_status           attachment_scan_status NOT NULL DEFAULT 'pending',
      scan_detail           text,
      suggested_category    document_category,         -- NULL = triage only (always NULL for unmatched senders)
      status                inbound_attachment_status NOT NULL DEFAULT 'quarantined',
      filed_document_id     uuid REFERENCES documents(id),
      confirmed_by_staff_id uuid REFERENCES staff(id),
      confirmed_at          timestamptz,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_inbound_attachments_open ON inbound_attachments (created_at) WHERE status = 'quarantined';
    CREATE INDEX idx_inbound_attachments_contact ON inbound_attachments (contact_id) WHERE contact_id IS NOT NULL;
    CREATE TRIGGER trg_inbound_attachments_updated_at BEFORE UPDATE ON inbound_attachments
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    COMMENT ON TABLE inbound_attachments IS
      'Quarantine holding area for email/MMS attachments — thread-attached, NOT a document folder. Filing requires the staff confirm tap.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE inbound_attachments;
    DROP TYPE inbound_attachment_status;
    DROP TYPE attachment_scan_status;
  `);
};
