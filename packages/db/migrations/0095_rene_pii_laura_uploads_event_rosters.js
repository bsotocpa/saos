/* eslint-disable camelcase */
/**
 * THREE RULINGS ON THE WALL (2026-09-12, Brian, after the phase 2 report).
 *
 *   1. Rene (comms_billing) holds pii.read: she collects SSNs by phone and verifies callers.
 *      Inside the firm; the wall is for outside it.
 *   2. Event check-in rosters move behind events.read (code: events/routes.ts). ed_coo holds it;
 *      intern does not.
 *   3. Laura's uploads are limited to the categories she may read (code: documents/routes.ts).
 *      No grant changes for that one: "you may upload only what you may read" needs no new key.
 *
 * The role seed reconciles; this is the audited, one-time change, as 0092 and 0094 were.
 * Nothing here touches a client record.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO role_permissions (role_id, permission)
    SELECT id, 'pii.read' FROM roles WHERE key = 'comms_billing'
    ON CONFLICT DO NOTHING;
  `);
  pgm.sql(`
    INSERT INTO role_permissions (role_id, permission)
    SELECT id, 'events.read' FROM roles WHERE key = 'ed_coo'
    ON CONFLICT DO NOTHING;
  `);
  pgm.sql(`
    INSERT INTO audit_log (actor_type, actor_label, action, object_type, object_id, details)
    VALUES ('system', 'migration 0095', 'permission.change', 'role', 'comms_billing',
            '{"added":["pii.read"],"ruling":"2026-09-12: Rene collects SSNs by phone and verifies callers; inside the firm"}'::jsonb),
           ('system', 'migration 0095', 'permission.change', 'role', 'ed_coo',
            '{"added":["events.read"],"ruling":"2026-09-12: event check-in rosters behind events.read"}'::jsonb);
  `);
};

exports.down = () => {
  /* Grants added on a ruling are not removed by a rollback. */
};
