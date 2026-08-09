/**
 * Client-acting automation kill switches (Brian's directive, 2026-08-09):
 * every automation that TOUCHES A CLIENT — escalation ladders, AR dunning,
 * extension notices, late fees, document chase, estimate reminders — carries
 * its own on/off toggle in Admin and ships DISABLED. Brian arms them
 * deliberately as real clients reach the portal; nothing fires at 300
 * migrated clients on invite day.
 *
 * enabled DEFAULTS FALSE and the seed never overwrites an existing row, so a
 * new automation is off until someone turns it on — fail-quiet by design.
 * Internal alerts/tasks are NOT gated (the notification-vs-task principle):
 * staff keep seeing the work; only the client-facing send is suppressed.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE automations (
      key                 text PRIMARY KEY,
      name                text NOT NULL,
      description         text NOT NULL,
      audience            text NOT NULL DEFAULT 'client' CHECK (audience IN ('client', 'internal')),
      enabled             boolean NOT NULL DEFAULT false,
      updated_by_staff_id uuid REFERENCES staff(id),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
    CREATE TRIGGER trg_automations_updated_at BEFORE UPDATE ON automations
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    COMMENT ON TABLE automations IS
      'Per-automation kill switches. Client-acting automations ship enabled=false; Brian arms them in Admin as clients come onto the portal.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE automations;`);
};
