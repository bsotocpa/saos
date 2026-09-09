/**
 * 0083 — one active engagement per (contact, service line, period) (2026-09-09, Brian's ruling).
 *
 * #48 guards one QUOTE from being accepted twice. Nothing guarded one SERVICE LINE from being
 * agreed twice through two different quotes: Rehearsal Client 2 ended a rehearsal with three
 * active tax engagements. Migration 0061 cleaned this up once, by rule, after the fact. This
 * one makes the rule impossible to break rather than easy to clean.
 *
 *   engagements.period_key   the period the engagement covers — the tax year for tax lines,
 *                            'ongoing' for recurring lines, NULL for per-matter lines and for
 *                            every engagement created before this ruling.
 *   partial unique index     at most one active/on_hold engagement per (contact, line,
 *                            period). Partial on period_key IS NOT NULL: legacy rows are
 *                            REPORTED, never guessed — Brian's ruling, and the only way to be
 *                            certain no migration reaches a real client's record.
 *   superseded_by            set on the engagement a change order replaced.
 *   quotes.change_order_of   the engagement a quote replaces; required to send a quote for a
 *                            line the client already has active work on.
 *
 * NO BACKFILL. Existing rows keep period_key NULL. See legacyEngagementsWithoutPeriod().
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE engagements
      ADD COLUMN IF NOT EXISTS period_key text,
      ADD COLUMN IF NOT EXISTS superseded_by_engagement_id uuid REFERENCES engagements(id) ON DELETE SET NULL;
    ALTER TABLE quotes
      ADD COLUMN IF NOT EXISTS change_order_of_engagement_id uuid REFERENCES engagements(id) ON DELETE SET NULL;
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS engagements_one_active_per_line_period
      ON engagements (contact_id, service_line, period_key)
      WHERE status IN ('active', 'on_hold') AND period_key IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS engagements_one_active_per_line_period;`);
  pgm.sql(`ALTER TABLE quotes DROP COLUMN IF EXISTS change_order_of_engagement_id;`);
  pgm.sql(`
    ALTER TABLE engagements
      DROP COLUMN IF EXISTS superseded_by_engagement_id,
      DROP COLUMN IF EXISTS period_key;
  `);
};
