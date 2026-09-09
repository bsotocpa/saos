/**
 * 0084 — the invoice state machine (2026-09-09, Brian's ruling after the second walk).
 *
 * SA-2026-0003 was refunded at 09:07:57 and PAID again at 09:23:18. The writer was the
 * payment-reconcile sweep: it selected the invoice because its status was not 'paid', asked
 * Stripe about the Checkout Session — whose payment_status stays 'paid' after a refund —
 * and markInvoicePaid, which only refused an invoice already 'paid', wrote paid over
 * refunded. Nothing in the database objected, because nothing in the database knew which
 * transitions are legal.
 *
 * Now it does. Every status change passes this trigger:
 *
 *   draft              → sent | paid
 *   sent               → paid | overdue | void   (void itself is judged by 0081)
 *   overdue            → paid | sent | void
 *   paid               → refunded | partially_refunded | disputed
 *   partially_refunded → refunded | disputed
 *   disputed           → paid | refunded | partially_refunded      (the dispute closed)
 *   refunded           → paid ONLY with a NEW payment intent        (a new payment record)
 *   void               → nothing                                     (0081; repeated here)
 *
 *   into refunded / partially_refunded: a refund row must exist for the invoice.
 *
 * The application layer says the same thing in words (reconcile only touches sent/overdue;
 * markInvoicePaid refuses a refunded invoice); this trigger is the correctness. Composes
 * with 0081's void guard: both must pass.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION invoices_state_guard() RETURNS trigger AS $$
    DECLARE
      allowed boolean := false;
    BEGIN
      IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
        RETURN NEW;
      END IF;
      -- Into void: 0081's void guard owns that rule (sent/overdue only, reason, no unrefunded
      -- payment) and says it in its own words; this guard defers so the sentence a person
      -- reads is the specific one. Out of void stays refused below.
      IF NEW.status = 'void' THEN
        RETURN NEW;
      END IF;

      CASE OLD.status
        WHEN 'draft' THEN
          allowed := NEW.status IN ('sent', 'paid');
        WHEN 'sent' THEN
          allowed := NEW.status IN ('paid', 'overdue', 'void');
        WHEN 'overdue' THEN
          allowed := NEW.status IN ('paid', 'sent', 'void');
        WHEN 'paid' THEN
          allowed := NEW.status IN ('refunded', 'partially_refunded', 'disputed');
        WHEN 'partially_refunded' THEN
          allowed := NEW.status IN ('refunded', 'disputed');
        WHEN 'disputed' THEN
          allowed := NEW.status IN ('paid', 'refunded', 'partially_refunded');
        WHEN 'refunded' THEN
          -- Money went back. Paid again means a NEW payment, which is a new payment intent.
          allowed := NEW.status = 'paid'
                     AND NEW.stripe_payment_intent_id IS NOT NULL
                     AND NEW.stripe_payment_intent_id IS DISTINCT FROM OLD.stripe_payment_intent_id;
        WHEN 'void' THEN
          allowed := false;
        ELSE
          allowed := false;
      END CASE;

      IF NOT allowed THEN
        RAISE EXCEPTION 'invoice % cannot move from % to %: not a legal transition (a refunded invoice is paid again only by a new payment; void is terminal)',
          OLD.invoice_number, OLD.status, NEW.status USING ERRCODE = 'check_violation';
      END IF;

      IF NEW.status IN ('refunded', 'partially_refunded')
         AND NOT EXISTS (SELECT 1 FROM invoice_refunds r WHERE r.invoice_id = NEW.id) THEN
        RAISE EXCEPTION 'invoice % cannot be marked % without a refund row — refunds are recorded, never asserted',
          OLD.invoice_number, NEW.status USING ERRCODE = 'check_violation';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`
    DROP TRIGGER IF EXISTS invoices_state_guard ON invoices;
    CREATE TRIGGER invoices_state_guard
      BEFORE UPDATE OF status ON invoices
      FOR EACH ROW EXECUTE FUNCTION invoices_state_guard();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TRIGGER IF EXISTS invoices_state_guard ON invoices;`);
  pgm.sql(`DROP FUNCTION IF EXISTS invoices_state_guard();`);
};
