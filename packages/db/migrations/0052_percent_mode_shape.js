/**
 * Teach price_book_items_mode_shape about 'percent' (finding #25, part 2 of 2).
 *
 * SEPARATE MIGRATION ON PURPOSE. PostgreSQL will not let a newly added enum value be
 * USED in the same transaction that adds it, and node-pg-migrate wraps each migration in
 * one. 0051 adds the value; this one references it. Folding them together fails at
 * deploy time with "unsafe use of new value of enum type", which is the kind of thing
 * that only shows up on the server.
 *
 * The mode still admits exactly one shape each — that is the whole point of the
 * constraint, and 'percent' gets the same treatment:
 *
 *   percent → percent_rate NOT NULL, and no amount and no range,
 *             because a rate and a fixed price are alternatives, never both.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE price_book_items DROP CONSTRAINT IF EXISTS price_book_items_mode_shape;

    ALTER TABLE price_book_items
      ADD CONSTRAINT price_book_items_mode_shape CHECK (
        (pricing_mode = 'flat'
           AND amount_cents IS NOT NULL
           AND price_min_cents IS NULL
           AND price_max_cents IS NULL
           AND percent_rate IS NULL)
        OR
        (pricing_mode = 'range'
           AND amount_cents IS NULL
           AND price_min_cents IS NOT NULL
           AND price_max_cents IS NOT NULL
           AND percent_rate IS NULL)
        OR
        (pricing_mode = 'hourly'
           AND amount_cents IS NOT NULL
           AND price_min_cents IS NULL
           AND price_max_cents IS NULL
           AND percent_rate IS NULL
           AND unit = 'per_hour')
        OR
        (pricing_mode = 'percent'
           AND percent_rate IS NOT NULL
           AND amount_cents IS NULL
           AND price_min_cents IS NULL
           AND price_max_cents IS NULL)
      );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE price_book_items DROP CONSTRAINT IF EXISTS price_book_items_mode_shape;

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
  `);
};
