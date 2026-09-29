/* eslint-disable camelcase */
/**
 * 0134 — ONE ENGAGEMENT, ONE RETURN PER YEAR (Brian, 2026-09-29, R89 answer A).
 *
 * A quote may carry the same return for several years (the current year and three back, say). It
 * is accepted as ONE engagement holding one return per year, each with its own stage, 8879,
 * jurisdictions and document checklist. So:
 *
 *   · tax_engagements is keyed by (engagement_id, tax_year); engagement_id alone is no longer
 *     unique. Every row today has one return per engagement, so the new key holds over them.
 *   · quote_line_items.tax_year: the year a return line (and its schedules, and its prior-year
 *     surcharge) is for. NULL on a line that is not a return line, and on every line written
 *     before this migration, which reads the quote's one year as it always has.
 *   · engagement_scope_items.tax_year: the same year, copied by value at acceptance like every
 *     other column of the snapshot. NULL on scope written before, which is the engagement's one
 *     return's year.
 *
 * Touches no row. The resolution lane's one-engagement-per-year shape is unchanged.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`ALTER TABLE quote_line_items ADD COLUMN IF NOT EXISTS tax_year integer`);
  await pgm.db.query(`ALTER TABLE quote_line_items ADD CONSTRAINT quote_line_items_tax_year_sane CHECK (tax_year IS NULL OR tax_year BETWEEN 1990 AND 2199)`);
  await pgm.db.query(`ALTER TABLE engagement_scope_items ADD COLUMN IF NOT EXISTS tax_year integer`);
  await pgm.db.query(`ALTER TABLE engagement_scope_items ADD CONSTRAINT engagement_scope_items_tax_year_sane CHECK (tax_year IS NULL OR tax_year BETWEEN 1990 AND 2199)`);
  await pgm.db.query(`ALTER TABLE tax_engagements DROP CONSTRAINT IF EXISTS tax_engagements_engagement_id_key`);
  await pgm.db.query(`ALTER TABLE tax_engagements ADD CONSTRAINT tax_engagements_engagement_year_key UNIQUE (engagement_id, tax_year)`);
  // The old key under any other name would still refuse the second year: none may remain.
  const left = await pgm.db.query(`
    SELECT c.conname FROM pg_constraint c
     WHERE c.conrelid = 'tax_engagements'::regclass AND c.contype = 'u'
       AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'tax_engagements'::regclass AND attname = 'engagement_id')]::smallint[]`);
  if (left.rows.length > 0) throw new Error(`0134: engagement_id is still unique alone (${left.rows.map((r) => r.conname).join(', ')})`);
  await pgm.db.query(`
    COMMENT ON COLUMN quote_line_items.tax_year IS
      'R89: the year this return line is for (its schedules and prior-year surcharge carry the same year). NULL: not a return line, or written before 0134 (the quote''s one year).'
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`ALTER TABLE tax_engagements DROP CONSTRAINT IF EXISTS tax_engagements_engagement_year_key`);
  await pgm.db.query(`ALTER TABLE tax_engagements ADD CONSTRAINT tax_engagements_engagement_id_key UNIQUE (engagement_id)`);
  await pgm.db.query(`ALTER TABLE engagement_scope_items DROP CONSTRAINT IF EXISTS engagement_scope_items_tax_year_sane`);
  await pgm.db.query(`ALTER TABLE engagement_scope_items DROP COLUMN IF EXISTS tax_year`);
  await pgm.db.query(`ALTER TABLE quote_line_items DROP CONSTRAINT IF EXISTS quote_line_items_tax_year_sane`);
  await pgm.db.query(`ALTER TABLE quote_line_items DROP COLUMN IF EXISTS tax_year`);
};
