/* eslint-disable camelcase */
/**
 * BUSINESS PARITY WITH CONTACTS (2026-09-12 evening, Brian's ruling 3).
 *
 * A business is archived, never deleted, with a reason; flagged test residue with a note saying
 * what the test was; merged into a winner (merged_into_business_id) the way a contact is. And
 * exactly one primary business per contact, refused on the way in.
 *
 * Touches no row. The trigger refuses a SECOND primary from now on; it does not rewrite the past.
 * The import set every membership primary, so 74 contacts on production hold two or more today
 * (listed by name in the evening report; Jackson Flores and Joseph Basilone among them, which is
 * why this is not a unique index and not a data migration). Brian rules on that cleanup.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE businesses
      ADD COLUMN is_test boolean NOT NULL DEFAULT false,
      ADD COLUMN test_note text,
      ADD COLUMN is_archived boolean NOT NULL DEFAULT false,
      ADD COLUMN archived_at timestamptz,
      ADD COLUMN archived_reason text,
      ADD COLUMN merged_into_business_id uuid REFERENCES businesses(id),
      ADD CONSTRAINT businesses_archived_has_reason CHECK (NOT is_archived OR archived_reason IS NOT NULL),
      ADD CONSTRAINT businesses_test_has_note CHECK (NOT is_test OR test_note IS NOT NULL);
  `);
  pgm.sql(`
    CREATE OR REPLACE FUNCTION business_members_one_primary() RETURNS trigger AS $$
    DECLARE n integer;
    BEGIN
      IF NEW.is_primary THEN
        SELECT count(*) INTO n FROM business_members m
         WHERE m.contact_id = NEW.contact_id AND m.is_primary AND m.business_id <> NEW.business_id;
        IF n > 0 THEN
          RAISE EXCEPTION 'one_primary_business: contact % already has a primary business; clear it first', NEW.contact_id
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`
    DROP TRIGGER IF EXISTS business_members_one_primary ON business_members;
    CREATE TRIGGER business_members_one_primary
      BEFORE INSERT OR UPDATE OF is_primary ON business_members
      FOR EACH ROW EXECUTE FUNCTION business_members_one_primary();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TRIGGER IF EXISTS business_members_one_primary ON business_members; DROP FUNCTION IF EXISTS business_members_one_primary();`);
  pgm.sql(`ALTER TABLE businesses DROP COLUMN IF EXISTS merged_into_business_id, DROP COLUMN IF EXISTS archived_reason, DROP COLUMN IF EXISTS archived_at, DROP COLUMN IF EXISTS is_archived, DROP COLUMN IF EXISTS test_note, DROP COLUMN IF EXISTS is_test;`);
};
