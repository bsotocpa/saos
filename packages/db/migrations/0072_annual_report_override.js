/*
 * ANNUAL-REPORT DUE DATE: recording WHY a stored date overrides the derived one
 * (Brian's ruling 2026-08-17).
 *
 * The ruling: when the stored due date disagrees with the state rule, Laura stops, verifies
 * against the state's own record, and brings Brian both dates. She never picks between them —
 * an admin override and a wrong date look identical in advance, so the tiebreaker is the
 * state's record plus his call.
 *
 * And the part these columns exist for: "if the override is legitimate, its reason gets
 * recorded on the row so the next disagreement isn't identical again."
 *
 * WHY NOT THE EXISTING `notes` COLUMN. It is free text and currently unused, so it would work
 * once. It would not work the second time: the whole point is that a later disagreement can be
 * ANSWERED rather than escalated again, which needs the reason to be findable without reading
 * prose and deciding whether it is about this. A dedicated column makes "is this override
 * explained?" a query rather than a judgement.
 *
 * The CHECK keeps the three fields honest together — a reason with no date, or a date with no
 * reason, is a half-recorded decision, which is the thing this is meant to prevent.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE entity_compliance
      ADD COLUMN IF NOT EXISTS due_date_override_reason text,
      ADD COLUMN IF NOT EXISTS due_date_override_at timestamptz,
      ADD COLUMN IF NOT EXISTS due_date_override_by_staff_id uuid REFERENCES staff(id);

    COMMENT ON COLUMN entity_compliance.due_date_override_reason IS
      'Why the stored annual_report_due_date differs from the state-rule derivation. Recorded when Brian rules on a disagreement, so the next one can be answered from the row instead of escalated again.';
  `);

  pgm.sql(`
    ALTER TABLE entity_compliance
      ADD CONSTRAINT entity_compliance_override_is_complete CHECK (
        (due_date_override_reason IS NULL) = (due_date_override_at IS NULL)
      );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE entity_compliance
      DROP CONSTRAINT IF EXISTS entity_compliance_override_is_complete,
      DROP COLUMN IF EXISTS due_date_override_reason,
      DROP COLUMN IF EXISTS due_date_override_at,
      DROP COLUMN IF EXISTS due_date_override_by_staff_id;
  `);
};
