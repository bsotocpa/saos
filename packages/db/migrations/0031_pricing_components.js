/**
 * Brian's pricing ruling, 2026-08-09 — schema side.
 *
 * The two-dial configurator derives a plan price as
 *   prep component × close periods/year + sessions/year × session component
 * so the price book needs two new billing units: per_week (weekly close) and
 * per_session (the CPA session component).
 *
 * The prices themselves live in the seed (packages/db/seeds/data/price_book.mjs),
 * which is v1's definition and re-aligns on every seed run. Nothing here carries
 * an amount.
 *
 * Note on "no client's price changes": the components were calibrated to sum
 * exactly to the package totals already in force ($300/$250/$600/$1,000), so the
 * recalibration is arithmetically invisible to every existing plan. A test
 * asserts the two layers agree to the cent, so drift becomes a build failure
 * rather than something a client spots on an invoice.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TYPE price_unit ADD VALUE IF NOT EXISTS 'per_week';
    ALTER TYPE price_unit ADD VALUE IF NOT EXISTS 'per_session';
  `);
  // display_on_quote already exists (0007). It was previously advisory; the
  // application now REFUSES a flagged item on any quote or invoice line, which
  // is what makes the presentation ruling structural rather than a convention.
  pgm.sql(`
    COMMENT ON COLUMN price_book_items.display_on_quote IS
      'false = derivation-only component. The quote builder and invoice builder REFUSE these codes: a client-facing surface that itemizes a session component separately is a defect (Brian''s pricing ruling 2026-08-09).';
  `);
};

exports.down = () => {
  // Postgres cannot remove a value from an enum without rebuilding the type,
  // and price_book_items rows may reference it. Leaving the two values in place
  // is harmless and honest — the down migration is a no-op by design.
};
