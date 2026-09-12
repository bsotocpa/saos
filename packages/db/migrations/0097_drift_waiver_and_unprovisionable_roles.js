/* eslint-disable camelcase */
/**
 * TWO RECONCILED ITEMS (2026-09-12, Brian's ruling reconciliation).
 *
 *   1. The Stripe drift waiver. SA-2026-0001 was paid under the test key; the live key cannot see
 *      it; the nightly check raised a task nobody could resolve (finding, 2026-09-11, item 6).
 *      An invoice can now carry a waiver: who, when, why. The check skips it and counts it.
 *   2. Roles that accept no staff. "Nobody is provisioned into client_success or advisory_manager"
 *      (2026-09-12) was a rule with no enforcement. roles.accepts_staff is the flag; the staff
 *      routes refuse and Admin → Staff does not offer them.
 *
 * Touches no client record.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE invoices
      ADD COLUMN stripe_check_waived_at timestamptz,
      ADD COLUMN stripe_check_waived_by_staff_id uuid REFERENCES staff(id),
      ADD COLUMN stripe_check_waived_reason text,
      ADD CONSTRAINT invoices_stripe_waiver_complete CHECK (
        (stripe_check_waived_at IS NULL) = (stripe_check_waived_reason IS NULL)
      );
  `);
  pgm.sql(`ALTER TABLE roles ADD COLUMN accepts_staff boolean NOT NULL DEFAULT true;`);
  pgm.sql(`UPDATE roles SET accepts_staff = false WHERE key IN ('client_success', 'advisory_manager');`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE roles DROP COLUMN IF EXISTS accepts_staff;`);
  pgm.sql(`ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_stripe_waiver_complete, DROP COLUMN IF EXISTS stripe_check_waived_at, DROP COLUMN IF EXISTS stripe_check_waived_by_staff_id, DROP COLUMN IF EXISTS stripe_check_waived_reason;`);
};
