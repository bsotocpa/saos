/*
 * CLOSING AN ENGAGEMENT (#44, Brian's rulings 2026-08-16).
 *
 * `engagement_status` already had `completed` and `withdrawn`; nothing ever set either.
 * This adds what a closure has to carry, and the one rule that must not be a promise.
 *
 * NO `declined` STATE. It was floated and ruled out: `declined` describes a QUOTE, and
 * `quotes.status` already holds it with `decline_reason`. An engagement only exists
 * because a quote was accepted, so it cannot be declined — the case it might describe is
 * `withdrawn` with a reason. The test for whether a state earns its place is whether its
 * distinction fits in one sentence, and this one did not.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE engagements
      ADD COLUMN IF NOT EXISTS close_reason text;

    COMMENT ON COLUMN engagements.close_reason IS
      'Why this engagement ended. REQUIRED when withdrawn, optional when completed — delivered work explains itself, work that stopped without delivering does not, and the missing "why" is what someone needs a year later.';
  `);

  /*
   * REQUIRED ON WITHDRAWN, enforced rather than promised — the same argument accepted for
   * contacts.archived_reason. Deviates from the original "reason optional" ruling, and
   * Brian confirmed the deviation.
   *
   * NOT VALID first: migration 0061 withdrew three duplicate engagements before this
   * column existed, so they carry no reason. They are backfilled below rather than
   * blocking the constraint — their reason is genuinely known.
   */
  pgm.sql(`
    UPDATE engagements
       SET close_reason = 'Duplicate acceptance — superseded by the first engagement for this service line (migration 0061).'
     WHERE status = 'withdrawn' AND close_reason IS NULL;

    ALTER TABLE engagements
      ADD CONSTRAINT engagements_withdrawn_has_reason CHECK (
        status <> 'withdrawn' OR close_reason IS NOT NULL
      ) NOT VALID;
  `);
  pgm.sql(`ALTER TABLE engagements VALIDATE CONSTRAINT engagements_withdrawn_has_reason;`);

  /*
   * A terminal engagement has an end date. Both terminal states mean the work stopped on
   * some day, and "closed, date unknown" is the kind of gap that turns into an argument
   * about when billing should have stopped.
   */
  pgm.sql(`
    UPDATE engagements SET ended_on = COALESCE(ended_on, CURRENT_DATE)
     WHERE status IN ('completed', 'withdrawn') AND ended_on IS NULL;

    ALTER TABLE engagements
      ADD CONSTRAINT engagements_terminal_has_end_date CHECK (
        status NOT IN ('completed', 'withdrawn') OR ended_on IS NOT NULL
      ) NOT VALID;
  `);
  pgm.sql(`ALTER TABLE engagements VALIDATE CONSTRAINT engagements_terminal_has_end_date;`);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE engagements
      DROP CONSTRAINT IF EXISTS engagements_withdrawn_has_reason,
      DROP CONSTRAINT IF EXISTS engagements_terminal_has_end_date,
      DROP COLUMN IF EXISTS close_reason;
  `);
};
