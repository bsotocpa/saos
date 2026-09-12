/* eslint-disable camelcase */
/**
 * THE CEO FLOOR (2026-09-12, Brian's defect 3 on Admin → Staff).
 *
 * Brian: "Deactivate is offered on the last ceo row. The DB refuses it under the floor; the control
 * should not be there either." The DB did not refuse it: no such floor existed, in the database or
 * in the API. Deactivating the only active CEO, or moving them to another role, would have left
 * the firm with nobody holding '*', nobody able to approve, and owner routing falling back to
 * nobody. This trigger is the floor. The API turns its refusal into a 409 (server.ts), and the
 * page does not offer the control on that row.
 *
 * Touches no client record.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION staff_keep_one_active_ceo() RETURNS trigger AS $$
    DECLARE
      ceo_role uuid;
      others integer;
    BEGIN
      SELECT id INTO ceo_role FROM roles WHERE key = 'ceo';
      -- Only a row that WAS an active CEO and is about to stop being one can breach the floor.
      IF OLD.role_id = ceo_role AND OLD.is_active
         AND (NOT NEW.is_active OR NEW.role_id <> ceo_role) THEN
        SELECT count(*) INTO others FROM staff
         WHERE role_id = ceo_role AND is_active AND id <> OLD.id;
        IF others = 0 THEN
          RAISE EXCEPTION 'last_active_ceo: the firm must keep at least one active CEO account; make another account CEO first (staff %)', OLD.id
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`
    DROP TRIGGER IF EXISTS staff_keep_one_active_ceo ON staff;
    CREATE TRIGGER staff_keep_one_active_ceo
      BEFORE UPDATE OF is_active, role_id ON staff
      FOR EACH ROW EXECUTE FUNCTION staff_keep_one_active_ceo();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TRIGGER IF EXISTS staff_keep_one_active_ceo ON staff; DROP FUNCTION IF EXISTS staff_keep_one_active_ceo();`);
};
