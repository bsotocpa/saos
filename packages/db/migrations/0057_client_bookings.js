/*
 * BOOKINGS BECOME A RECORD (Brian, 2026-08-16, finding #35).
 *
 * #35 puts scheduling on the portal home, and Brian attached a policy to it: "every
 * channel a client can claim they used must be one the system tracks."
 *
 * The Cal.com webhook already fired on BOOKING_CREATED — it created or linked the
 * contact, tasked the team and wrote an audit row — but it kept nothing a client-facing
 * screen could read. So the portal could offer a booking link and then show the client
 * nothing about the booking they just made, and a client saying "I booked a call" could
 * only be checked by reading the audit log. That is tracked in the forensic sense and
 * untracked in every sense that matters to the person who booked.
 *
 * `meetings` was the wrong home for this: it records sessions that HAPPENED, with a
 * duration and a recording. A booking is a future commitment and often has neither.
 *
 * Idempotent on (contact_id, external_id): Cal.com retries webhooks, and a retry must
 * not become a second meeting on the client's home screen.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE client_bookings (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id    uuid NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
      external_id   text,                       -- Cal.com uid when it sends one
      event_slug    text NOT NULL,
      title         text,
      starts_at     timestamptz,
      location      text,
      cancelled_at  timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_client_bookings_contact ON client_bookings (contact_id, starts_at DESC);

    -- A retried webhook is the same booking. Partial, because Cal.com does not always
    -- send an id and NULLs would defeat a plain unique constraint.
    CREATE UNIQUE INDEX idx_client_bookings_external
      ON client_bookings (contact_id, external_id) WHERE external_id IS NOT NULL;

    CREATE TRIGGER trg_client_bookings_updated_at BEFORE UPDATE ON client_bookings
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    COMMENT ON TABLE client_bookings IS
      'Bookings made through the scheduler, kept so the portal can show a client the meeting they booked. Written by the Cal.com webhook only — never by a client asserting that a meeting exists, per the rule that every channel a client can claim they used must be one the system tracks.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS client_bookings;`);
};
