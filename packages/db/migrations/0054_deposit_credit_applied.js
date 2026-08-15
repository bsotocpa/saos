/**
 * FINDING #26 — the engagement letter promised a reconciliation nothing performed.
 *
 * Master §2: "all completed work is reconciled against your deposit at invoicing:
 * overpayments are credited to your account and any remaining balance is billed."
 * booking_confirmation: "the deposit … applies in full toward your invoice."
 *
 * Neither was implemented. The word "deposit" did not appear in the billing service;
 * `credit_cents` was read by dunning and written by nothing; the filed-to-invoice
 * automation billed `final_fee_cents` outright with no knowledge of what had been paid.
 * A client accepting an 1120-S quote would pay a $300 deposit and then be invoiced the
 * full $800 — $1,100 for an $800 engagement. On v5's full-prepay lines, exactly double.
 *
 * Brian's ruling 2026-08-15: apply the deposit as a line-item credit reading
 * "Deposit paid — applied", bill the remaining balance, derive the credit from the
 * STRIPE-CONFIRMED payment and never from a hand-entered figure, and fail invoice
 * generation loudly for a deposit-carrying engagement that lacks the credit.
 *
 * ONE COLUMN, ON THE DEPOSIT INVOICE. `deposit_applied_cents` records how much of that
 * deposit later invoices have consumed. Everything else derives from it:
 *
 *   available credit = SUM(paid deposit invoices) − SUM(deposit_applied_cents)
 *
 * Deliberately not a flag. A deposit larger than the invoice it credits must leave the
 * remainder available — Master §2 says overpayments are credited to the account, not
 * forfeited — and "applied: true" cannot express a partial application. Cents can.
 *
 * The credit itself is a NEGATIVE LINE ITEM rather than a column, so it is visible on the
 * invoice the client reads, reuses the mechanism discounts already use, and cannot drift
 * from the total the way a parallel column would.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE invoices
      ADD COLUMN deposit_applied_cents integer NOT NULL DEFAULT 0;

    COMMENT ON COLUMN invoices.deposit_applied_cents IS
      'Meaningful on a DEPOSIT invoice: how much of it later invoices have already credited. Available credit for an engagement is SUM(paid deposits) - SUM(deposit_applied_cents), so a deposit larger than the invoice it credits leaves the remainder available rather than forfeiting it (Master §2: overpayments are credited to the account).';

    -- A deposit cannot be consumed twice, nor for more than it was.
    ALTER TABLE invoices
      ADD CONSTRAINT invoices_deposit_applied_within_total CHECK (
        deposit_applied_cents >= 0 AND deposit_applied_cents <= total_cents
      );
  `);

  /*
   * The link from a final invoice back to the deposit it consumed.
   *
   * Without it, "which deposit paid for this?" is answerable only by reading line
   * descriptions, and a credit could be applied twice under concurrency with nothing to
   * show for it. The FK makes the relationship a fact rather than a convention.
   */
  pgm.sql(`
    ALTER TABLE invoices
      ADD COLUMN deposit_credit_from_invoice_id uuid REFERENCES invoices(id);

    COMMENT ON COLUMN invoices.deposit_credit_from_invoice_id IS
      'On an invoice carrying a "Deposit paid — applied" credit line: the deposit invoice that credit came from. Makes the reconciliation auditable without parsing line descriptions.';

    CREATE INDEX idx_invoices_deposit_credit_from ON invoices (deposit_credit_from_invoice_id)
      WHERE deposit_credit_from_invoice_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_invoices_deposit_credit_from;
    ALTER TABLE invoices
      DROP CONSTRAINT IF EXISTS invoices_deposit_applied_within_total,
      DROP COLUMN IF EXISTS deposit_credit_from_invoice_id,
      DROP COLUMN IF EXISTS deposit_applied_cents;
  `);
};
