/*
 * THE TRANSACTIONAL OUTBOX (#48, Brian's named trigger fired 2026-08-17).
 *
 * The rule that made this necessary: durable state commits atomically, and outward effects
 * happen after the commit. An email cannot be rolled back, so it must not be inside the
 * transaction; but a send that only exists in the code AFTER the commit is lost the moment
 * the process dies between the two.
 *
 * The outbox closes that gap. The intent to send is a ROW, written inside the same
 * transaction as the state that justifies it — so it commits or vanishes with that state,
 * exactly like the state's own audit row. A drain then performs it afterwards, with retries,
 * and a dead-letter that raises a P1 task naming the client.
 *
 * Brian's trigger was "build it when a SECOND post-commit effect path appears." Three
 * appeared at once:
 *   1. acceptance's deposit invoice email (#48 part one, previously inline)
 *   2. the packet signature link, which used to send BEFORE recording that it had
 *   3. the filed-return invoice email, sent mid-sequence inside `transitionStage`
 *
 * WHY NOT A QUEUE SERVER. Approved vendors are Stripe, Twilio, SES and the KBA API; adding a
 * broker would be a new dependency holding client data on a box with 16GB shared between
 * Whisper, Ollama and everything else. Postgres already has the transaction we need to be
 * atomic with, which is the entire difficulty.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE outbox_status AS ENUM ('pending', 'sent', 'failed', 'abandoned');

    CREATE TABLE outbox (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      -- WHAT to do. A short verb the drain dispatches on, never a serialised function.
      effect         text NOT NULL,
      -- The arguments, by id. Deliberately NOT a rendered message body: the drain re-reads
      -- the record at send time, so a template correction between enqueue and send is
      -- picked up, and NO PII sits in this table (CLAUDE.md).
      payload        jsonb NOT NULL,

      status         outbox_status NOT NULL DEFAULT 'pending',
      attempts       integer NOT NULL DEFAULT 0,
      -- Backoff: the drain skips rows whose next attempt is in the future.
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      last_error     text,

      -- Who this is about, so a dead letter can name a client without decoding the payload.
      contact_id     uuid REFERENCES contacts(id) ON DELETE CASCADE,
      -- What justified it, for tracing a send back to the state that asked for it.
      object_type    text,
      object_id      uuid,

      created_at     timestamptz NOT NULL DEFAULT now(),
      sent_at        timestamptz,

      /*
       * A terminal row explains itself. 'sent' carries when; 'abandoned' carries why. The
       * same argument as engagements.close_reason: the missing "why" is what someone needs
       * a year later, and a comment promising it does not survive the first hurry.
       */
      CONSTRAINT outbox_sent_has_time CHECK (status <> 'sent' OR sent_at IS NOT NULL),
      CONSTRAINT outbox_abandoned_has_error CHECK (status <> 'abandoned' OR last_error IS NOT NULL)
    );

    -- The drain's only query: due pending work, oldest first.
    CREATE INDEX idx_outbox_due ON outbox (next_attempt_at)
      WHERE status IN ('pending', 'failed');
    CREATE INDEX idx_outbox_contact ON outbox (contact_id) WHERE contact_id IS NOT NULL;

    COMMENT ON TABLE outbox IS
      '#48: intents to perform an outward effect, written INSIDE the transaction that justifies them and performed after it commits. Retried with backoff; abandoned rows raise a P1 task.';
    COMMENT ON COLUMN outbox.payload IS
      'Arguments by ID only — never a rendered message and never PII. The drain re-reads the record at send time, so a template fix between enqueue and send is picked up.';
  `);

  /*
   * ONE PENDING EFFECT PER THING. Two rows asking to email the same invoice is two emails to
   * the client, and the ways that happens — a retried request, a re-run job, a double-click
   * three layers up — are all things this system has already been bitten by (#41).
   *
   * Partial, on the non-terminal states only: an invoice legitimately gets emailed again
   * later (a reminder is its own effect), so the uniqueness has to lapse once a row is done.
   */
  pgm.sql(`
    CREATE UNIQUE INDEX idx_outbox_one_pending
      ON outbox (effect, object_type, object_id)
      WHERE status IN ('pending', 'failed') AND object_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS outbox;
    DROP TYPE IF EXISTS outbox_status;
  `);
};
