/* eslint-disable camelcase */
/**
 * ONE ACTIVE TAX ENGAGEMENT PER CLIENT, LINE, PERIOD — AND ENTITY (2026-09-12, the first 1120S).
 *
 * 0083 held one active engagement per (contact, service line, period). For tax that meant one
 * return per client per year, which is right for a person and wrong the moment the person owns
 * an S corporation: the owner's 1040 and the entity's 1120S are two returns for the same year on
 * the same contact, and the second was refused. Brian's own firm is exactly this case.
 *
 * The entity joins the key. Personal work (no business) still collides with itself; the entity's
 * return sits beside it. The index keeps its name, so the code that names the violation
 * (engagements/period.ts) is unchanged.
 *
 * Touches no row; the index is rebuilt over the same data.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS engagements_one_active_per_line_period;`);
  pgm.sql(`
    CREATE UNIQUE INDEX engagements_one_active_per_line_period
      ON engagements (contact_id, service_line, period_key, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::uuid))
      WHERE status IN ('active', 'on_hold') AND period_key IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS engagements_one_active_per_line_period;`);
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS engagements_one_active_per_line_period
      ON engagements (contact_id, service_line, period_key)
      WHERE status IN ('active', 'on_hold') AND period_key IS NOT NULL;
  `);
};
