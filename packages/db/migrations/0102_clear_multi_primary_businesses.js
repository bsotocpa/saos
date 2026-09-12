/* eslint-disable camelcase */
/**
 * CLEAR THE PRIMARY FLAG ON EVERY MULTI-PRIMARY CONTACT (2026-09-12 late, Brian's ruling 1).
 *
 * The import set every membership primary, so 74 contacts held two or more. No guessing which
 * one is right and no tasks: every primary flag on those contacts is cleared, the client page
 * says "No primary business set." with the control, and the primary is set by whoever works the
 * client next, with the client in front of them (the quote builder sets it when a business is
 * chosen and none exists).
 *
 * TOUCHES ROWS, including protected names (Jackson Flores, Joseph Basilone). The affected rows
 * were listed by contact and business in the report before this ran, and this migration prints
 * the same list, from the database it is about to change, before the UPDATE. Contacts with
 * exactly one primary are untouched.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  const { rows } = await pgm.db.query(`
    SELECT c.first_name || ' ' || c.last_name AS contact, b.name AS business, m.contact_id, m.business_id
      FROM business_members m
      JOIN contacts c ON c.id = m.contact_id
      JOIN businesses b ON b.id = m.business_id
     WHERE m.is_primary
       AND m.contact_id IN (SELECT contact_id FROM business_members WHERE is_primary GROUP BY contact_id HAVING count(*) > 1)
     ORDER BY 1, 2`);
  const contacts = new Set(rows.map((r) => r.contact_id));
  console.log(`0102: clearing the primary flag on ${rows.length} membership row(s) across ${contacts.size} contact(s):`);
  for (const r of rows) console.log(`0102:   ${r.contact}  ·  ${r.business}`);
  if (rows.length === 0) return;
  await pgm.db.query(
    `UPDATE business_members SET is_primary = false
      WHERE is_primary AND contact_id = ANY($1::uuid[])`,
    [[...contacts]]
  );
  await pgm.db.query(
    `INSERT INTO audit_log (actor_type, actor_label, action, object_type, object_id, contact_id, details)
     SELECT 'system', 'migration 0102 (ruled by Brian, 2026-09-12)', 'business.primary_cleared', 'business', x.business_id, x.contact_id,
            jsonb_build_object('reason', 'every primary cleared on a contact that held several; a person chooses next', 'contact', x.contact, 'business', x.business)
       FROM jsonb_to_recordset($1::jsonb) AS x(contact text, business text, contact_id uuid, business_id uuid)`,
    [JSON.stringify(rows)]
  );
};

exports.down = () => {
  // The flags cannot be restored from here: which business was really primary was never known.
};
