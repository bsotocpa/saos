/* eslint-disable camelcase */
/**
 * THE §7216 WALL, PHASE 2 (2026-09-12, Brian's ruling 4 and his rulings on Jaqueline's six).
 *
 * Two things, both data. The code that enforces them ships in the same commit (documents/wall.ts,
 * meetings/wall.ts, the pii.read and interviews.read checks in the contact, quote and tax routes).
 *
 *   1. A document category for Laura's work: entity_filings (formation papers, SOS filings, EIN
 *      letters, annual reports). Until now those had nowhere to go but business_records, and a
 *      category wall needs the category to exist. No existing row is recategorised here.
 *
 *   2. The grants, audited. The role seed reconciles (seeds/data/roles.mjs), so this is the one-time,
 *      recorded change, as 0092 was:
 *
 *        ed_coo        + meetings.upload, meetings.read (scoped in code), dashboards.hilo, events.manage,
 *                        documents.read, documents.read.relationship
 *        va_entity     + documents.read.entity
 *        tax_preparer  + documents.read.all, meetings.read.all, interviews.read
 *        bookkeeper    + documents.read.all
 *
 *      documents.read without a scope grant reads nothing; meetings.read without meetings.read.all
 *      reads the reader's own sessions and Hilo sessions; pii.read is checked for the first time.
 *
 * Nothing here touches a client record. It touches an enum and role_permissions only.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // Allowed inside the transaction on PG12+ as long as the value is not used in it (it is not).
  pgm.sql(`ALTER TYPE document_category ADD VALUE IF NOT EXISTS 'entity_filings';`);

  pgm.sql(`
    INSERT INTO role_permissions (role_id, permission)
    SELECT r.id, p.permission FROM roles r
      CROSS JOIN (VALUES ('meetings.upload'), ('meetings.read'), ('dashboards.hilo'), ('events.manage'),
                         ('documents.read'), ('documents.read.relationship')) AS p(permission)
     WHERE r.key = 'ed_coo'
    ON CONFLICT DO NOTHING;
  `);
  pgm.sql(`
    INSERT INTO role_permissions (role_id, permission)
    SELECT id, 'documents.read.entity' FROM roles WHERE key = 'va_entity'
    ON CONFLICT DO NOTHING;
  `);
  pgm.sql(`
    INSERT INTO role_permissions (role_id, permission)
    SELECT r.id, p.permission FROM roles r
      CROSS JOIN (VALUES ('documents.read.all'), ('meetings.read.all'), ('interviews.read')) AS p(permission)
     WHERE r.key = 'tax_preparer'
    ON CONFLICT DO NOTHING;
  `);
  pgm.sql(`
    INSERT INTO role_permissions (role_id, permission)
    SELECT id, 'documents.read.all' FROM roles WHERE key = 'bookkeeper'
    ON CONFLICT DO NOTHING;
  `);
  pgm.sql(`
    INSERT INTO audit_log (actor_type, actor_label, action, object_type, object_id, details)
    VALUES ('system', 'migration 0094', 'permission.change', 'role', 'ed_coo',
            '{"added":["meetings.upload","meetings.read","dashboards.hilo","events.manage","documents.read","documents.read.relationship"],"ruling":"Jaqueline''s six and the §7216 wall, 2026-09-12"}'::jsonb),
           ('system', 'migration 0094', 'permission.change', 'role', 'va_entity',
            '{"added":["documents.read.entity"],"ruling":"the §7216 wall, 2026-09-12"}'::jsonb),
           ('system', 'migration 0094', 'permission.change', 'role', 'tax_preparer',
            '{"added":["documents.read.all","meetings.read.all","interviews.read"],"ruling":"the §7216 wall, 2026-09-12: the preparer is inside it"}'::jsonb),
           ('system', 'migration 0094', 'permission.change', 'role', 'bookkeeper',
            '{"added":["documents.read.all"],"ruling":"the §7216 wall, 2026-09-12: unchanged reach"}'::jsonb);
  `);
};

exports.down = () => {
  /* Enum values cannot be dropped. Grants added on a ruling are not removed by a rollback. */
};
