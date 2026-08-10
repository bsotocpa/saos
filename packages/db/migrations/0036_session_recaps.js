/**
 * Session recaps (v4.2 NEW MODULES #6) — the client-visible half of the session
 * product.
 *
 * The recap columns were scaffolded onto meeting_summaries in an early migration
 * (client_recap_status, recap_body_en/es, recap_approved_by/_at) and nothing ever
 * wrote them. This migration finishes the shape and — more importantly — makes the
 * approval gate STRUCTURAL rather than a promise in a service function.
 *
 * Spec: "a bilingual client recap is drafted and queued for Brian's one-tap
 * approval before sending to the client's portal thread + email. Approval-gated,
 * never auto-sent."
 *
 * "Never auto-sent" is worth more than a comment, so:
 *   · a row cannot reach 'approved' or 'sent' without a named approver and a
 *     timestamp, and
 *   · a row cannot reach 'sent' without a send timestamp.
 * Both are CHECKs, so no code path — including a direct UPDATE — can produce a
 * recap that reached a client without a human's name on it.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE meeting_summaries
      ADD COLUMN recap_sent_at    timestamptz,
      -- The portal-thread message the client actually reads, so "did it send"
      -- is answerable from the record rather than from the mail log.
      ADD COLUMN recap_message_id uuid REFERENCES messages(id),
      ADD COLUMN recap_emailed    boolean NOT NULL DEFAULT false,
      -- Recorded when the send was suppressed because the automation is off, so
      -- an approved-but-unsent recap explains itself.
      ADD COLUMN recap_send_suppressed_reason text,
      ADD CONSTRAINT recap_approved_has_approver CHECK (
        client_recap_status NOT IN ('approved', 'sent')
        OR (recap_approved_by_staff_id IS NOT NULL AND recap_approved_at IS NOT NULL)
      ),
      ADD CONSTRAINT recap_sent_has_timestamp CHECK (
        client_recap_status <> 'sent' OR recap_sent_at IS NOT NULL
      ),
      -- A drafted recap must actually have copy in BOTH languages. Every Soto
      -- client-facing surface ships EN and ES; a recap half-written in one is not
      -- a draft, it is a trap for whoever approves it.
      ADD CONSTRAINT recap_drafted_is_bilingual CHECK (
        client_recap_status = 'none'
        OR (recap_body_en IS NOT NULL AND length(btrim(recap_body_en)) > 0
            AND recap_body_es IS NOT NULL AND length(btrim(recap_body_es)) > 0)
      );

    COMMENT ON COLUMN meeting_summaries.client_recap_status IS
      'none → drafted → approved → sent. Reaching approved/sent requires a named approver (CHECK): the recap is never auto-sent.';
    COMMENT ON COLUMN meeting_summaries.recap_send_suppressed_reason IS
      'Why an approved recap has not reached the client — normally the session_recaps automation being disarmed.';

    CREATE INDEX idx_meeting_summaries_recap_queue
      ON meeting_summaries (client_recap_status)
      WHERE client_recap_status IN ('drafted', 'approved');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_meeting_summaries_recap_queue;
    ALTER TABLE meeting_summaries
      DROP CONSTRAINT recap_drafted_is_bilingual,
      DROP CONSTRAINT recap_sent_has_timestamp,
      DROP CONSTRAINT recap_approved_has_approver,
      DROP COLUMN recap_send_suppressed_reason,
      DROP COLUMN recap_emailed,
      DROP COLUMN recap_message_id,
      DROP COLUMN recap_sent_at;
  `);
};
