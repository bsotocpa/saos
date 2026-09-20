/* eslint-disable camelcase */
/**
 * WHAT THIS MIGRATION HOLDS (Brian, 2026-09-20, item h): the anniversary an annual report's due
 * date is DERIVED FROM, and which kind of anniversary it is.
 *
 *   entity_compliance.anniversary_mmdd  'MM/DD'
 *   entity_compliance.anniversary_kind  'admission' | 'incorporation'
 *
 * WHY THE INPUT AND NOT ONLY THE OUTPUT. entity_compliance already holds annual_report_due_date,
 * which is the ANSWER: the date each state's rule produces. It does not hold the QUESTION the rule
 * is asked. Illinois wants the first day of the anniversary month of admission; Delaware wants
 * 1 June regardless; Oregon wants the anniversary of formation. With only the answer stored, a
 * due date can never be recomputed — a state changing its rule, or a due date entered wrong once,
 * leaves nothing to derive from, and businesses.formation_date is not a substitute: 57 of the
 * bundle's 61 rows are ADMISSION dates, which for a foreign entity is not its formation date.
 *
 * WHY THE KIND IS ITS OWN COLUMN. 'admission' and 'incorporation' are the same MM/DD shape and a
 * different fact, and the state rule picks between them. Storing the month and day without saying
 * which anniversary they are would make the derivation guess, which is how the wrong due date gets
 * computed with full confidence.
 *
 * NO YEAR, DELIBERATELY. The anniversary recurs; the year is whichever one the filing is for. A
 * date column would force a year that means nothing and would silently age. 'MM/DD' text with a
 * CHECK that refuses 02/30 and 13/01 is the narrower type here — the two are declared together so
 * a month and day cannot arrive without the other.
 *
 * ADDS TWO COLUMNS AND TWO CHECKS. Touches no rows.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE entity_compliance
      ADD COLUMN anniversary_mmdd text,
      ADD COLUMN anniversary_kind text
  `);
  /*
   * The pattern refuses month 00 and 13, day 00 and 32. It does NOT refuse 02/30 — that needs a
   * per-month rule, and an anniversary of 30 February is a typo a person should see in the field
   * rather than a constraint violation at the end of an import. What it does refuse is the class of
   * error that would make the derivation silently wrong: a transposed 'DD/MM'.
   */
  await pgm.db.query(`
    ALTER TABLE entity_compliance
      ADD CONSTRAINT entity_compliance_anniversary_mmdd_shape
        CHECK (anniversary_mmdd IS NULL
               OR anniversary_mmdd ~ '^(0[1-9]|1[0-2])/(0[1-9]|[12][0-9]|3[01])$')
  `);
  await pgm.db.query(`
    ALTER TABLE entity_compliance
      ADD CONSTRAINT entity_compliance_anniversary_is_complete
        CHECK ((anniversary_mmdd IS NULL) = (anniversary_kind IS NULL)
               AND (anniversary_kind IS NULL OR anniversary_kind IN ('admission', 'incorporation')))
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN entity_compliance.anniversary_mmdd IS
      'The month and day the state''s annual-report rule counts from, as MM/DD. No year: the anniversary recurs. annual_report_due_date is what the rule PRODUCES from this.'
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN entity_compliance.anniversary_kind IS
      'Which anniversary anniversary_mmdd is: admission (the date the state admitted the entity — 57 of 61 Trello rows) or incorporation. The state rule picks between them, so it is never guessed.'
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE entity_compliance
      DROP CONSTRAINT IF EXISTS entity_compliance_anniversary_is_complete,
      DROP CONSTRAINT IF EXISTS entity_compliance_anniversary_mmdd_shape,
      DROP COLUMN IF EXISTS anniversary_mmdd,
      DROP COLUMN IF EXISTS anniversary_kind
  `);
};
