/**
 * Deposit flexibility (Brian's ruling, 2026-08-09).
 *
 * The deposit on a quote is overridable to ANY amount >= 0 — reduced or fully
 * waived — by staff holding the new `deposits.override` permission. The standard
 * price-book deposit stays the default; an override is a deliberate, recorded act.
 *
 * Two things this schema makes impossible rather than merely discouraged:
 *
 *  1. AN UNEXPLAINED OVERRIDE. The four override columns are all-or-nothing via
 *     CHECK: an amount cannot be stored without a reason, an approver, and a
 *     timestamp. "Who waived this and why" is answerable from the row alone.
 *
 *  2. AN UNTRACKED ENGAGEMENT. engagements.deposit_treatment records how the
 *     engagement was set up to pay — standard / reduced / waived — so A/R
 *     reporting can ask whether waived-deposit engagements pay worse, which is
 *     the actual business question behind the flexibility.
 *
 * The standard amount is stored ALONGSIDE the charged amount. Knowing an
 * engagement was waived is much less useful than knowing it was waived FROM
 * something — the gap is what AR wants to see.
 *
 * True-up math is untouched by design: it nets `invoices.credit_cents` and the
 * recorded deposit, both runtime values, so a waived deposit is simply a zero
 * credit rather than a special case.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE deposit_treatment AS ENUM ('standard', 'reduced', 'waived');

    ALTER TABLE quotes
      ADD COLUMN deposit_override_cents      integer CHECK (deposit_override_cents IS NULL OR deposit_override_cents >= 0),
      ADD COLUMN deposit_override_reason     text,
      ADD COLUMN deposit_override_by_staff_id uuid REFERENCES staff(id),
      ADD COLUMN deposit_override_at         timestamptz,
      -- An override without its reason and approver is not a record of anything.
      ADD CONSTRAINT quotes_deposit_override_complete CHECK (
        (deposit_override_cents IS NULL
          AND deposit_override_reason IS NULL
          AND deposit_override_by_staff_id IS NULL
          AND deposit_override_at IS NULL)
        OR (deposit_override_cents IS NOT NULL
          AND deposit_override_reason IS NOT NULL
          AND length(btrim(deposit_override_reason)) >= 10
          AND deposit_override_by_staff_id IS NOT NULL
          AND deposit_override_at IS NOT NULL)
      );
    COMMENT ON COLUMN quotes.deposit_override_cents IS
      'Staff-set deposit for this quote, >= 0 (0 = fully waived). NULL = the price-book deposit stands. Requires the deposits.override permission and a reason.';

    ALTER TABLE engagements
      ADD COLUMN deposit_treatment           deposit_treatment,
      -- What the price book said the deposit was, at conversion.
      ADD COLUMN deposit_standard_cents      integer CHECK (deposit_standard_cents IS NULL OR deposit_standard_cents >= 0),
      -- What was actually charged (0 when waived).
      ADD COLUMN deposit_charged_cents       integer CHECK (deposit_charged_cents IS NULL OR deposit_charged_cents >= 0),
      ADD COLUMN deposit_override_reason     text,
      ADD COLUMN deposit_override_by_staff_id uuid REFERENCES staff(id),
      -- A non-standard treatment must carry its reason forward to AR.
      ADD CONSTRAINT engagements_deposit_reason_when_nonstandard CHECK (
        deposit_treatment IS NULL
        OR deposit_treatment = 'standard'
        OR (deposit_override_reason IS NOT NULL AND deposit_override_by_staff_id IS NOT NULL)
      );
    COMMENT ON COLUMN engagements.deposit_treatment IS
      'How this engagement was set up to pay: standard / reduced / waived. A/R reporting groups on it to answer whether non-standard deposits collect worse.';
    COMMENT ON COLUMN engagements.deposit_standard_cents IS
      'The price-book deposit at conversion. Stored beside deposit_charged_cents because the GAP is what AR wants, not the flag alone.';

    CREATE INDEX idx_engagements_deposit_treatment ON engagements (deposit_treatment)
      WHERE deposit_treatment IS DISTINCT FROM 'standard';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_engagements_deposit_treatment;
    ALTER TABLE engagements
      DROP CONSTRAINT engagements_deposit_reason_when_nonstandard,
      DROP COLUMN deposit_override_by_staff_id,
      DROP COLUMN deposit_override_reason,
      DROP COLUMN deposit_charged_cents,
      DROP COLUMN deposit_standard_cents,
      DROP COLUMN deposit_treatment;
    ALTER TABLE quotes
      DROP CONSTRAINT quotes_deposit_override_complete,
      DROP COLUMN deposit_override_at,
      DROP COLUMN deposit_override_by_staff_id,
      DROP COLUMN deposit_override_reason,
      DROP COLUMN deposit_override_cents;
    DROP TYPE deposit_treatment;
  `);
};
