/**
 * 0007 — Price book: versioned, effective-dated pricing + bundle rules +
 * engagement price locks.
 *
 * Spec: MP v4.2 "Billing Architecture" — every price in the system lives in a
 * versioned, effective-dated price_book table. Admin edits create a NEW
 * version; engagements reference the version in force at signing. NO price is
 * ever hardcoded — launch-day increases are a data change. CLAUDE.md makes a
 * price literal in application code a build failure (scripts/check-no-hardcoded-prices.mjs).
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE price_unit AS ENUM (
      'flat', 'per_hour', 'per_form', 'per_month', 'per_quarter', 'per_6_months',
      'per_year', 'per_state', 'per_property', 'per_k1', 'per_filing', 'per_unit',
      'per_additional'
    );
    CREATE TYPE price_service_line AS ENUM (
      'individual_tax', 'business_tax', 'recurring_accounting', 'scope_ladder',
      'setup_conversion', 'software_passthrough', 'filings_1099_w2',
      'entity_services', 'attest', 'specialized_cpa', 'coo', 'deposit'
    );
    CREATE TYPE bundle_rule_type AS ENUM ('bundle_price', 'free_with');

    ------------------------------------------------------------------
    -- Versions: append-only in practice — admin edits create a new one.
    ------------------------------------------------------------------
    CREATE TABLE price_book_versions (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      version_number      integer NOT NULL UNIQUE,
      effective_from      date NOT NULL,
      effective_to        date,              -- NULL = current
      note                text,
      created_by_staff_id uuid REFERENCES staff(id),
      created_at          timestamptz NOT NULL DEFAULT now(),
      CHECK (effective_to IS NULL OR effective_to > effective_from)
    );
    COMMENT ON TABLE price_book_versions IS
      'Effective-dated pricing versions. The version in force on a date = the one whose [effective_from, effective_to) range contains it. Engagements pin the version in force at signing and keep it forever (grandfathering).';

    ------------------------------------------------------------------
    -- Items: one row per priced service per version.
    ------------------------------------------------------------------
    CREATE TABLE price_book_items (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      version_id         uuid NOT NULL REFERENCES price_book_versions(id) ON DELETE CASCADE,
      item_code          text NOT NULL,     -- stable across versions, e.g. 'IND_BASE_MFJ'
      service_line       price_service_line NOT NULL,
      name_en            text NOT NULL,     -- quotes are client-facing → bilingual
      name_es            text NOT NULL,
      description_en     text,
      description_es     text,
      amount_cents       integer,           -- the price (or hourly/per-form rate); NULL when only a range applies
      price_min_cents    integer,           -- range pricing (e.g. CPA letters $250–500)
      price_max_cents    integer,
      unit               price_unit NOT NULL DEFAULT 'flat',
      is_pass_through    boolean NOT NULL DEFAULT false,  -- shown on quotes, not Soto revenue (QBO subscriptions)
      display_on_quote   boolean NOT NULL DEFAULT true,
      needs_confirmation boolean NOT NULL DEFAULT false,  -- the spec's ⚠ items — Brian confirms before launch
      confirmation_note  text,              -- what conflicts across sources and why
      is_active          boolean NOT NULL DEFAULT true,
      sort_order         integer NOT NULL DEFAULT 0,
      metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at         timestamptz NOT NULL DEFAULT now(),
      UNIQUE (version_id, item_code),
      -- Every item is priced somehow: a concrete amount or a range.
      CHECK (amount_cents IS NOT NULL OR (price_min_cents IS NOT NULL AND price_max_cents IS NOT NULL)),
      CHECK (price_min_cents IS NULL OR price_max_cents IS NULL OR price_min_cents <= price_max_cents)
    );
    COMMENT ON COLUMN price_book_items.needs_confirmation IS
      'Seeded true for the Pricing Seed Data ⚠ conflicts. Launch gate (M23): no version may go client-facing while a needs_confirmation item is active-unconfirmed.';

    ------------------------------------------------------------------
    -- Bundle rules (MP v4.2: bundling rules engine)
    ------------------------------------------------------------------
    CREATE TABLE bundle_rules (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      version_id           uuid NOT NULL REFERENCES price_book_versions(id) ON DELETE CASCADE,
      rule_code            text NOT NULL,
      rule_type            bundle_rule_type NOT NULL,
      description_en       text NOT NULL,
      description_es       text,
      component_item_codes text[] NOT NULL,  -- items the rule applies to
      bundle_price_cents   integer,          -- bundle_price: the combined price
      condition_item_code  text,             -- free_with: free when this item is on the engagement
      is_active            boolean NOT NULL DEFAULT true,
      created_at           timestamptz NOT NULL DEFAULT now(),
      UNIQUE (version_id, rule_code),
      CHECK (rule_type <> 'bundle_price' OR bundle_price_cents IS NOT NULL),
      CHECK (rule_type <> 'free_with' OR condition_item_code IS NOT NULL)
    );

    ------------------------------------------------------------------
    -- Engagement price pinning + price lock / grandfathering
    ------------------------------------------------------------------
    ALTER TABLE engagements
      ADD COLUMN price_book_version_id uuid REFERENCES price_book_versions(id),
      ADD COLUMN locked_price_cents    integer,
      ADD COLUMN price_lock_note       text,   -- e.g. 'first-year base hold'
      ADD COLUMN price_lock_expires_on date;
    COMMENT ON COLUMN engagements.price_book_version_id IS
      'The price book version in force at signing. Later versions never reprice this engagement.';
    COMMENT ON COLUMN engagements.locked_price_cents IS
      'MP v4.2 price lock / grandfathering: engagement-level locked price with expiry.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE engagements
      DROP COLUMN IF EXISTS price_lock_expires_on,
      DROP COLUMN IF EXISTS price_lock_note,
      DROP COLUMN IF EXISTS locked_price_cents,
      DROP COLUMN IF EXISTS price_book_version_id;
    DROP TABLE IF EXISTS bundle_rules;
    DROP TABLE IF EXISTS price_book_items;
    DROP TABLE IF EXISTS price_book_versions;
    DROP TYPE  IF EXISTS bundle_rule_type;
    DROP TYPE  IF EXISTS price_service_line;
    DROP TYPE  IF EXISTS price_unit;
  `);
};
