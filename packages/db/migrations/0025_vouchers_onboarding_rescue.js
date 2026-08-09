/**
 * M26 flows 6 + 7 (v4.3).
 *
 * FLOW 6 — grant vouchering tracker. STATUS TRACKING ONLY: the system never
 * generates a voucher file; Brian does that work outside SAOS and records
 * where each period stands (Due → In progress → Submitted → Reimbursed).
 *
 * FLOW 7 — stalled-onboarding rescue. Staff-visible pipeline stages over the
 * existing portal_onboarding row (deposit → questionnaire → docs → complete),
 * with the deposit recorded so a stall can surface at Day 60 as a CREDIT that
 * is never auto-refunded.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE voucher_status AS ENUM ('due', 'in_progress', 'submitted', 'reimbursed');

    CREATE TABLE grant_voucher_periods (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      grant_id       uuid NOT NULL REFERENCES grants_received(id) ON DELETE CASCADE,
      period_label   text NOT NULL,                -- e.g. '2026-Q3', 'Jul 2026'
      period_start   date,
      period_end     date,
      funder_due_date date,
      amount_cents   bigint,
      status         voucher_status NOT NULL DEFAULT 'due',
      submitted_at   timestamptz,
      reimbursed_at  timestamptz,
      notes          text,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      UNIQUE (grant_id, period_label)
    );
    CREATE INDEX idx_voucher_periods_open ON grant_voucher_periods (funder_due_date)
      WHERE status <> 'reimbursed';
    CREATE TRIGGER trg_voucher_periods_updated_at BEFORE UPDATE ON grant_voucher_periods
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    COMMENT ON TABLE grant_voucher_periods IS
      'v4.3 flow 6: STATUS TRACKING ONLY. SAOS never generates voucher files — Brian operates that work outside the system and records status here.';

    -- Flow 7: the staff-visible onboarding pipeline + the held deposit.
    ALTER TABLE portal_onboarding
      ADD COLUMN deposit_paid_at        timestamptz,
      ADD COLUMN deposit_amount_cents   integer,
      ADD COLUMN deposit_invoice_id     uuid REFERENCES invoices(id),
      ADD COLUMN stalled_flagged_at     timestamptz,
      ADD COLUMN rescue_started_at      timestamptz;
    COMMENT ON COLUMN portal_onboarding.deposit_amount_cents IS
      'Deposit collected at booking. On a Day-60 stall it is held as a CREDIT for Brian to decide on — never auto-refunded (v4.3 flow 7).';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE portal_onboarding
      DROP COLUMN deposit_paid_at, DROP COLUMN deposit_amount_cents,
      DROP COLUMN deposit_invoice_id, DROP COLUMN stalled_flagged_at,
      DROP COLUMN rescue_started_at;
    DROP TABLE grant_voucher_periods;
    DROP TYPE voucher_status;
  `);
};
