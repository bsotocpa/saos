/* eslint-disable camelcase */
/**
 * 0129 — DISCOUNT RULES LIVE IN THE PRICE BOOK (Brian, 2026-09-27, R75).
 *
 * The Hilo referral discount (ruled 2026-09-12: "a price-book tier applied at quote time, shown on the
 * proposal"; R75 sets it) is a rule of the book, versioned with it: the rate and the lines it reaches
 * are data a version carries, never code. A version publish copies these rows like the items and the
 * bundle rules, and the Admin → Pricing door adds or changes them in the new version only.
 *
 *   percent_rate            the discount, in percent (50 = half off), same scale as price_book_items
 *   applies_to_service_lines the price lines it reaches (R75: individual_tax, business_tax,
 *                           entity_services — tax returns and entity services; never recurring
 *                           accounting, software pass-through, attest or COO)
 *   condition               who qualifies; one value today: referred_by_hilo (the contact's Hilo
 *                           referral attribution on the record, contacts.br1_referred_by_hilo)
 *   scope                   when; one value today: first_engagement (the client has no engagement yet)
 *
 * Quotes: quotes.referral_discount_* hold the rule a quote applied (code, label, rate, the lines it
 * reaches, the amount) and its removal (by, at, reason). The amount is apart from discount_cents (the
 * package discount): total = subtotal - package discount - referral discount. The CEO may remove it
 * with a reason; nothing widens it.
 * Engagements: the rule the accepted quote applied, so each invoice on the engagement shows the line.
 * Invoices: invoice_discount_lines records the discount line an invoice carries (the invoice total is
 * already net of it); the money line counts these as discounts.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS price_book_discount_rules (
      id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      version_id                uuid NOT NULL REFERENCES price_book_versions(id) ON DELETE CASCADE,
      rule_code                 text NOT NULL,
      name_en                   text NOT NULL,
      name_es                   text NOT NULL,
      description_en            text,
      description_es            text,
      percent_rate              numeric(6,3) NOT NULL,
      applies_to_service_lines  price_service_line[] NOT NULL,
      condition                 text NOT NULL,
      scope                     text NOT NULL,
      is_active                 boolean NOT NULL DEFAULT true,
      sort_order                integer NOT NULL DEFAULT 0,
      created_at                timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT price_book_discount_rules_code_per_version UNIQUE (version_id, rule_code),
      CONSTRAINT price_book_discount_rules_rate_sane CHECK (percent_rate > 0 AND percent_rate <= 100),
      CONSTRAINT price_book_discount_rules_lines_named CHECK (cardinality(applies_to_service_lines) > 0),
      CONSTRAINT price_book_discount_rules_condition_known CHECK (condition IN ('referred_by_hilo')),
      CONSTRAINT price_book_discount_rules_scope_known CHECK (scope IN ('first_engagement'))
    )
  `);
  await pgm.db.query(`
    ALTER TABLE quotes
      ADD COLUMN IF NOT EXISTS referral_discount_rule_code text,
      ADD COLUMN IF NOT EXISTS referral_discount_label_en text,
      ADD COLUMN IF NOT EXISTS referral_discount_label_es text,
      ADD COLUMN IF NOT EXISTS referral_discount_rate numeric(6,3),
      ADD COLUMN IF NOT EXISTS referral_discount_service_lines text[],
      ADD COLUMN IF NOT EXISTS referral_discount_cents integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS referral_discount_removed_at timestamptz,
      ADD COLUMN IF NOT EXISTS referral_discount_removed_by uuid REFERENCES staff(id),
      ADD COLUMN IF NOT EXISTS referral_discount_removed_reason text
  `);
  await pgm.db.query(`
    ALTER TABLE quotes
      DROP CONSTRAINT IF EXISTS quotes_referral_discount_whole,
      ADD CONSTRAINT quotes_referral_discount_whole CHECK (
        (referral_discount_rule_code IS NULL) = (referral_discount_rate IS NULL)
        AND (referral_discount_rule_code IS NULL) = (referral_discount_service_lines IS NULL)
        AND (referral_discount_rule_code IS NULL) = (referral_discount_label_en IS NULL)
        AND referral_discount_cents >= 0
        AND (referral_discount_rule_code IS NOT NULL OR referral_discount_cents = 0)
        AND ((referral_discount_removed_at IS NULL) = (referral_discount_removed_reason IS NULL))
        AND ((referral_discount_removed_at IS NULL) = (referral_discount_removed_by IS NULL))
        AND (referral_discount_removed_at IS NULL OR referral_discount_cents = 0)
      )
  `);
  /*
   * The engagement carries the rule its accepted quote applied, so every invoice raised on it shows
   * the discount as its own line (createInvoice). Snapshotted at acceptance; never widened after.
   */
  await pgm.db.query(`
    ALTER TABLE engagements
      ADD COLUMN IF NOT EXISTS referral_discount_rule_code text,
      ADD COLUMN IF NOT EXISTS referral_discount_label_en text,
      ADD COLUMN IF NOT EXISTS referral_discount_label_es text,
      ADD COLUMN IF NOT EXISTS referral_discount_rate numeric(6,3),
      ADD COLUMN IF NOT EXISTS referral_discount_service_lines text[],
      ADD COLUMN IF NOT EXISTS referral_discount_quote_id uuid REFERENCES quotes(id)
  `);
  await pgm.db.query(`
    ALTER TABLE engagements
      DROP CONSTRAINT IF EXISTS engagements_referral_discount_whole,
      ADD CONSTRAINT engagements_referral_discount_whole CHECK (
        (referral_discount_rule_code IS NULL) = (referral_discount_rate IS NULL)
        AND (referral_discount_rule_code IS NULL) = (referral_discount_service_lines IS NULL)
        AND (referral_discount_rule_code IS NULL) = (referral_discount_quote_id IS NULL)
        AND (referral_discount_rate IS NULL OR (referral_discount_rate > 0 AND referral_discount_rate <= 100))
      )
  `);
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS invoice_discount_lines (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_id    uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      rule_code     text NOT NULL,
      label_en      text NOT NULL,
      label_es      text NOT NULL,
      percent_rate  numeric(6,3) NOT NULL,
      amount_cents  integer NOT NULL CHECK (amount_cents > 0),
      engagement_id uuid REFERENCES engagements(id),
      created_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT invoice_discount_lines_one_per_rule UNIQUE (invoice_id, rule_code)
    )
  `);
  await pgm.db.query(`
    COMMENT ON TABLE price_book_discount_rules IS
      'R75: discount rules of a price-book version (the Hilo referral discount). Copied whole by a version publish; the rate and the lines reached are data, never code.'
  `);
  await pgm.db.query(`
    COMMENT ON TABLE invoice_discount_lines IS
      'R75: a discount shown as its own line on an invoice (the invoice total is already net of it); counted on the money line as a discount.'
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS invoice_discount_lines`);
  await pgm.db.query(`ALTER TABLE engagements DROP CONSTRAINT IF EXISTS engagements_referral_discount_whole`);
  await pgm.db.query(`
    ALTER TABLE engagements
      DROP COLUMN IF EXISTS referral_discount_quote_id,
      DROP COLUMN IF EXISTS referral_discount_service_lines,
      DROP COLUMN IF EXISTS referral_discount_rate,
      DROP COLUMN IF EXISTS referral_discount_label_es,
      DROP COLUMN IF EXISTS referral_discount_label_en,
      DROP COLUMN IF EXISTS referral_discount_rule_code
  `);
  await pgm.db.query(`ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_referral_discount_whole`);
  await pgm.db.query(`
    ALTER TABLE quotes
      DROP COLUMN IF EXISTS referral_discount_removed_reason,
      DROP COLUMN IF EXISTS referral_discount_removed_by,
      DROP COLUMN IF EXISTS referral_discount_removed_at,
      DROP COLUMN IF EXISTS referral_discount_cents,
      DROP COLUMN IF EXISTS referral_discount_service_lines,
      DROP COLUMN IF EXISTS referral_discount_rate,
      DROP COLUMN IF EXISTS referral_discount_label_es,
      DROP COLUMN IF EXISTS referral_discount_label_en,
      DROP COLUMN IF EXISTS referral_discount_rule_code
  `);
  await pgm.db.query(`DROP TABLE IF EXISTS price_book_discount_rules`);
};
