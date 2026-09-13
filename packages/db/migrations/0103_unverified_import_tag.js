/* eslint-disable camelcase */
/**
 * SELF-NAMED BUSINESSES: TAG, DO NOT ARCHIVE (2026-09-12 night, Brian's ruling 2).
 *
 * A business whose name is the contact's own name, with no EIN and no entity type, is an import
 * artifact or a sole proprietorship, and the record cannot say which. It is tagged "unverified
 * import" with the source it came from; nothing is archived, nothing is guessed. The client page
 * and every business picker show the tag and the entity type, so a person quoting business work
 * sees what they are pointing at.
 *
 * TOUCHES ROWS, and may reach protected names (Joseph Basilone holds "JOSEPH BASILONE and MELISSA
 * BASILONE" and "Transnorthern Trading Company", both without EIN or entity type). Every row is
 * printed by contact, business and source from the database this is about to change, before the
 * UPDATE, and the same list went to Brian in the report.
 */
const { isSelfNamed } = require('../lib/self-named.js');

exports.shorthands = undefined;

exports.up = async (pgm) => {
  // pgm.sql() is queued until this function returns; the UPDATE below runs now. So the column is
  // added now too, through the same connection, or the UPDATE finds no column (the first deploy did).
  await pgm.db.query(`ALTER TABLE businesses ADD COLUMN unverified_import_source record_source`);
  await pgm.db.query(`COMMENT ON COLUMN businesses.unverified_import_source IS
    'Set when the business is named after its contact with no EIN and no entity type: an import artifact or a sole prop, unverified. The value is where the row came from. NULL = not tagged.'`);

  const { rows } = await pgm.db.query(`
    SELECT DISTINCT ON (b.id) b.id AS business_id, b.name AS business, b.source::text AS source,
           c.id AS contact_id, c.first_name, c.last_name
      FROM businesses b
      JOIN business_members m ON m.business_id = b.id
      JOIN contacts c ON c.id = m.contact_id
     WHERE NOT b.is_archived AND b.ein IS NULL AND b.entity_type IS NULL
     ORDER BY b.id, m.is_primary DESC, c.created_at`);
  const tagged = rows
    .filter((r) => isSelfNamed(r.business, r.first_name, r.last_name))
    .map((r) => ({ business_id: r.business_id, business: r.business, source: r.source, contact_id: r.contact_id, contact: `${r.first_name} ${r.last_name}` }))
    .sort((a, b) => a.contact.localeCompare(b.contact) || a.business.localeCompare(b.business));
  console.log(`0103: tagging ${tagged.length} business(es) "unverified import" (named after the contact, no EIN, no entity type):`);
  for (const r of tagged) console.log(`0103:   ${r.contact}  ·  ${r.business}  ·  ${r.source}`);
  if (tagged.length === 0) return;
  await pgm.db.query(
    `UPDATE businesses b SET unverified_import_source = b.source WHERE b.id = ANY($1::uuid[])`,
    [tagged.map((r) => r.business_id)]
  );
  await pgm.db.query(
    `INSERT INTO audit_log (actor_type, actor_label, action, object_type, object_id, contact_id, details)
     SELECT 'system', 'migration 0103 (ruled by Brian, 2026-09-12)', 'business.tagged_unverified_import', 'business', x.business_id, x.contact_id,
            jsonb_build_object('reason', 'named after the contact with no EIN and no entity type: an import artifact or a sole prop, unverified', 'contact', x.contact, 'business', x.business, 'source', x.source)
       FROM jsonb_to_recordset($1::jsonb) AS x(contact text, business text, source text, contact_id uuid, business_id uuid)`,
    [JSON.stringify(tagged)]
  );
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE businesses DROP COLUMN IF EXISTS unverified_import_source;`);
};
