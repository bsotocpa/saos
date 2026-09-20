/* eslint-disable camelcase */
/**
 * THE REFUND DOOR'S ACTOR (Brian, ruling R29, 2026-09-20).
 *
 * Until now every row in invoice_refunds came from Stripe: the webhook heard charge.refunded, or a
 * person pressed "Re-sync from Stripe" and SAOS copied down what Stripe already held. Nobody could
 * create a refund from Ops, so no refund row had an author.
 *
 * R29 opens the door — POST /invoices/:id/refund creates the refund AT Stripe and records it here —
 * and a refund a person made has to carry the person:
 *
 *   refunded_by_staff_id   the staff member who pressed it (NULL for a refund that arrived from
 *                          Stripe: the dashboard, the webhook, a re-sync).
 *   refunded_by_label      their name as it stood at the time, so a deactivated account still
 *                          reads as a name rather than a dangling id — the same shape as
 *                          invoices.voided_by_label (0082).
 *
 * WHY THE COLUMN EARNS ITS KEEP RATHER THAN LEANING ON THE AUDIT LOG. The audit row is the history;
 * this column is what the webhook reads back. When Stripe's charge.refunded arrives for a refund the
 * door already created, the handler must know the refund was ours to avoid counting the same money
 * twice on the CEO's money line — and it must know that from the refund row itself, inside the same
 * transaction, not by pattern-matching timestamps across audit_log.
 *
 * ONE CHECK: a label without an id, or an id without a label, is half a record. Both or neither.
 *
 * TWO COLUMNS, ONE CHECK. Every existing row keeps NULL/NULL and stays a Stripe-origin refund.
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE invoice_refunds
      ADD COLUMN refunded_by_staff_id uuid REFERENCES staff(id) ON DELETE SET NULL,
      ADD COLUMN refunded_by_label    text
  `);
  await pgm.db.query(`
    ALTER TABLE invoice_refunds
      ADD CONSTRAINT invoice_refunds_actor_is_whole
        CHECK ((refunded_by_staff_id IS NULL) = (refunded_by_label IS NULL))
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN invoice_refunds.refunded_by_staff_id IS
      'The staff member who created this refund through the Ops refund door (R29, 2026-09-20). NULL means the refund came FROM Stripe — the dashboard, the webhook, or a re-sync — and is money that moved outside the door.'
  `);
  await pgm.db.query(`
    COMMENT ON COLUMN invoice_refunds.refunded_by_label IS
      'That person''s name as it stood when they pressed it, so a deactivated account still reads as a name.'
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE invoice_refunds
      DROP CONSTRAINT IF EXISTS invoice_refunds_actor_is_whole,
      DROP COLUMN IF EXISTS refunded_by_staff_id,
      DROP COLUMN IF EXISTS refunded_by_label
  `);
};
