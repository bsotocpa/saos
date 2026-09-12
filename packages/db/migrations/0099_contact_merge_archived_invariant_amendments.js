/* eslint-disable camelcase */
/**
 * CONTACT MERGE, THE ARCHIVED INVARIANT, REASON AMENDMENTS (2026-09-12, Brian: "Don't archive. Merge.")
 *
 *   1. contacts.merged_into_contact_id: a loser points at its winner and holds nothing else.
 *   2. An archived contact holds no active or on_hold engagement, at the database: a trigger on
 *      engagements (no active work may land on an archived contact) and one on contacts (a
 *      contact with active work cannot be archived). The merge respects it by reparenting first.
 *      Existing violations are not rewritten here; they are reported and merged by hand.
 *   3. businesses.status: active or dissolved. GORDEETAH LLC is Brian's and dissolved; the record
 *      had no way to say so (il_sos_status is the Secretary of State's observation, not ours).
 *   4. reason_amendments: a permanent reason field is never edited; a second, audited line is
 *      appended. Generic by (object_type, object_id, field); the waiver reason is the first user.
 *
 * Touches no client row's content.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE contacts ADD COLUMN merged_into_contact_id uuid REFERENCES contacts(id);`);
  pgm.sql(`CREATE INDEX idx_contacts_merged_into ON contacts (merged_into_contact_id) WHERE merged_into_contact_id IS NOT NULL;`);

  pgm.sql(`CREATE TYPE business_status AS ENUM ('active', 'dissolved');`);
  pgm.sql(`ALTER TABLE businesses ADD COLUMN status business_status NOT NULL DEFAULT 'active';`);

  pgm.sql(`
    CREATE TABLE reason_amendments (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      object_type text NOT NULL,
      object_id   uuid NOT NULL,
      field       text NOT NULL,
      body        text NOT NULL,
      staff_id    uuid NOT NULL REFERENCES staff(id),
      created_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_reason_amendments_object ON reason_amendments (object_type, object_id, created_at);
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION engagements_not_on_archived_contact() RETURNS trigger AS $$
    DECLARE archived boolean;
    BEGIN
      IF NEW.status IN ('active', 'on_hold') THEN
        SELECT (c.is_archived OR c.contact_status = 'archived') INTO archived FROM contacts c WHERE c.id = NEW.contact_id;
        IF archived THEN
          RAISE EXCEPTION 'archived_contact_active_engagement: an archived contact cannot hold an active or on-hold engagement (contact %, engagement %); merge or unarchive first', NEW.contact_id, NEW.id
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`
    DROP TRIGGER IF EXISTS engagements_not_on_archived_contact ON engagements;
    CREATE TRIGGER engagements_not_on_archived_contact
      BEFORE INSERT OR UPDATE OF status, contact_id ON engagements
      FOR EACH ROW EXECUTE FUNCTION engagements_not_on_archived_contact();
  `);
  pgm.sql(`
    CREATE OR REPLACE FUNCTION contacts_archived_hold_no_active_work() RETURNS trigger AS $$
    DECLARE n integer;
    BEGIN
      IF (NEW.is_archived OR NEW.contact_status = 'archived') AND NOT (OLD.is_archived OR OLD.contact_status = 'archived') THEN
        SELECT count(*) INTO n FROM engagements e WHERE e.contact_id = NEW.id AND e.status IN ('active', 'on_hold');
        IF n > 0 THEN
          RAISE EXCEPTION 'archived_contact_active_engagement: this contact holds % active or on-hold engagement(s); withdraw, complete or merge them before archiving (contact %)', n, NEW.id
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`
    DROP TRIGGER IF EXISTS contacts_archived_hold_no_active_work ON contacts;
    CREATE TRIGGER contacts_archived_hold_no_active_work
      BEFORE UPDATE OF is_archived, contact_status ON contacts
      FOR EACH ROW EXECUTE FUNCTION contacts_archived_hold_no_active_work();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TRIGGER IF EXISTS contacts_archived_hold_no_active_work ON contacts; DROP FUNCTION IF EXISTS contacts_archived_hold_no_active_work();`);
  pgm.sql(`DROP TRIGGER IF EXISTS engagements_not_on_archived_contact ON engagements; DROP FUNCTION IF EXISTS engagements_not_on_archived_contact();`);
  pgm.sql(`DROP TABLE IF EXISTS reason_amendments;`);
  pgm.sql(`ALTER TABLE businesses DROP COLUMN IF EXISTS status; DROP TYPE IF EXISTS business_status;`);
  pgm.sql(`ALTER TABLE contacts DROP COLUMN IF EXISTS merged_into_contact_id;`);
};
