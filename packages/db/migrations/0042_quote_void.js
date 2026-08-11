/**
 * A quote can be VOIDED internally, which is not the same as a client declining it.
 *
 * Brian sent two quotes to the same client during the dress rehearsal (the send
 * confirmation did not persist, so he could not tell the first had gone). Both were
 * accepted. Cleaning that up needed a terminal state for "this proposal was our
 * mistake" — and the existing enum offered only `declined` or `expired`.
 *
 * Using `declined` would have been a lie with consequences: pipelineMetrics groups
 * `decline_reason` into the lost-reasons report, so an internal duplicate would have
 * shown up forever as a reason CLIENTS say no. `expired` is equally untrue.
 *
 * A voided quote is excluded from every pipeline metric — it was never a real
 * proposal, so it is neither sent, open, won, nor lost.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TYPE quote_status ADD VALUE IF NOT EXISTS 'void';
    COMMENT ON TYPE quote_status IS
      'draft/sent/accepted/declined/expired are the client-facing lifecycle. void = withdrawn by us (duplicate, error); excluded from all pipeline metrics.';
  `);
};

// Postgres cannot drop a value from an enum. The down migration is deliberately a
// no-op rather than a destructive type rebuild that would break existing rows.
exports.down = () => {};
