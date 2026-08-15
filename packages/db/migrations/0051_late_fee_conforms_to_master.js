/**
 * FINDING #25 — the price book contradicted the engagement letter (Brian, 2026-08-14).
 *
 * LATE_FEE_MONTHLY was seeded as a flat $25/month line. Master §3 discloses "a late
 * charge of one and one-half percent (1.5%) per month (18% per annum), applied to the
 * outstanding balance after all deposits and credits". On any past-due balance under
 * $1,667 a flat $25 exceeds 1.5%, so the book authorised a charge larger than the one
 * every signed client agreed to.
 *
 * Brian's ruling: "the book conforms to the Master. Change the line to computed 1.5% of
 * past-due balance per month, and add a guard: the late-fee automation must never charge
 * more than the Master-disclosed rate for the client's signed version."
 *
 * Nothing was ever overcharged — the dunning job reads metadata.monthly_rate_percent
 * (1.5) and ignores amount_cents, `late_fees` has never been armed, and
 * invoice_late_fees is empty. But that is luck, not design: the visible, admin-editable
 * number was wrong and the number that actually charged was buried in a metadata blob
 * the pricing UI does not show. Editing the price in Admin → Pricing would have changed
 * nothing; "fixing" the code to honour the visible price would have overcharged.
 *
 * THREE THINGS THIS ADDS.
 *
 * 1. price_pricing_mode gains 'percent' + price_book_items.percent_rate.
 *    A percentage-of-balance is a genuine fourth price shape, which is exactly the axis
 *    pricing_mode was created for. Now the rate is a first-class, visible, editable
 *    price-book value rather than a key inside a JSON blob — the CLAUDE.md rule is that
 *    the rate lives in the price book, and a metadata key is only technically that.
 *
 * 2. templates.late_fee_rate_percent — the Master DECLARES the rate it discloses, so the
 *    disclosed rate is machine-readable and stays admin-editable (copy changes must
 *    never need a deploy). CHECK: a rate exists iff the template carries the disclosure,
 *    so the two can never drift into "discloses a late fee, at no stated rate".
 *
 * 3. contacts.late_fee_disclosed_rate_percent — STAMPED AT SIGNING, alongside the
 *    existing late_fee_disclosure_signed_at.
 *
 *    Stamping is what makes "for the client's signed version" true. Templates are
 *    versioned by mutation — one row, a version counter — so the text a client signed in
 *    March is not recoverable from the template table in June. Freezing the rate at the
 *    moment of agreement means a later edit to the Master cannot retroactively raise
 *    what an existing client can be charged, and the guard needs no version archaeology:
 *    it compares two numbers.
 *
 *    Same principle as engagements pinning a price-book version at signing.
 */

exports.up = (pgm) => {
  pgm.sql(`ALTER TYPE price_pricing_mode ADD VALUE IF NOT EXISTS 'percent';`);

  pgm.sql(`
    ALTER TABLE price_book_items
      ADD COLUMN percent_rate numeric(6,3);

    COMMENT ON COLUMN price_book_items.percent_rate IS
      'The rate for a percent-mode line, as a percent per its unit (1.5 = 1.5%/month for LATE_FEE_MONTHLY). A first-class price-book value, not a metadata key: this is the number that charges.';

    ALTER TABLE price_book_items
      ADD CONSTRAINT price_book_items_percent_rate_sane CHECK (
        percent_rate IS NULL OR (percent_rate > 0 AND percent_rate <= 100)
      );

    -- ── The Master declares the rate it discloses ───────────────────────────
    ALTER TABLE templates
      ADD COLUMN late_fee_rate_percent numeric(6,3);

    COMMENT ON COLUMN templates.late_fee_rate_percent IS
      'The monthly late-fee rate this template DISCLOSES in its own text (Master §3 = 1.5). Machine-readable so the assessment can be capped at what the client actually agreed to. Admin-editable: changing disclosed copy must never require a deploy.';

    /*
     * A template a client can actually sign, which discloses a late fee, must state the
     * rate it discloses.
     *
     * Scoped to non-placeholders on purpose. engagement_letter_tax is a placeholder whose
     * body carries a {{late_fee_rate}} VARIABLE — it has no fixed rate to declare, and
     * forcing it to invent one would put a number in a document nobody may send. It also
     * cannot be signed: the placeholder gate blocks it.
     *
     * Better still, this makes clearing is_placeholder the moment the rate is required.
     * You cannot promote a late-fee-disclosing template to live without stating its rate,
     * which is precisely when the number starts to matter.
     *
     * NOT VALID because production already holds a live Master with the flag and no rate
     * yet; scripts/late-fee-conform.mjs sets it and then VALIDATEs.
     */
    ALTER TABLE templates
      ADD CONSTRAINT templates_late_fee_rate_matches_disclosure CHECK (
        NOT has_late_fee_disclosure
        OR is_placeholder
        OR late_fee_rate_percent IS NOT NULL
      ) NOT VALID;

    -- ── What THIS client agreed to, frozen at signature ─────────────────────
    ALTER TABLE contacts
      ADD COLUMN late_fee_disclosed_rate_percent numeric(6,3);

    COMMENT ON COLUMN contacts.late_fee_disclosed_rate_percent IS
      'The late-fee rate disclosed by the engagement letter THIS client signed, copied at signing. Frozen deliberately: templates are versioned by mutation, so the text signed in March is not recoverable in June, and a later edit to the Master must never raise what an already-signed client can be charged. NULL with a signed disclosure means the rate is unprovable, and the job charges nothing.';

    -- ── The trail shows the cap, not just the result ────────────────────────
    ALTER TABLE invoice_late_fees
      ADD COLUMN book_rate_percent      numeric(6,3),
      ADD COLUMN disclosed_rate_percent numeric(6,3);

    COMMENT ON COLUMN invoice_late_fees.disclosed_rate_percent IS
      'The rate this client''s signed letter disclosed. rate_percent is the rate actually charged = min(book, disclosed). Recording all three makes a capped assessment visible as a capped assessment rather than looking like the book was simply lower that month.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE invoice_late_fees
      DROP COLUMN book_rate_percent,
      DROP COLUMN disclosed_rate_percent;
    ALTER TABLE contacts DROP COLUMN late_fee_disclosed_rate_percent;
    ALTER TABLE templates
      DROP CONSTRAINT IF EXISTS templates_late_fee_rate_matches_disclosure,
      DROP COLUMN late_fee_rate_percent;
    ALTER TABLE price_book_items
      DROP CONSTRAINT IF EXISTS price_book_items_percent_rate_sane,
      DROP COLUMN percent_rate;
    -- The enum value stays: PostgreSQL cannot drop one, and nothing depends on it.
  `);
};
