/* eslint-disable camelcase */
/**
 * WHICH FORM THE EXTENSION WENT IN ON (Brian, 2026-09-20).
 *
 * The return recorded THAT an extension was filed and the deadline it bought, and never which
 * form carried it. 4868 and 7004 are different filings with different signatures and different
 * penalty consequences, and "extended" alone cannot answer "what did we actually send?" when a
 * client calls about a notice. The form is now recorded with the filing.
 *
 * TWO VALUES ONLY, checked in the database: '4868' for an individual return, '7004' for an
 * entity return. Neither is derived from the row at read time — the person filing says which
 * one went in, defaulted from the return type, and the column keeps the answer. The extended
 * deadline stays derived from the return type and the fiscal year end by the deadline engine;
 * nothing here types a date.
 *
 * TOUCHES ROWS. Every return already marked extension_filed is given the form its return type
 * implies (1040 and expat 1040 → 4868, everything else → 7004), which is the form that actually
 * went in for each of them, and each row is printed below by return id, year and return type —
 * no client names, no PII. The invariant then holds for every future filing: a return that says
 * it is extended says on which form.
 */
exports.shorthands = undefined;

/** The individual returns; every other return type extends on 7004. */
const FORM_4868_RETURN_TYPES = ['1040', '1040_expat'];

exports.up = async (pgm) => {
  // DDL and row work both through pgm.db.query(), in order: pgm.sql() is queued until this
  // function returns, and the backfill below must see the column.
  await pgm.db.query(`
    ALTER TABLE tax_engagements
      ADD COLUMN IF NOT EXISTS extension_form text
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN tax_engagements.extension_form IS
      $$'4868' (individual) or '7004' (entity): the form the extension was filed on, recorded with the filing. The extended deadline stays derived from the return type + fiscal year end.$$
  `);

  const { rows } = await pgm.db.query(
    `SELECT id, tax_year, return_type::text AS return_type
       FROM tax_engagements
      WHERE extension_filed AND extension_form IS NULL
      ORDER BY tax_year, id`
  );
  console.log(`0112: recording the extension form on ${rows.length} extended return(s):`);
  for (const r of rows) {
    const form = FORM_4868_RETURN_TYPES.includes(r.return_type) ? '4868' : '7004';
    console.log(`0112:   ${r.id}  ·  ${r.tax_year} ${r.return_type.toUpperCase()}  ·  form ${form}`);
  }
  if (rows.length > 0) {
    await pgm.db.query(
      `UPDATE tax_engagements
          SET extension_form = CASE WHEN return_type::text = ANY($1) THEN '4868' ELSE '7004' END
        WHERE extension_filed AND extension_form IS NULL`,
      [FORM_4868_RETURN_TYPES]
    );
    await pgm.db.query(
      `INSERT INTO audit_log (actor_type, actor_label, action, object_type, object_id, details)
       SELECT 'system', 'migration 0112', 'tax_engagement.extension_form_recorded', 'tax_engagement', te.id,
              jsonb_build_object(
                'reason', 'the return said it was extended and not on which form; the form each return type extends on was recorded',
                'extension_form', te.extension_form)
         FROM tax_engagements te
        WHERE te.id = ANY($1)`,
      [rows.map((r) => r.id)]
    );
  }

  // The invariant, once every row has an answer: an extended return says which form, and the
  // column never holds anything but the two real forms.
  await pgm.db.query(`
    ALTER TABLE tax_engagements
      ADD CONSTRAINT tax_engagements_extension_form_values
        CHECK (extension_form IS NULL OR extension_form IN ('4868', '7004'))
  `);
  await pgm.db.query(`
    ALTER TABLE tax_engagements
      ADD CONSTRAINT tax_engagements_extension_filed_has_form
        CHECK (NOT extension_filed OR extension_form IS NOT NULL)
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE tax_engagements
      DROP CONSTRAINT IF EXISTS tax_engagements_extension_filed_has_form,
      DROP CONSTRAINT IF EXISTS tax_engagements_extension_form_values,
      DROP COLUMN IF EXISTS extension_form;
  `);
};
