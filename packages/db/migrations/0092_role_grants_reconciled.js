/* eslint-disable camelcase */
/**
 * ROLE GRANTS RECONCILED (2026-09-12, Brian's rulings 2, 3 and 6 on staff accounts).
 *
 * The role seed only ever INSERTED grants (ON CONFLICT DO NOTHING), so removing a permission
 * from the seed changed nothing on a database that already had it. That is how `ed_coo` would
 * have kept `*` forever. The seed reconciles now (seeds/data/roles.mjs); this migration is the
 * audited, one-time change on the box for the three rulings, so the record says when and why.
 *
 *   ruling 3  ed_coo loses `*`. Named grants only: contacts.read, engagements.read,
 *             tasks.read, tasks.manage. documents.read comes with the category filter in
 *             phase 2, not before.
 *   ruling 2  comms_billing gains bookkeeping.assigned.manage — Rene's bookkeeping scope,
 *             granted directly rather than through a second role.
 *   ruling 6  sales_tax.manage and payroll.manage are deleted from every role. Nothing checks
 *             them; a grant that nothing checks is a claim, not a permission.
 *
 * Nothing here touches a client record. It touches role_permissions only.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    DELETE FROM role_permissions
     WHERE role_id = (SELECT id FROM roles WHERE key = 'ed_coo') AND permission = '*';

    INSERT INTO role_permissions (role_id, permission)
    SELECT r.id, p.permission
      FROM roles r
      CROSS JOIN (VALUES ('contacts.read'), ('engagements.read'), ('tasks.read'), ('tasks.manage'), ('referrals.suggest')) AS p(permission)
     WHERE r.key = 'ed_coo'
    ON CONFLICT DO NOTHING;

    INSERT INTO role_permissions (role_id, permission)
    SELECT id, 'bookkeeping.assigned.manage' FROM roles WHERE key = 'comms_billing'
    ON CONFLICT DO NOTHING;

    DELETE FROM role_permissions WHERE permission IN ('sales_tax.manage', 'payroll.manage');

    INSERT INTO audit_log (actor_type, actor_label, action, object_type, object_id, details)
    VALUES ('system', 'migration 0092', 'permission.change', 'role', 'ed_coo',
            '{"removed":["*"],"added":["contacts.read","engagements.read","tasks.read","tasks.manage","referrals.suggest"],"ruling":"staff accounts, 2026-09-12"}'::jsonb),
           ('system', 'migration 0092', 'permission.change', 'role', 'comms_billing',
            '{"added":["bookkeeping.assigned.manage"],"removed":["sales_tax.manage","payroll.manage"]}'::jsonb);
  `);
};

exports.down = () => {
  /* Grants removed on a ruling are not restored by a rollback. Re-grant deliberately, by name. */
};
