/* eslint-disable camelcase */
/**
 * 0130 — THE CONFIGURATOR HISTORY AND THE EVENT WAITLIST READ IN WRITE ORDER (Brian, 2026-09-27, R77).
 *
 * The same clock as 0128: the database clock in the Docker VM steps back 1 to 2 ms every 30 seconds,
 * and a production host corrects its clock too. Two orders were still read from it:
 *
 *   engagement_config_history.seq   the order the configurator wrote its history rows
 *                                   (configHistory reads by it)
 *   event_registrations.seq         the order people registered: the waitlist position a registrant is
 *                                   told, and who gets a freed seat, read by it
 *
 * Existing rows are numbered in the order created_at (then id) gives them today; new rows take the
 * next value of a sequence, which never runs backward.
 */
exports.shorthands = undefined;

const TABLES = ['engagement_config_history', 'event_registrations'];

exports.up = async (pgm) => {
  for (const t of TABLES) {
    await pgm.db.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS seq bigint`);
    await pgm.db.query(`
      UPDATE ${t} x SET seq = n.rn
        FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM ${t}) n
       WHERE n.id = x.id AND x.seq IS NULL
    `);
    await pgm.db.query(`CREATE SEQUENCE IF NOT EXISTS ${t}_seq OWNED BY ${t}.seq`);
    await pgm.db.query(`SELECT setval('${t}_seq', GREATEST((SELECT max(seq) FROM ${t}), 0) + 1, false)`);
    await pgm.db.query(`ALTER TABLE ${t} ALTER COLUMN seq SET DEFAULT nextval('${t}_seq'), ALTER COLUMN seq SET NOT NULL`);
    await pgm.db.query(`
      COMMENT ON COLUMN ${t}.seq IS
        'The order the rows were written (0130, R77). Readers order by seq, never by created_at: the wall clock can step backward.'
    `);
  }
};

exports.down = async (pgm) => {
  for (const t of TABLES) await pgm.db.query(`ALTER TABLE ${t} DROP COLUMN IF EXISTS seq`);
};
