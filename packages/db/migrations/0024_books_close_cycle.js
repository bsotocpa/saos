/**
 * M26 flow 5 (v4.3): the bookkeeping close cycle — Marian's workbench.
 *
 *  - close_cycles: one row per client per period, with the four checklist
 *    steps (categorized → reconciled → statements → closed) as timestamps so
 *    the workbench shows exactly where each client stands.
 *  - Statements AUTO-POST to the portal on close (no owner review gate — the
 *    session discusses what the client has already seen).
 *  - client_sessions: the calendar cross-check needs a source of truth for
 *    scheduled sessions. Cal.com bookings land here, so on close the system
 *    can ATTACH statements to an existing upcoming session instead of
 *    inventing a scheduling task (CLAUDE.md hard rule: never create a
 *    session-scheduling task without checking first).
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'financial_statements';
  `);
  pgm.sql(`
    CREATE TABLE client_sessions (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id     uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      staff_id       uuid REFERENCES staff(id),
      starts_at      timestamptz NOT NULL,
      ends_at        timestamptz,
      event_type     text,                    -- Cal.com event-type slug
      external_ref   text UNIQUE,             -- Cal.com booking uid (idempotent)
      is_recurring   boolean NOT NULL DEFAULT false,
      status         text NOT NULL DEFAULT 'scheduled'
                     CHECK (status IN ('scheduled', 'completed', 'cancelled')),
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_client_sessions_upcoming ON client_sessions (contact_id, starts_at)
      WHERE status = 'scheduled';
    CREATE TRIGGER trg_client_sessions_updated_at BEFORE UPDATE ON client_sessions
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    COMMENT ON TABLE client_sessions IS
      'Scheduled client sessions (Cal.com bookings). The books-close calendar cross-check reads this: an upcoming session means statements ATTACH, no scheduling task.';

    CREATE TABLE close_cycles (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id            uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      business_id           uuid REFERENCES businesses(id),
      engagement_id         uuid REFERENCES engagements(id),
      cadence               text NOT NULL CHECK (cadence IN ('weekly', 'monthly', 'quarterly', 'semi_annual')),
      period_start          date NOT NULL,
      period_end            date NOT NULL,
      assigned_staff_id     uuid REFERENCES staff(id),
      -- The four checklist steps, in order.
      categorized_at        timestamptz,
      reconciled_at         timestamptz,
      statements_ready_at   timestamptz,
      closed_at             timestamptz,
      -- What happened on close.
      statement_document_id uuid REFERENCES documents(id),
      attached_session_id   uuid REFERENCES client_sessions(id),
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      UNIQUE (contact_id, cadence, period_start)
    );
    CREATE INDEX idx_close_cycles_open ON close_cycles (period_end) WHERE closed_at IS NULL;
    CREATE TRIGGER trg_close_cycles_updated_at BEFORE UPDATE ON close_cycles
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    COMMENT ON COLUMN close_cycles.attached_session_id IS
      'Set when the close found an existing upcoming session — statements attached to it and NO scheduling task was created (v4.3 cross-check).';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE close_cycles;
    DROP TABLE client_sessions;
  `);
  // document_category keeps 'financial_statements' (enum values cannot be dropped).
};
