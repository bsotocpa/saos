/**
 * M27: client announcements (broadcast) + review requests.
 *
 * CLAUDE.md, non-negotiable: "Broadcast messages require unsubscribe
 * compliance: every announcement email carries CAN-SPAM unsubscribe; every
 * broadcast SMS respects TCPA opt-out; suppression lists enforced at send time,
 * approval-gated, never auto-sent."
 *
 * Design notes worth keeping:
 *
 *  · `broadcast_opt_out_at` is SEPARATE from sms_consent and from the §7216
 *    consents. A client who opts out of firm news must still receive "your
 *    return is ready" — conflating marketing opt-out with transactional
 *    delivery would break the service, and CAN-SPAM does not ask us to.
 *
 *  · There is no unsubscribe TOKEN column. The link carries an HMAC of the
 *    contact id keyed by APP_ENCRYPTION_KEY: stable for the 30+ days CAN-SPAM
 *    requires, verifiable without a lookup, and nothing extra at rest.
 *
 *  · Every intended recipient gets a `broadcast_recipients` row, including the
 *    suppressed ones, with the reason. A broadcast that quietly reaches 300 of
 *    400 people teaches nothing; one that says "88 suppressed: opted out" is an
 *    audit trail.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE contacts
      ADD COLUMN broadcast_opt_out_at timestamptz,
      ADD COLUMN broadcast_opt_out_source text;
    COMMENT ON COLUMN contacts.broadcast_opt_out_at IS
      'CAN-SPAM/TCPA opt-out for ANNOUNCEMENTS only. Transactional messages (return ready, invoice, magic link) are unaffected — conflating the two would break the service.';

    CREATE TYPE broadcast_channel AS ENUM ('email', 'sms', 'both');
    CREATE TYPE broadcast_status  AS ENUM ('draft', 'pending_approval', 'approved', 'sending', 'sent', 'cancelled');

    CREATE TABLE broadcasts (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name               text NOT NULL,
      channel            broadcast_channel NOT NULL,
      status             broadcast_status NOT NULL DEFAULT 'draft',
      -- Segment as data, so the same filter can be previewed and re-run.
      segment            jsonb NOT NULL DEFAULT '{}'::jsonb,
      subject_en         text,
      subject_es         text,
      body_en            text NOT NULL,
      body_es            text NOT NULL,
      sms_en             text,
      sms_es             text,
      -- Approval gate: nothing bulk sends itself.
      created_by_staff_id  uuid REFERENCES staff(id),
      approved_by_staff_id uuid REFERENCES staff(id),
      approved_at        timestamptz,
      sent_at            timestamptz,
      cancelled_at       timestamptz,
      -- Outcome counters, filled at send.
      intended_count     integer NOT NULL DEFAULT 0,
      sent_count         integer NOT NULL DEFAULT 0,
      suppressed_count   integer NOT NULL DEFAULT 0,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now(),
      -- A sent broadcast must name its approver. The gate is structural.
      CONSTRAINT broadcasts_approved_before_send
        CHECK (status <> 'sent' OR (approved_by_staff_id IS NOT NULL AND approved_at IS NOT NULL))
    );
    CREATE TRIGGER trg_broadcasts_updated_at BEFORE UPDATE ON broadcasts
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    COMMENT ON TABLE broadcasts IS
      'Segmented announcements. Approval-gated by CHECK, not convention: a row cannot reach status=sent without a named approver.';

    CREATE TABLE broadcast_recipients (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      broadcast_id  uuid NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
      contact_id    uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      channel       text NOT NULL CHECK (channel IN ('email', 'sms')),
      -- NULL reason = actually sent. Anything else is why it was not.
      suppressed_reason text,
      sent_at       timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now(),
      UNIQUE (broadcast_id, contact_id, channel)
    );
    CREATE INDEX idx_broadcast_recipients ON broadcast_recipients (broadcast_id, suppressed_reason);
    COMMENT ON TABLE broadcast_recipients IS
      'One row per intended recipient per channel INCLUDING suppressions, with the reason. A send that quietly reaches fewer people than intended is not auditable; this is.';

    CREATE TABLE review_requests (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id    uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      trigger       text NOT NULL,          -- 'return_accepted' | 'onboarding_complete'
      source_type   text,
      source_id     text,
      status        text NOT NULL DEFAULT 'sent'
                    CHECK (status IN ('sent', 'suppressed')),
      suppressed_reason text,
      sent_at       timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_review_requests_contact ON review_requests (contact_id, created_at DESC);
    COMMENT ON TABLE review_requests IS
      'Throttle + audit for Google review asks. Suppressed attempts are recorded so the throttle and the never-after-a-notice rule are provable.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE review_requests;
    DROP TABLE broadcast_recipients;
    DROP TABLE broadcasts;
    DROP TYPE broadcast_status;
    DROP TYPE broadcast_channel;
    ALTER TABLE contacts
      DROP COLUMN broadcast_opt_out_source,
      DROP COLUMN broadcast_opt_out_at;
  `);
};
