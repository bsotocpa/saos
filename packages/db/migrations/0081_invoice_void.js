/**
 * 0081 — the void path (2026-09-09, Brian's ruling).
 *
 * `void` has been an invoice_status value since 0008 and nothing ever set it. SA-2026-0002
 * was the first invoice anyone needed gone — a rehearsal deposit superseded by a smaller
 * one — and there was no legitimate way to retire it.
 *
 * THE RULE LIVES IN THE DATABASE, not in a route handler:
 *   · only a sent or overdue invoice can become void — a paid one is refunded, never voided;
 *   · an invoice carrying an unrefunded payment cannot be voided either (that money would
 *     have no invoice under it);
 *   · a reason is required, and the actor is recorded;
 *   · void is terminal — nothing moves an invoice out of it.
 * Any code path — a route, a job, a psql session — that tries otherwise is refused by the
 * trigger with a sentence a person can read.
 *
 * The invoice number is retained. It comes from invoice_number_seq and is never reissued.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS void_reason         text,
      ADD COLUMN IF NOT EXISTS voided_at           timestamptz,
      ADD COLUMN IF NOT EXISTS voided_by_staff_id  uuid REFERENCES staff(id) ON DELETE SET NULL;
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION invoices_void_guard() RETURNS trigger AS $$
    BEGIN
      IF OLD.status = 'void' AND NEW.status IS DISTINCT FROM 'void' THEN
        RAISE EXCEPTION 'invoice % is void, and void is terminal', OLD.invoice_number
          USING ERRCODE = 'check_violation';
      END IF;

      IF NEW.status = 'void' AND OLD.status IS DISTINCT FROM 'void' THEN
        IF OLD.status NOT IN ('sent', 'overdue') THEN
          RAISE EXCEPTION 'invoice % cannot be voided from status %: only a sent or overdue invoice can be voided — a paid invoice is refunded, not voided',
            OLD.invoice_number, OLD.status USING ERRCODE = 'check_violation';
        END IF;
        IF OLD.amount_paid_cents > OLD.amount_refunded_cents THEN
          RAISE EXCEPTION 'invoice % carries an unrefunded payment and cannot be voided — refund it first',
            OLD.invoice_number USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.void_reason IS NULL OR btrim(NEW.void_reason) = '' THEN
          RAISE EXCEPTION 'voiding invoice % requires a reason', OLD.invoice_number
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.voided_at IS NULL THEN
          NEW.voided_at := now();
        END IF;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    DROP TRIGGER IF EXISTS invoices_void_guard ON invoices;
    CREATE TRIGGER invoices_void_guard
      BEFORE UPDATE OF status ON invoices
      FOR EACH ROW EXECUTE FUNCTION invoices_void_guard();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TRIGGER IF EXISTS invoices_void_guard ON invoices;`);
  pgm.sql(`DROP FUNCTION IF EXISTS invoices_void_guard();`);
  pgm.sql(`
    ALTER TABLE invoices
      DROP COLUMN IF EXISTS void_reason,
      DROP COLUMN IF EXISTS voided_at,
      DROP COLUMN IF EXISTS voided_by_staff_id;
  `);
};
