/**
 * 0080 — refunds, disputes, and the Stripe event latch (2026-09-09).
 *
 * Brian refunded the first real card payment in the Stripe dashboard. SAOS kept the invoice
 * at `paid` — it was subscribed to two events and a refund was not one of them. An invoice
 * that says Paid over money that went back is a check that lies, and it would have lied
 * forever: nothing in the system could ever have noticed.
 *
 *   invoice_status gains refunded / partially_refunded / disputed.
 *   invoice_refunds   — one row per Stripe refund (or per lost dispute), keyed by Stripe's id
 *                        so a replayed event cannot record the same refund twice.
 *   invoice_disputes  — one row per Stripe dispute, with the evidence deadline from the payload.
 *   stripe_events     — THE LATCH: one row per Stripe event id, claimed by INSERT ... ON
 *                        CONFLICT DO NOTHING inside the handler's transaction (#48 shape: the
 *                        claim is the statement, not a read followed by a decision). A second
 *                        delivery of the same event finds the row and performs nothing.
 *   invoices.amount_refunded_cents — gross, cumulative, as Stripe reports it. Refunds are
 *                        gross; Stripe's retained fee is a bookkeeping matter, not SAOS's.
 *
 * Enum values are added first and NOT used in this migration (PG12+ rule).
 */

exports.up = (pgm) => {
  pgm.sql(`ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'refunded';`);
  pgm.sql(`ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'partially_refunded';`);
  pgm.sql(`ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'disputed';`);

  pgm.sql(`
    ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS amount_refunded_cents integer NOT NULL DEFAULT 0
        CHECK (amount_refunded_cents >= 0);
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS stripe_events (
      event_id     text PRIMARY KEY,
      type         text NOT NULL,
      invoice_id   uuid REFERENCES invoices(id) ON DELETE SET NULL,
      received_at  timestamptz NOT NULL DEFAULT now(),
      outcome      jsonb
    );
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS invoice_refunds (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_id        uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      -- Stripe's re_... id, or 'dispute:<dp_...>' for funds withdrawn by a lost dispute.
      stripe_refund_id  text NOT NULL UNIQUE,
      amount_cents      integer NOT NULL CHECK (amount_cents > 0),
      reason            text,
      stripe_event_id   text REFERENCES stripe_events(event_id) ON DELETE SET NULL,
      created_at        timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS invoice_refunds_invoice_idx ON invoice_refunds (invoice_id);
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS invoice_disputes (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_id         uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      stripe_dispute_id  text NOT NULL UNIQUE,
      amount_cents       integer NOT NULL CHECK (amount_cents >= 0),
      reason             text,
      status             text NOT NULL,
      evidence_due_by    timestamptz,
      opened_at          timestamptz NOT NULL DEFAULT now(),
      closed_at          timestamptz,
      outcome            text,
      task_id            uuid REFERENCES tasks(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS invoice_disputes_invoice_idx ON invoice_disputes (invoice_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS invoice_disputes;`);
  pgm.sql(`DROP TABLE IF EXISTS invoice_refunds;`);
  pgm.sql(`DROP TABLE IF EXISTS stripe_events;`);
  pgm.sql(`ALTER TABLE invoices DROP COLUMN IF EXISTS amount_refunded_cents;`);
  // Enum values cannot be dropped in PostgreSQL; harmless to leave.
};
