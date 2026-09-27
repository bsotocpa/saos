/* eslint-disable camelcase */
/**
 * THE BILLING HOLD ON AN IMPORTED ENGAGEMENT (Brian, 2026-09-26, R68).
 *
 * The Trello import creates sales-tax and payroll engagements (R33) for services the firm already
 * performs, and nothing in SAOS may bill them until Brian says so: the client's billing history
 * lives in the old system, and an invoice raised by the new one before the cutover is settled would
 * be a second bill. The 2026-09-26 day-two report found the rule held only by absence (no job bills
 * by service line), so this makes it a column every invoice factory reads.
 *
 *   billing_hold             true while no invoice may be created for this engagement
 *   billing_hold_reason      why it is held, written by whatever placed it (the importer's sentence)
 *   billing_hold_lifted_at   when a person lifted it; NULL while held or never held
 *   billing_hold_lifted_by   who lifted it
 *   billing_hold_lift_reason why, in their words (reasonText: standalone, no chat artifacts)
 *
 * A hold carries its reason (a flag nobody can explain is a rumour), and a lift is all-or-nothing:
 * the moment, the person and the reason land together or not at all, so "who lifted this and why"
 * is answerable from the row. The audit log carries the same facts as events.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE engagements
      ADD COLUMN IF NOT EXISTS billing_hold             boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS billing_hold_reason      text,
      ADD COLUMN IF NOT EXISTS billing_hold_lifted_at   timestamptz,
      ADD COLUMN IF NOT EXISTS billing_hold_lifted_by   uuid REFERENCES staff(id),
      ADD COLUMN IF NOT EXISTS billing_hold_lift_reason text
  `);
  await pgm.db.query(`
    ALTER TABLE engagements
      ADD CONSTRAINT engagements_billing_hold_has_reason CHECK (
        NOT billing_hold OR billing_hold_reason IS NOT NULL
      ),
      ADD CONSTRAINT engagements_billing_hold_lift_complete CHECK (
        (billing_hold_lifted_at IS NULL AND billing_hold_lifted_by IS NULL AND billing_hold_lift_reason IS NULL)
        OR (billing_hold_lifted_at IS NOT NULL AND billing_hold_lifted_by IS NOT NULL
            AND billing_hold_lift_reason IS NOT NULL AND length(btrim(billing_hold_lift_reason)) >= 10)
      )
  `);
  await pgm.db.query(`
    CREATE INDEX IF NOT EXISTS idx_engagements_billing_hold ON engagements (contact_id) WHERE billing_hold
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN engagements.billing_hold IS
      'R68: true while no invoice may be created for this engagement. Set by the Trello importer on every ongoing engagement it creates; lifted by the CEO, per engagement, with a reason.'
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    DROP INDEX IF EXISTS idx_engagements_billing_hold;
    ALTER TABLE engagements
      DROP CONSTRAINT IF EXISTS engagements_billing_hold_has_reason,
      DROP CONSTRAINT IF EXISTS engagements_billing_hold_lift_complete,
      DROP COLUMN IF EXISTS billing_hold,
      DROP COLUMN IF EXISTS billing_hold_reason,
      DROP COLUMN IF EXISTS billing_hold_lifted_at,
      DROP COLUMN IF EXISTS billing_hold_lifted_by,
      DROP COLUMN IF EXISTS billing_hold_lift_reason
  `);
};
