/**
 * 0008 — Invoices (M13, Stripe one-time billing).
 *
 * Spec: MP "Client Portal → Invoices & Payments" (Stripe inline, Pay Now,
 * history), automations 12 (Filed → invoice → portal notice → Rene → QB
 * export flag) and 17 (unpaid 14 days → reminder + Rene flag). Line amounts
 * come from the price book or staff-entered values at runtime — never code.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE invoice_status AS ENUM ('draft', 'sent', 'paid', 'overdue', 'void');

    -- Human-facing invoice numbers: SA-<year>-<sequence>. The sequence is
    -- global (does not reset per year) — numbers must never repeat.
    CREATE SEQUENCE invoice_number_seq START 1;

    CREATE TABLE invoices (
      id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_number             text NOT NULL UNIQUE,
      contact_id                 uuid NOT NULL REFERENCES contacts(id),
      engagement_id              uuid REFERENCES engagements(id),
      tax_engagement_id          uuid REFERENCES tax_engagements(id),
      status                     invoice_status NOT NULL DEFAULT 'draft',
      currency                   text NOT NULL DEFAULT 'usd',
      subtotal_cents             integer NOT NULL DEFAULT 0,
      total_cents                integer NOT NULL DEFAULT 0,
      amount_paid_cents          integer NOT NULL DEFAULT 0,
      due_date                   date,
      sent_at                    timestamptz,
      paid_at                    timestamptz,
      -- Stripe references (tokens/ids only — Stripe holds the card data;
      -- client PII never expands beyond payment tokens, MP vendor rule).
      stripe_checkout_session_id text,
      stripe_payment_intent_id   text,
      qb_exported_at             timestamptz,     -- NULL = pending the weekly QB CSV export
      price_book_version_id      uuid REFERENCES price_book_versions(id),
      created_by_staff_id        uuid REFERENCES staff(id),
      created_at                 timestamptz NOT NULL DEFAULT now(),
      updated_at                 timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE invoices IS
      'One-time invoices (Stripe Checkout). Recurring subscriptions (Stripe Billing) land in Phase 3.';
    CREATE INDEX idx_invoices_contact ON invoices (contact_id, status);
    CREATE INDEX idx_invoices_unpaid  ON invoices (sent_at) WHERE status = 'sent';

    CREATE TABLE invoice_line_items (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_id   uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      item_code    text,                -- price_book item code; NULL for custom/staff-entered lines
      description  text NOT NULL,       -- rendered in the client's language at creation
      qty          numeric(8,2) NOT NULL DEFAULT 1,
      unit_cents   integer NOT NULL,
      total_cents  integer NOT NULL,
      sort_order   integer NOT NULL DEFAULT 0,
      created_at   timestamptz NOT NULL DEFAULT now()
    );

    CREATE TRIGGER trg_invoices_updated_at BEFORE UPDATE ON invoices
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS invoice_line_items;
    DROP TABLE IF EXISTS invoices;
    DROP SEQUENCE IF EXISTS invoice_number_seq;
    DROP TYPE IF EXISTS invoice_status;
  `);
};
