/**
 * M26.5 (v4.6): the tax resolution lane + the bundle builder.
 *
 * RESOLUTION LANE
 *  - Engagements gain the resolution facts: which lane the YEAR forces
 *    (e-file vs paper — derived, never chosen), the paper-lane certified-mail
 *    trail, the refund-statute clock, and the SFR flag read off transcripts.
 *  - resolution_cases group the per-year engagements a single quote spawned,
 *    with the authorization state (8821 at onboarding → 2848 only when
 *    representation begins, with its scope years).
 *  - envelope_type gains f8821 and f2848 so the existing Docuseal + gate
 *    machinery carries them.
 *
 * BUNDLE BUILDER
 *  - A bundle is price_book items + discount rules + optional components.
 *    NOTHING here stores an ad-hoc price: components reference item codes and
 *    the discount is a percent or a fixed amount off the composed total
 *    (CLAUDE.md: bundles compose from the price book only).
 *  - Bundles are versioned with the price book (version_id) and sellable:
 *    each carries a shareable slug for a quote/landing link + campaign
 *    attribution.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TYPE envelope_type ADD VALUE IF NOT EXISTS 'f8821';
    ALTER TYPE envelope_type ADD VALUE IF NOT EXISTS 'f2848';
  `);
  pgm.sql(`
    CREATE TYPE filing_lane AS ENUM ('efile', 'paper');

    CREATE TABLE resolution_cases (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id           uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      business_id          uuid REFERENCES businesses(id),
      lookback_years       integer NOT NULL DEFAULT 6,
      -- Authorization state. 8821 (info only) at onboarding; 2848 (represent)
      -- swaps in per-case when abatement / IA / exam work begins.
      f8821_envelope_id    uuid REFERENCES signature_envelopes(id),
      f8821_signed_at      timestamptz,
      f2848_envelope_id    uuid REFERENCES signature_envelopes(id),
      f2848_signed_at      timestamptz,
      f2848_scope_years    integer[] NOT NULL DEFAULT '{}',
      transcripts_received_at timestamptz,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now()
    );
    CREATE TRIGGER trg_resolution_cases_updated_at BEFORE UPDATE ON resolution_cases
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    COMMENT ON COLUMN resolution_cases.f2848_scope_years IS
      'Years the signed 2848 actually covers. Representation work (abatement, installment agreement, exam) is refused for a year outside this list.';

    ALTER TABLE tax_engagements
      ADD COLUMN resolution_case_id  uuid REFERENCES resolution_cases(id) ON DELETE SET NULL,
      ADD COLUMN filing_lane         filing_lane,
      ADD COLUMN books_exist         text CHECK (books_exist IN ('yes', 'partial', 'no')),
      ADD COLUMN is_reconstruction   boolean NOT NULL DEFAULT false,
      ADD COLUMN refund_statute_expiry date,
      ADD COLUMN sfr_risk            boolean NOT NULL DEFAULT false,
      -- Paper lane trail (certified mail is required, not optional).
      ADD COLUMN paper_mailed_on     date,
      ADD COLUMN certified_tracking  text;
    COMMENT ON COLUMN tax_engagements.filing_lane IS
      'DERIVED from the tax year (current + 2 prior = efile, older = paper). Stored for reporting; the derivation is the authority.';

    -- ── bundles ──────────────────────────────────────────────────────────────
    CREATE TABLE bundles (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      version_id         uuid NOT NULL REFERENCES price_book_versions(id) ON DELETE CASCADE,
      slug               text NOT NULL,
      name_en            text NOT NULL,
      name_es            text NOT NULL,
      description_en     text,
      description_es     text,
      -- Discount off the composed component total: percent OR fixed OR an
      -- explicit override price. All three null = plain sum of components.
      discount_percent   numeric(5,2) CHECK (discount_percent > 0 AND discount_percent < 100),
      discount_cents     integer CHECK (discount_cents > 0),
      override_cents     integer CHECK (override_cents >= 0),
      is_active          boolean NOT NULL DEFAULT true,
      published_at       timestamptz,
      campaign_code      text,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now(),
      UNIQUE (version_id, slug),
      CHECK (num_nonnulls(discount_percent, discount_cents, override_cents) <= 1)
    );
    CREATE TRIGGER trg_bundles_updated_at BEFORE UPDATE ON bundles
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE bundle_components (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      bundle_id    uuid NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
      item_code    text NOT NULL,          -- price_book_items.item_code (composed, never priced here)
      quantity     numeric(8,2) NOT NULL DEFAULT 1,
      is_optional  boolean NOT NULL DEFAULT false,
      sort_order   integer NOT NULL DEFAULT 0,
      note_en      text,
      note_es      text,
      UNIQUE (bundle_id, item_code)
    );
    COMMENT ON TABLE bundle_components IS
      'Bundle contents as PRICE-BOOK REFERENCES. No amount column exists here on purpose — a bundle can never carry an ad-hoc price (CLAUDE.md).';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE bundle_components;
    DROP TABLE bundles;
    ALTER TABLE tax_engagements
      DROP COLUMN resolution_case_id, DROP COLUMN filing_lane, DROP COLUMN books_exist,
      DROP COLUMN is_reconstruction, DROP COLUMN refund_statute_expiry, DROP COLUMN sfr_risk,
      DROP COLUMN paper_mailed_on, DROP COLUMN certified_tracking;
    DROP TABLE resolution_cases;
    DROP TYPE filing_lane;
  `);
};
