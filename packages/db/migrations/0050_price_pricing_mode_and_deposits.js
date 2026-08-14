/**
 * Price book v4 — deposits separated from service pricing (Brian, 2026-08-14).
 *
 * "The current sheet conflates deposits with service pricing, which is why the 13
 * confirmations have stalled."
 *
 * He is describing a real modelling error, not a display problem. Today a deposit is
 * its OWN price-book item (DEPOSIT_1040 $250, DEPOSIT_BUSINESS_TAX $300, service_line
 * 'deposit'), sitting in the same table and the same columns as real services, and a
 * quote picks exactly one of them via quotes.deposit_item_code. So a deposit looks like
 * something you can sell, a multi-line quote cannot compose a deposit at all, and
 * confirming a price means deciding two unrelated things at once.
 *
 * Two columns fix it:
 *
 *   pricing_mode   — how the price is EXPRESSED (flat amount / min–max range / hourly)
 *   deposit_cents  — what this line asks for up front, nullable, most lines none
 *
 * pricing_mode is deliberately a DIFFERENT axis from the existing `unit`. `unit` is what
 * the amount is per (per_hour, per_month, per_form, per_state, per_k1 …). Mode is how the
 * number is shaped. Today the shape is only inferable by looking at which column happens
 * to be populated — `minUnit = amount_cents ?? price_min_cents ?? 0` — which means intent
 * is never recorded anywhere, only guessed at read time.
 *
 * THE CHECKS ARE THE POINT. A mode that is merely a label drifts from the data it
 * describes within a release or two. These make each mode mean exactly one shape, the
 * same reason the schedule and consent rules are constraints rather than service-layer
 * promises.
 *
 * `hourly` is created as an enum VALUE but nothing constructs it yet. Brian corrected
 * his own premise on 2026-08-14 — "'we don't bill hourly today' was wrong, those three
 * rate-card lines are real" — so the three per_hour lines migrate to flat + per_hour
 * (behaviour preserved exactly) and go to his confirmation queue. If he confirms them as
 * hourly, the mode gets built then, against those three lines.
 *
 * deposit_cents, not deposit_amount: every money column here is integer cents with a
 * _cents suffix. A bare `amount` would be the only one whose unit you have to guess.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE price_pricing_mode AS ENUM ('flat', 'range', 'hourly');

    ALTER TABLE price_book_items
      ADD COLUMN pricing_mode  price_pricing_mode NOT NULL DEFAULT 'flat',
      ADD COLUMN deposit_cents integer,
      ADD COLUMN structure_needs_confirmation boolean NOT NULL DEFAULT false,
      ADD COLUMN structure_confirmation_note  text;

    COMMENT ON COLUMN price_book_items.structure_needs_confirmation IS
      'A v4 STRUCTURE question — should this line carry a deposit, is it really hourly — as opposed to needs_confirmation, which means the PRICE itself is unsettled. Kept separate because they gate different things: an unconfirmed price makes a quote provisional, while an unsettled deposit assignment does not. Overloading the price flag marked every 1040 quote as having an unconfirmed price when its $200 was never in doubt. Both appear in the same admin queue.';

    COMMENT ON COLUMN price_book_items.pricing_mode IS
      'How the price is EXPRESSED: flat = amount_cents; range = price_min_cents..price_max_cents; hourly = a tracked-time rate. Distinct from the unit column, which is what the amount is per. Before v4 the shape was only inferable from which column was populated.';
    COMMENT ON COLUMN price_book_items.deposit_cents IS
      'What this line asks for up front. NULL on most lines. A quote''s deposit is the SUM of its lines'' deposits and does NOT multiply with quantity (Brian 2026-08-14: "one line = one work-start commitment regardless of units"). Replaces the modelling of deposits as sellable price-book items.';

    -- Backfill intent from the shape the data already has. Unambiguous against v3:
    -- no row carries both an amount and a range.
    UPDATE price_book_items
       SET pricing_mode = 'range'
     WHERE amount_cents IS NULL
       AND price_min_cents IS NOT NULL
       AND price_max_cents IS NOT NULL;
  `);

  // Each mode admits exactly one shape. Written as one constraint rather than three so
  // the failure message names the mode that was violated.
  pgm.sql(`
    ALTER TABLE price_book_items
      ADD CONSTRAINT price_book_items_mode_shape CHECK (
        (pricing_mode = 'flat'
           AND amount_cents IS NOT NULL
           AND price_min_cents IS NULL
           AND price_max_cents IS NULL)
        OR
        (pricing_mode = 'range'
           AND amount_cents IS NULL
           AND price_min_cents IS NOT NULL
           AND price_max_cents IS NOT NULL)
        OR
        (pricing_mode = 'hourly'
           AND amount_cents IS NOT NULL
           AND price_min_cents IS NULL
           AND price_max_cents IS NULL
           AND unit = 'per_hour')
      );

    ALTER TABLE price_book_items
      ADD CONSTRAINT price_book_items_deposit_non_negative CHECK (
        deposit_cents IS NULL OR deposit_cents >= 0
      );
  `);

  /*
   * The original check allowed "an amount OR a range" without saying which one this row
   * is. price_book_items_mode_shape is strictly stronger and now carries that meaning,
   * so keeping the old one leaves two constraints answering the same question — and the
   * weaker one would go on passing rows the new model considers malformed.
   */
  pgm.sql(`ALTER TABLE price_book_items DROP CONSTRAINT IF EXISTS price_book_items_check;`);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE price_book_items
      DROP CONSTRAINT IF EXISTS price_book_items_mode_shape,
      DROP CONSTRAINT IF EXISTS price_book_items_deposit_non_negative;

    ALTER TABLE price_book_items
      ADD CONSTRAINT price_book_items_check CHECK (
        amount_cents IS NOT NULL OR (price_min_cents IS NOT NULL AND price_max_cents IS NOT NULL)
      );

    ALTER TABLE price_book_items
      DROP COLUMN pricing_mode,
      DROP COLUMN deposit_cents,
      DROP COLUMN structure_needs_confirmation,
      DROP COLUMN structure_confirmation_note;

    DROP TYPE price_pricing_mode;
  `);
};
