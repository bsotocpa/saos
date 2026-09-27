/* eslint-disable camelcase */
/**
 * 0128 — A STALE ANSWER IS A FLAG, NOT A CLOCK COMPARISON (2026-09-27, receipt run 20 explained).
 *
 * R67 (0126) decided whether a jurisdiction's answer still counts after a reopen by comparing two
 * wall-clock instants written by different transactions: answered_at > reopened_at. Receipt run 20
 * lost the paper-jurisdiction reopen test to that comparison: the database clock in the Docker VM is
 * stepped back 1 to 2 ms every 30 seconds by the host's time sync (measured 2026-09-27 under load),
 * so a mailing recorded moments after the reopen can carry an earlier instant and read as stale. A
 * production host corrects its clock too; the rule must not depend on the clock running forward.
 *
 *   tax_engagement_jurisdictions.answer_stale   set on every row by the reopen; cleared by the next
 *                                               acceptance or mailing recorded on that row. The
 *                                               instants stay, for the record and for display.
 *
 * Existing rows take the value the old comparison gives them today, once, with the count printed.
 *
 * THE SAME CLOCK, ONE TABLE OVER (receipt run 21): the stage history was read ORDER BY entered_at, and
 * the pipeline march wrote nine rows within a few milliseconds; a backward step put in_preparation
 * before documents_requested. engagement_stage_history.seq records the order the rows were written (a
 * sequence never runs backward); existing rows are numbered in the order entered_at gives them today.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE tax_engagement_jurisdictions
      ADD COLUMN IF NOT EXISTS answer_stale boolean NOT NULL DEFAULT false
  `);
  const { rows } = await pgm.db.query(`
    UPDATE tax_engagement_jurisdictions
       SET answer_stale = true
     WHERE reopened_at IS NOT NULL
       AND (accepted_on IS NOT NULL OR mailed_on IS NOT NULL)
       AND (answered_at IS NULL OR answered_at <= reopened_at)
    RETURNING tax_engagement_id
  `);
  console.log(`0128: ${rows.length} jurisdiction row(s) carry a stale answer from an earlier reopen (from the 0126 comparison, once)`);
  await pgm.db.query(`ALTER TABLE engagement_stage_history ADD COLUMN IF NOT EXISTS seq bigint`);
  await pgm.db.query(`
    UPDATE engagement_stage_history h SET seq = n.rn
      FROM (SELECT id, row_number() OVER (ORDER BY entered_at, id) AS rn FROM engagement_stage_history) n
     WHERE n.id = h.id AND h.seq IS NULL
  `);
  await pgm.db.query(`CREATE SEQUENCE IF NOT EXISTS engagement_stage_history_seq OWNED BY engagement_stage_history.seq`);
  await pgm.db.query(`SELECT setval('engagement_stage_history_seq', GREATEST((SELECT max(seq) FROM engagement_stage_history), 0) + 1, false)`);
  await pgm.db.query(`
    ALTER TABLE engagement_stage_history
      ALTER COLUMN seq SET DEFAULT nextval('engagement_stage_history_seq'),
      ALTER COLUMN seq SET NOT NULL
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN engagement_stage_history.seq IS
      'The order the rows were written (0128). Readers order the history by seq, never by entered_at: the wall clock can step backward.'
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN tax_engagement_jurisdictions.answer_stale IS
      'R67 (0128): true from a reopen until the next acceptance or mailing on this row. A stale answer does not count toward completion. A flag, not a comparison of answered_at and reopened_at: the wall clock can step backward.'
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`ALTER TABLE engagement_stage_history DROP COLUMN IF EXISTS seq`);
  await pgm.db.query(`ALTER TABLE tax_engagement_jurisdictions DROP COLUMN IF EXISTS answer_stale`);
};
