/**
 * Hilo events (M27) — the Eventbrite replacement.
 *
 * Spec: bilingual event pages for Hilo workshops; registration with capacity
 * caps; confirmation + reminder email/SMS; attendee check-in list; post-event
 * follow-up into the Hilo CRM and the (§7216-gated) referral pipeline; and the
 * same-evening out-survey that feeds the funder report.
 *
 * Decisions worth stating:
 *
 *  · CAPACITY IS ENFORCED BY THE DATABASE, not by a count-then-insert in the
 *    app. Two people hitting Register on the last seat is the normal case at a
 *    popular workshop, and a read-then-write race would oversell it. A partial
 *    unique index gives each confirmed registration a distinct seat number, so
 *    the (capacity + 1)th insert fails outright.
 *
 *  · A WAITLIST IS A REAL STATE, not a full event turning people away. Seat
 *    number is NULL while waitlisted, which is also why the uniqueness index is
 *    partial.
 *
 *  · REGISTRANTS ARE NOT AUTOMATICALLY CONTACTS. A workshop attendee is a member
 *    of the public; linking them into the CRM is the post-event follow-up
 *    decision, and any referral to Soto is §7216-gated by the existing referral
 *    rules. So contact_id is nullable and set deliberately.
 *
 *  · The out-survey is stored per registration, because "who answered" and
 *    "who attended but didn't" is exactly what a funder report needs.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE event_status       AS ENUM ('draft', 'published', 'cancelled', 'completed');
    CREATE TYPE registration_status AS ENUM ('confirmed', 'waitlisted', 'cancelled', 'attended', 'no_show');

    CREATE TABLE events (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug            text NOT NULL UNIQUE,
      -- Bilingual by requirement: Hilo's audience is majority Spanish-speaking.
      title_en        text NOT NULL,
      title_es        text NOT NULL,
      description_en  text NOT NULL,
      description_es  text NOT NULL,
      location        text,
      is_virtual      boolean NOT NULL DEFAULT false,
      starts_at       timestamptz NOT NULL,
      ends_at         timestamptz,
      capacity        integer NOT NULL CHECK (capacity > 0),
      status          event_status NOT NULL DEFAULT 'draft',
      -- Hilo programme attribution for the funder report.
      program         text,
      published_at    timestamptz,
      cancelled_at    timestamptz,
      completed_at    timestamptz,
      created_by_staff_id uuid REFERENCES staff(id),
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      CHECK (ends_at IS NULL OR ends_at > starts_at)
    );
    CREATE TRIGGER trg_events_updated_at BEFORE UPDATE ON events
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE INDEX idx_events_upcoming ON events (starts_at) WHERE status = 'published';

    CREATE TABLE event_registrations (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      -- A registrant is a member of the public until someone links them.
      contact_id    uuid REFERENCES contacts(id) ON DELETE SET NULL,
      first_name    text NOT NULL,
      last_name     text NOT NULL,
      email         citext NOT NULL,
      phone         text,
      language      text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'es')),
      status        registration_status NOT NULL DEFAULT 'confirmed',
      -- Distinct per confirmed registration; NULL while waitlisted. This is the
      -- capacity guarantee — see the partial unique index below.
      seat_number   integer CHECK (seat_number IS NULL OR seat_number >= 1),
      -- TCPA: an SMS reminder needs its own consent, captured at registration.
      sms_opt_in    boolean NOT NULL DEFAULT false,
      confirmation_sent_at timestamptz,
      reminder_sent_at     timestamptz,
      checked_in_at        timestamptz,
      survey_sent_at       timestamptz,
      survey_answered_at   timestamptz,
      survey_satisfaction  integer CHECK (survey_satisfaction IS NULL OR survey_satisfaction BETWEEN 1 AND 5),
      survey_nps           integer CHECK (survey_nps IS NULL OR survey_nps BETWEEN 0 AND 10),
      survey_learned       text,
      survey_next          text,
      -- Set when the follow-up links this person into the Hilo CRM.
      linked_at     timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      -- One registration per person per event.
      UNIQUE (event_id, email),
      -- Checked in implies a seat existed.
      CHECK (checked_in_at IS NULL OR seat_number IS NOT NULL)
    );
    CREATE TRIGGER trg_event_registrations_updated_at BEFORE UPDATE ON event_registrations
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- THE CAPACITY GUARANTEE. Confirmed/attended registrations must hold distinct
    -- seat numbers, so two simultaneous registrations cannot both take the last
    -- seat: one insert wins and the other raises a unique violation, which the
    -- service turns into a waitlist placement.
    CREATE UNIQUE INDEX idx_event_seat_unique
      ON event_registrations (event_id, seat_number)
      WHERE seat_number IS NOT NULL;
    CREATE INDEX idx_event_registrations_event ON event_registrations (event_id, status);

    COMMENT ON COLUMN event_registrations.seat_number IS
      'Distinct per event for confirmed seats (partial unique index). Capacity is enforced here rather than by counting rows, because two people racing for the last seat is the normal case at a popular workshop.';
    COMMENT ON COLUMN event_registrations.contact_id IS
      'NULL until the post-event follow-up links this attendee into the CRM. A workshop attendee is a member of the public; any Soto referral remains §7216-gated.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE event_registrations;
    DROP TABLE events;
    DROP TYPE registration_status;
    DROP TYPE event_status;
  `);
};
