/* eslint-disable camelcase */
/**
 * THE PREPARER OF RECORD (2026-09-12, Brian's correction on Ana-Maria).
 *
 * Ana-Maria signs every return with her own PTIN. Brian's never appears. Nothing in SAOS
 * recorded that: `tax_engagements.preparer_id` is the queue assignee — who is working the
 * return — and `ownerForRole('tax_preparer')` fell back to the CEO, so a resolution case could
 * be created with Brian as `preparer_id` and nothing would say who actually signed.
 *
 * `preparer_ptin_holder_id` is the staff row whose PTIN is on the filing. Set at the moment the
 * return moves to `filed`, by the person filing it, and IMMUTABLE after — a trigger refuses any
 * change once it is non-null, because a paid-preparer line on a filed return is a fact about
 * that filing, not a field to tidy.
 *
 * BACKFILL: none, deliberately. Anything already filed has no record of whose PTIN was used and
 * assuming would be inventing a signature. Those rows stay null and every screen labels them
 * "not recorded".
 *
 * The FIRM on every return is Soto Accounting regardless of who signs; this column is the
 * individual, and nothing here touches firm identity.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tax_engagements
      ADD COLUMN IF NOT EXISTS preparer_ptin_holder_id uuid REFERENCES staff(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS preparer_ptin_holder_set_at timestamptz;
    COMMENT ON COLUMN tax_engagements.preparer_ptin_holder_id IS
      'The staff member whose PTIN is on this filing — the paid preparer of record. Set when the return moves to filed; immutable after. NULL on anything filed before 2026-09-12: not recorded, never assumed.';
  `);

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

    DROP TRIGGER IF EXISTS tax_engagements_preparer_of_record ON tax_engagements;
    CREATE TRIGGER tax_engagements_preparer_of_record
      BEFORE UPDATE OF preparer_ptin_holder_id ON tax_engagements
      FOR EACH ROW EXECUTE FUNCTION tax_engagements_preparer_of_record_guard();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS tax_engagements_preparer_of_record ON tax_engagements;
    DROP FUNCTION IF EXISTS tax_engagements_preparer_of_record_guard();
    ALTER TABLE tax_engagements
      DROP COLUMN IF EXISTS preparer_ptin_holder_set_at,
      DROP COLUMN IF EXISTS preparer_ptin_holder_id;
  `);
};
