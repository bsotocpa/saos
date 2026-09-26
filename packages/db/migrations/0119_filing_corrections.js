/* eslint-disable camelcase */
/**
 * THE FILING IS CORRECTED, NEVER EDITED (Brian, 2026-09-26).
 *
 * A return at filed carries three facts about the filing: the day it was filed, whose PTIN is on
 * it, and the jurisdictions it declared. Each was written once, at Mark filed, and each can be
 * wrong — a date typed a day late, the wrong preparer picked from a list, a state declared that the
 * return never went to. Until now the PTIN holder could not be changed at all (0089's guard) and
 * the other two could only be changed by hand in the database, which leaves no record of what was
 * there before or why it moved.
 *
 * WHAT THIS HOLDS.
 *
 *   tax_engagement_filing_corrections — one row per correction, APPEND-ONLY (the same trigger
 *   function audit_log uses): which fields moved, what they said before and after (dates, staff
 *   ids and jurisdiction codes — never a name, never anything about the client), the standalone
 *   reason the person wrote, who they were and when. The return's own columns are then updated to
 *   the corrected values, so every reader keeps reading the return; the corrections are the
 *   history under it.
 *
 *   THE GUARD ON THE PREPARER OF RECORD ADMITS ONE DOOR. 0089 refuses any change to a non-null
 *   preparer_ptin_holder_id, and that stays the rule for every writer but one: the correction
 *   route sets a transaction-local marker (saos.filing_correction = the correction row's id) right
 *   before its UPDATE, and the guard lets that transaction through. Nothing else can set it
 *   without also having written the correction row in the same transaction, which is the point.
 *
 *   filed_date IS the filed day (a DATE column since 0003). "Filed on" writes it as the calendar
 *   day the person said, in Chicago; before today it was CURRENT_DATE on the server. Any return
 *   at or past filed that somehow carries no filed_date is given the Chicago day its stage history
 *   says it reached 'filed' — printed below by return id, year and type, no names.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS tax_engagement_filing_corrections (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tax_engagement_id  uuid NOT NULL REFERENCES tax_engagements(id) ON DELETE CASCADE,
      fields             text[] NOT NULL CHECK (cardinality(fields) > 0),
      before             jsonb NOT NULL DEFAULT '{}'::jsonb,
      after              jsonb NOT NULL DEFAULT '{}'::jsonb,
      reason             text NOT NULL CHECK (length(btrim(reason)) >= 10),
      actor_staff_id     uuid REFERENCES staff(id),
      actor_label        text NOT NULL,
      created_at         timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_tax_engagement_filing_corrections_return
      ON tax_engagement_filing_corrections (tax_engagement_id, created_at)
  `);
  await pgm.db.query(`
    COMMENT ON TABLE tax_engagement_filing_corrections IS
      'Append-only corrections to a filed return''s filed_date, preparer_ptin_holder_id and declared jurisdictions: the fields that moved, before/after as JSON (dates, staff ids, jurisdiction codes — no PII), the standalone reason, the actor. The return''s columns carry the corrected values; these rows are the history.'
  `);
  await pgm.db.query(`
    DROP TRIGGER IF EXISTS trg_tax_engagement_filing_corrections_append_only ON tax_engagement_filing_corrections;
    CREATE TRIGGER trg_tax_engagement_filing_corrections_append_only
      BEFORE UPDATE OR DELETE ON tax_engagement_filing_corrections
      FOR EACH ROW EXECUTE FUNCTION forbid_row_change()
  `);

  // The preparer-of-record guard, with the one door: a transaction that has set saos.filing_correction.
  await pgm.db.query(`
    CREATE OR REPLACE FUNCTION tax_engagements_preparer_of_record_guard() RETURNS trigger AS $$
    BEGIN
      IF OLD.preparer_ptin_holder_id IS NOT NULL
         AND NEW.preparer_ptin_holder_id IS DISTINCT FROM OLD.preparer_ptin_holder_id
         AND COALESCE(current_setting('saos.filing_correction', true), '') = '' THEN
        RAISE EXCEPTION 'preparer_of_record_immutable: the paid preparer of record on a filed return changes only through a recorded filing correction (tax_engagement %)', OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.preparer_ptin_holder_id IS NOT NULL AND OLD.preparer_ptin_holder_id IS NULL THEN
        NEW.preparer_ptin_holder_set_at := now();
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `);

  // Backfill: a return at or past filed with no filed day takes the Chicago day it reached 'filed'.
  const { rows } = await pgm.db.query(`
    SELECT te.id, te.tax_year, te.return_type::text AS return_type, te.stage::text AS stage,
           (min(h.entered_at) AT TIME ZONE 'America/Chicago')::date::text AS filed_on
      FROM tax_engagements te
      JOIN engagement_stage_history h ON h.tax_engagement_id = te.id AND h.stage = 'filed'
     WHERE te.filed_date IS NULL AND te.stage IN ('filed', 'rejected', 'completed')
     GROUP BY te.id, te.tax_year, te.return_type, te.stage
     ORDER BY te.tax_year, te.id
  `);
  console.log(`0119: giving a filed day to ${rows.length} filed return(s) that had none (from the day they reached filed):`);
  for (const r of rows) console.log(`0119:   ${r.id}  ·  ${r.tax_year} ${r.return_type.toUpperCase()}  ·  ${r.stage}  ·  filed_date → ${r.filed_on}`);
  if (rows.length === 0) { console.log('0119:   (none — every filed return already carries its filed day)'); return; }
  await pgm.db.query(
    `UPDATE tax_engagements te SET filed_date = x.filed_on::date
       FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, filed_on text)
      WHERE te.id = x.id`,
    [JSON.stringify(rows.map((r) => ({ id: r.id, filed_on: r.filed_on })))]
  );
  await pgm.db.query(
    `INSERT INTO audit_log (actor_type, actor_label, action, object_type, object_id, details)
     SELECT 'system', 'migration 0119', 'tax_engagement.filed_date_backfilled', 'tax_engagement', x.id,
            jsonb_build_object('reason', 'a filed return carried no filed day; the day it reached filed in its stage history was written', 'filed_date', x.filed_on)
       FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, filed_on text)`,
    [JSON.stringify(rows.map((r) => ({ id: r.id, filed_on: r.filed_on })))]
  );
};

exports.down = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION tax_engagements_preparer_of_record_guard() RETURNS trigger AS $$
    BEGIN
      IF OLD.preparer_ptin_holder_id IS NOT NULL
         AND NEW.preparer_ptin_holder_id IS DISTINCT FROM OLD.preparer_ptin_holder_id THEN
        RAISE EXCEPTION 'preparer_of_record_immutable: the paid preparer of record on a filed return cannot be changed (tax_engagement %)', OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.preparer_ptin_holder_id IS NOT NULL AND OLD.preparer_ptin_holder_id IS NULL THEN
        NEW.preparer_ptin_holder_set_at := now();
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    DROP TABLE IF EXISTS tax_engagement_filing_corrections;
  `);
};
