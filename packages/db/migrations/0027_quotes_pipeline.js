/**
 * M27 (v4.4): the quote builder + the lead pipeline it moves through.
 *
 *  - quotes compose from the price book (or a bundle) and PIN the price-book
 *    version at send time, so a price change later never re-prices a quote a
 *    client is looking at.
 *  - Accepting converts to an engagement + deposit checkout with ZERO
 *    re-entry: the accepted lines carry the locked prices forward.
 *  - Declined / expired quotes return to the leads pipeline WITH A REASON —
 *    a lost quote that records nothing teaches nothing.
 *  - lead_stage on contacts makes the funnel queryable:
 *    call_booked → quoted → deposit_paid → onboarding → client (or lost).
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE quote_status AS ENUM ('draft', 'sent', 'accepted', 'declined', 'expired');
    CREATE TYPE lead_stage  AS ENUM ('call_booked', 'quoted', 'deposit_paid', 'onboarding', 'client', 'lost');

    CREATE TABLE quotes (
      id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id             uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      business_id            uuid REFERENCES businesses(id),
      status                 quote_status NOT NULL DEFAULT 'draft',
      language               text NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'es')),
      bundle_slug            text,
      -- The version in force when the quote was SENT. A later price change
      -- creates a new version and leaves this quote untouched.
      price_book_version_id  uuid REFERENCES price_book_versions(id),
      subtotal_cents         integer NOT NULL DEFAULT 0,
      discount_cents         integer NOT NULL DEFAULT 0,
      total_cents            integer NOT NULL DEFAULT 0,
      -- Range quotes (MP: one-time work quotes as a RANGE, never exact).
      range_min_cents        integer,
      range_max_cents        integer,
      deposit_item_code      text,
      public_token_hash      text UNIQUE,     -- portal link; only the hash is stored
      expires_at             timestamptz,
      sent_at                timestamptz,
      accepted_at            timestamptz,
      declined_at            timestamptz,
      decline_reason         text,
      converted_engagement_id uuid REFERENCES engagements(id),
      deposit_invoice_id     uuid REFERENCES invoices(id),
      created_by_staff_id    uuid REFERENCES staff(id),
      notes                  text,
      created_at             timestamptz NOT NULL DEFAULT now(),
      updated_at             timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_quotes_contact ON quotes (contact_id, created_at DESC);
    CREATE INDEX idx_quotes_open ON quotes (expires_at) WHERE status = 'sent';
    CREATE TRIGGER trg_quotes_updated_at BEFORE UPDATE ON quotes
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    COMMENT ON COLUMN quotes.public_token_hash IS
      'SHA-256 of the client link token — the plaintext is emailed once and never stored (same rule as magic links).';

    CREATE TABLE quote_line_items (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      quote_id      uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
      item_code     text NOT NULL,          -- price-book reference; prices are COPIES of book values
      -- BOTH languages are frozen onto the line, not just the one the quote was
      -- written in: a client who flips the portal to Spanish must not get
      -- Spanish chrome wrapped around English service names.
      description_en text NOT NULL,
      description_es text NOT NULL,
      quantity      numeric(8,2) NOT NULL DEFAULT 1,
      unit_cents    integer,
      line_cents    integer,
      min_cents     integer,
      max_cents     integer,
      is_optional   boolean NOT NULL DEFAULT false,
      chosen        boolean NOT NULL DEFAULT true,
      is_pass_through boolean NOT NULL DEFAULT false,
      sort_order    integer NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_quote_lines ON quote_line_items (quote_id, sort_order);

    ALTER TABLE contacts
      ADD COLUMN lead_stage        lead_stage,
      ADD COLUMN lead_stage_at     timestamptz,
      ADD COLUMN lost_reason       text;
    COMMENT ON COLUMN contacts.lead_stage IS
      'v4.4 pipeline: call_booked → quoted → deposit_paid → onboarding → client (or lost). Conversion metrics read this.';

    CREATE TABLE lead_stage_history (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id   uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      stage        lead_stage NOT NULL,
      entered_at   timestamptz NOT NULL DEFAULT now(),
      note         text,
      changed_by_staff_id uuid REFERENCES staff(id)
    );
    CREATE INDEX idx_lead_stage_history ON lead_stage_history (contact_id, entered_at);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE lead_stage_history;
    ALTER TABLE contacts DROP COLUMN lead_stage, DROP COLUMN lead_stage_at, DROP COLUMN lost_reason;
    DROP TABLE quote_line_items;
    DROP TABLE quotes;
    DROP TYPE lead_stage;
    DROP TYPE quote_status;
  `);
};
