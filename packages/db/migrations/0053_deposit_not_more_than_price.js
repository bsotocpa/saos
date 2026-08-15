/**
 * A deposit may equal the price. It may never EXCEED it.
 *
 * Found while answering "is quoting client #1 unblocked on pricing grounds?" — price
 * book v4, in force 2026-08-15, asked a $250 deposit on individual base returns priced
 * $150–$200. A single filer quoted that day would have been asked to prepay $250 for a
 * $150 engagement and be owed $100 back before any work started.
 *
 * That is mine: scripts/price-book-v4.mjs carried DEPOSIT_1040's $250 onto the base
 * return lines without ever asking whether a deposit could be larger than the thing it
 * is a deposit for. Brian's pricing sitting fixed it in v5 by repricing those lines to
 * $200 and setting their deposits to $200 — deliberate full prepay, which he confirmed
 * as intentional. Full prepay is the LIMIT, not a violation, so the constraint is
 * `<=` rather than `<`.
 *
 * SCOPED TO unit = 'flat', which is the only case where the comparison means anything.
 * ACCT_CATCHUP_HOURLY is $75 PER HOUR with a $200 work-start deposit: the deposit
 * exceeds the unit price and is entirely sensible, because a cleanup engagement is many
 * hours. Comparing a deposit against a per-hour, per-state or per-K-1 rate would flag
 * correct pricing as broken — the number it needs to be under is a total, and a
 * per-unit line has no total until it is quoted.
 *
 * NOT VALID: v4 is still in force today and violates this. Nothing pins v4 (0 quotes, 0
 * engagements) and it expires tonight, but rewriting a version that is live is the thing
 * this codebase refuses to do. New and updated rows are checked from now on, which is
 * what stops it recurring; VALIDATE once v4 is behind us.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE price_book_items
      ADD CONSTRAINT price_book_items_deposit_not_over_price CHECK (
        deposit_cents IS NULL
        OR unit <> 'flat'
        OR amount_cents IS NULL
        OR deposit_cents <= amount_cents
      ) NOT VALID;

    COMMENT ON CONSTRAINT price_book_items_deposit_not_over_price ON price_book_items IS
      'A deposit may equal the price (full prepay on small engagements — Brian confirmed that as intentional) but never exceed it. Only meaningful on unit = flat: a per-hour or per-state line has no total until it is quoted, so its deposit is legitimately larger than its unit price.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE price_book_items DROP CONSTRAINT IF EXISTS price_book_items_deposit_not_over_price;`);
};
