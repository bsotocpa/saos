/**
 * Client-health baseline (decided 2026-08-09): the band is stored, not
 * derived from the raw score alone, because banding is now signal-driven:
 *   gray   — migrated-but-never-engaged (no logins, engagements, doc
 *            requests, or inbound messages): NEUTRAL, not a warning
 *   yellow — an ACTUAL warning signal (overdue docs, failed/overdue
 *            payment, stalled ladder, red deadline clock)
 *   green  — active and clean
 *   red    — severe compound score (< health.red_below)
 * Before this, every migrated contact defaulted to yellow — 426 yellow /
 * 0 green made the Executive tile meaningless.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE contacts ADD COLUMN health_band text
      CHECK (health_band IN ('gray', 'red', 'yellow', 'green'));
    COMMENT ON COLUMN contacts.health_band IS
      'Stored by runHealthRefresh: gray=never engaged (neutral), yellow=active warning signal, green=active+clean, red=severe score.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE contacts DROP COLUMN health_band;`);
};
