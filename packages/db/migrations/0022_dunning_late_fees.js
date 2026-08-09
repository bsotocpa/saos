/**
 * M26 flow 4 (v4.3): A/R dunning ladder + late fees.
 *
 *  - Dunning attempts are tracked per invoice so the ladder (reminder ×3 over
 *    10 days → Rene call task → 30-day work pause) never double-fires and can
 *    resume after a restart.
 *  - Work pause is CLIENT-VISIBLE ("account needs attention") — the pause
 *    lives on the engagement, not a hidden flag.
 *  - Late fees: itemized fee lines on the invoice, and the audit of WHY one
 *    was allowed. The disclosure gate is a stamp written when an engagement
 *    letter carrying the late-fee disclosure completes — templates declare
 *    whether they contain it.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE invoices
      ADD COLUMN dunning_attempts     integer NOT NULL DEFAULT 0,
      ADD COLUMN last_dunning_at      timestamptz,
      ADD COLUMN late_fee_cents       integer NOT NULL DEFAULT 0,
      ADD COLUMN last_late_fee_at     timestamptz,
      -- Ladder clock: stamped when the invoice flips to overdue.
      ADD COLUMN overdue_since        date,
      -- Deposits/credits applied to this invoice. They net against the balance
      -- BEFORE any late fee computes (v4.3 rule).
      ADD COLUMN credit_cents         integer NOT NULL DEFAULT 0;
    COMMENT ON COLUMN invoices.late_fee_cents IS
      'Cumulative late fee assessed on this invoice (price-book rate; engagement-letter-disclosure gated).';

    CREATE TABLE invoice_late_fees (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_id     uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      assessed_on    date NOT NULL,
      basis_cents    integer NOT NULL,      -- overdue balance AFTER deposits/credits
      rate_percent   numeric(5,3) NOT NULL, -- from the price book at assessment time
      fee_cents      integer NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now(),
      UNIQUE (invoice_id, assessed_on)
    );
    COMMENT ON TABLE invoice_late_fees IS
      'One row per assessment: the basis (net of deposits/credits), the price-book rate used, and the fee. UNIQUE per day = never double-charged.';

    -- Work pause (client-visible): v4.3 "account needs attention".
    ALTER TABLE engagements
      ADD COLUMN work_paused_at     timestamptz,
      ADD COLUMN work_pause_reason  text;

    -- The disclosure gate: templates declare it; signing stamps the contact.
    ALTER TABLE templates ADD COLUMN has_late_fee_disclosure boolean NOT NULL DEFAULT false;
    ALTER TABLE contacts ADD COLUMN late_fee_disclosure_signed_at timestamptz;
    COMMENT ON COLUMN contacts.late_fee_disclosure_signed_at IS
      'Set when an engagement letter whose template carries the late-fee disclosure is signed. NULL = late fees can NEVER be applied (CLAUDE.md gate).';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE invoice_late_fees;
    ALTER TABLE invoices
      DROP COLUMN dunning_attempts, DROP COLUMN last_dunning_at,
      DROP COLUMN late_fee_cents, DROP COLUMN last_late_fee_at,
      DROP COLUMN overdue_since, DROP COLUMN credit_cents;
    ALTER TABLE engagements DROP COLUMN work_paused_at, DROP COLUMN work_pause_reason;
    ALTER TABLE templates DROP COLUMN has_late_fee_disclosure;
    ALTER TABLE contacts DROP COLUMN late_fee_disclosure_signed_at;
  `);
};
