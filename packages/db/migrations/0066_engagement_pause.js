/*
 * #44 — PAUSING AN ENGAGEMENT (Brian's pause ruling 2026-08-16: "who caused the pause owns
 * the clock").
 *
 * `on_hold` has been in `engagement_status` since 0003 and nothing ever set it — the same
 * dead state `completed` and `withdrawn` were before 0064.
 *
 * ONE PAUSE MECHANISM, NOT TWO (Brian's words). Dunning already pauses work through
 * `work_paused_at`/`work_pause_reason`, so a staff hold reuses those columns rather than
 * inventing a parallel set. What the columns could NOT say is WHO paused, and that turns
 * out to be load-bearing in two places:
 *
 *   1. THE CLOCK. A staff pause is our delay and is refunded to the client — `waiting_since`
 *      moves forward by the pause, and the price lock extends by the same. A dunning pause
 *      is theirs and is refunded to nobody. Same columns, opposite consequences, so the
 *      resume path has to know which one it is looking at.
 *
 *   2. A BUG THIS PREVENTS. `resumeAfterPayment` lifts any pause it finds
 *      (`WHERE work_paused_at IS NOT NULL`). Without a source, a client paying an overdue
 *      invoice would silently resume work that a staff member had deliberately held —
 *      an automatic action quietly reversing a human decision.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE engagements
      ADD COLUMN IF NOT EXISTS work_pause_source      text,
      ADD COLUMN IF NOT EXISTS work_paused_by_staff_id uuid REFERENCES staff(id);

    COMMENT ON COLUMN engagements.work_pause_source IS
      'Who caused this pause: staff (deliberate hold — the clock stops and the price lock extends) or dunning (non-payment — the clock keeps running). Determines what resume does, and stops payment from lifting a staff hold.';
  `);

  // Every pause that exists today came from the dunning job — it was the only writer.
  pgm.sql(`
    UPDATE engagements
       SET work_pause_source = 'dunning'
     WHERE work_paused_at IS NOT NULL AND work_pause_source IS NULL;
  `);

  /*
   * Three constraints, because each one is a rule that would otherwise be a promise:
   *
   *  · a pause has a source, and a source implies a pause (no half-set state)
   *  · a source is one of the two things it can be
   *  · `on_hold` IS the pause — a status saying paused while the pause columns are empty is
   *    exactly the "two mechanisms" Brian ruled against, and it would read as paused
   *    everywhere while behaving as running everywhere else.
   */
  pgm.sql(`
    ALTER TABLE engagements
      ADD CONSTRAINT engagements_pause_has_source CHECK (
        (work_paused_at IS NULL) = (work_pause_source IS NULL)
      ),
      ADD CONSTRAINT engagements_pause_source_known CHECK (
        work_pause_source IS NULL OR work_pause_source IN ('staff', 'dunning')
      ),
      ADD CONSTRAINT engagements_on_hold_is_paused CHECK (
        status <> 'on_hold' OR work_paused_at IS NOT NULL
      );
  `);

  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_engagements_paused
      ON engagements (work_pause_source) WHERE work_paused_at IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_engagements_paused;
    ALTER TABLE engagements
      DROP CONSTRAINT IF EXISTS engagements_pause_has_source,
      DROP CONSTRAINT IF EXISTS engagements_pause_source_known,
      DROP CONSTRAINT IF EXISTS engagements_on_hold_is_paused,
      DROP COLUMN IF EXISTS work_pause_source,
      DROP COLUMN IF EXISTS work_paused_by_staff_id;
  `);
};
