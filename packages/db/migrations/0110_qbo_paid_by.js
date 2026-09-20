/* eslint-disable camelcase */
/**
 * WHAT THIS MIGRATION HOLDS (Brian, 2026-09-20, item h): who pays for a client's QuickBooks Online
 * subscription.
 *
 *   qbo_payer enum                    'client' | 'soto' | 'unknown'
 *   businesses.qbo_paid_by            qbo_payer NOT NULL DEFAULT 'unknown'
 *   businesses.qbo_paid_by_as_of      date
 *
 * 'unknown' IS A MEMBER OF THE ENUM, not NULL, and that is the point of the migration. Whether a
 * subscription is on the firm's card or the client's is a billing fact that changes what we invoice;
 * a nullable two-value column makes "nobody has looked" indistinguishable from "not applicable",
 * and a report grouping by it silently drops the rows that most need asking about. An explicit
 * 'unknown' shows up in the group-by as work to do.
 *
 * THE COLUMN SHIPS EMPTY, DELIBERATELY (Brian, 2026-09-20): "Do not import the 2022 QBO paid-by
 * values (the column exists for later; leave unknown)." The bundle has 74 of them and its own
 * README calls them a 2022 roster hint. Four years is long enough for a card to have changed hands
 * twice, and a four-year-old billing fact written into a live column reads as current — the same
 * error the as-of column exists to prevent. So the importer writes nothing here, every row stays
 * 'unknown', and the column waits for someone to look. The as-of column is what makes a later
 * answer trustworthy.
 *
 * WHY NOT price_book_items.is_pass_through. That is the closest existing idea and it is the wrong
 * one: is_pass_through is a property of a PRICE — this line is billed at cost — while qbo_paid_by
 * is a property of a CLIENT. One client can be on a pass-through price with the firm holding the
 * card, and the price book has no room to say so.
 *
 * ADDS ONE ENUM AND TWO COLUMNS. Touches no rows (every existing business defaults to 'unknown').
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`CREATE TYPE qbo_payer AS ENUM ('client', 'soto', 'unknown')`);
  await pgm.db.query(`
    ALTER TABLE businesses
      ADD COLUMN qbo_paid_by       qbo_payer NOT NULL DEFAULT 'unknown',
      ADD COLUMN qbo_paid_by_as_of date
  `);
  /*
   * A real answer has to say when it was true; 'unknown' must not carry a date, or a row reads as
   * "we checked on this day and could not tell" when nobody checked at all.
   */
  await pgm.db.query(`
    ALTER TABLE businesses
      ADD CONSTRAINT businesses_qbo_paid_by_as_of_matches
        CHECK ((qbo_paid_by = 'unknown') = (qbo_paid_by_as_of IS NULL))
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN businesses.qbo_paid_by IS
      'Who pays this business''s QBO subscription. ''unknown'' is the default and means nobody has looked — it is a member rather than NULL so a group-by shows the work. The 2026-09-20 Trello import writes nothing here: its values are from a 2022 pass (Brian''s instruction).'
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN businesses.qbo_paid_by_as_of IS
      'The day qbo_paid_by was verified. Required for a real answer, refused for ''unknown''.'
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE businesses
      DROP CONSTRAINT IF EXISTS businesses_qbo_paid_by_as_of_matches,
      DROP COLUMN IF EXISTS qbo_paid_by,
      DROP COLUMN IF EXISTS qbo_paid_by_as_of
  `);
  await pgm.db.query(`DROP TYPE IF EXISTS qbo_payer`);
};
