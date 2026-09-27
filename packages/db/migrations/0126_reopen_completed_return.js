/* eslint-disable camelcase */
/**
 * REOPEN A COMPLETED RETURN (Brian, 2026-09-26, R67).
 *
 * A return at completed had no door out (pipeline.ts: completed → []). When the acceptance that
 * completed it turns out to be wrong — the wrong return matched, an amended filing, a state that
 * later bounced — the record could not be put right. The CEO alone may reopen it, with a standalone
 * reason: the return goes back to FILED, the engagement that holds it returns to active, and the
 * executive counts read it as open again.
 *
 * WHAT MAKES A REOPENED RETURN DIFFERENT FROM A FILED ONE: its jurisdictions have already answered
 * once, and that answer is what is in doubt. So completion after a reopen requires a NEW acceptance
 * or mailing — one recorded AFTER the reopen — on every jurisdiction. Two instants make that rule
 * checkable:
 *
 *   tax_engagements.reopened_at / reopen_reason      when and why (both or neither).
 *   tax_engagement_jurisdictions.answered_at         when the row's acceptance or mailing was
 *                                                    RECORDED (accepted_on / mailed_on are the days
 *                                                    the agency or the mail said; this is the instant
 *                                                    SAOS wrote it). Backfilled for existing rows
 *                                                    from the day recorded, at midnight Chicago, so
 *                                                    a row answered before any reopen reads as such.
 *   tax_engagement_jurisdictions.reopened_at         the instant the return was reopened while this
 *                                                    row stood; an answer is fresh only when
 *                                                    answered_at > reopened_at.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE tax_engagements
      ADD COLUMN IF NOT EXISTS reopened_at timestamptz,
      ADD COLUMN IF NOT EXISTS reopen_reason text
  `);
  await pgm.db.query(`
    ALTER TABLE tax_engagements
      DROP CONSTRAINT IF EXISTS tax_engagements_reopen_whole,
      ADD CONSTRAINT tax_engagements_reopen_whole CHECK ((reopened_at IS NULL) = (reopen_reason IS NULL))
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN tax_engagements.reopened_at IS
      'R67: the last time the CEO reopened this completed return (back to filed). Completion then needs an acceptance or mailing recorded after this instant on every jurisdiction.'
  `);
  await pgm.db.query(`
    ALTER TABLE tax_engagement_jurisdictions
      ADD COLUMN IF NOT EXISTS answered_at timestamptz,
      ADD COLUMN IF NOT EXISTS reopened_at timestamptz
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN tax_engagement_jurisdictions.answered_at IS
      'R67: the instant the acceptance or the mailing on this row was recorded in SAOS. Fresh after a reopen only when later than reopened_at.'
  `);
  // Existing answers were recorded before any reopen existed: the day recorded, at midnight Chicago.
  const { rowCount } = await pgm.db.query(`
    UPDATE tax_engagement_jurisdictions
       SET answered_at = (COALESCE(accepted_on, mailed_on)::timestamp AT TIME ZONE 'America/Chicago')
     WHERE answered_at IS NULL AND (accepted_on IS NOT NULL OR mailed_on IS NOT NULL)
  `);
  console.log(`0126: answered_at backfilled on ${rowCount} jurisdiction row(s) from the day their acceptance or mailing was recorded`);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE tax_engagement_jurisdictions
      DROP COLUMN IF EXISTS reopened_at,
      DROP COLUMN IF EXISTS answered_at
  `);
  await pgm.db.query(`
    ALTER TABLE tax_engagements
      DROP CONSTRAINT IF EXISTS tax_engagements_reopen_whole,
      DROP COLUMN IF EXISTS reopen_reason,
      DROP COLUMN IF EXISTS reopened_at
  `);
};
