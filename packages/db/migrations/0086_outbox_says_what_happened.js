/* eslint-disable camelcase */
/**
 * THE OUTBOX SAYS WHAT HAPPENED (2026-09-10, Brian's ruling on the morning report).
 *
 * A row whose effect was HELD at an automation gate read `sent`. Nothing was sent. The client
 * page already drew it correctly — noticesForInvoices sniffed a `skipped:` prefix out of
 * last_error and rendered "not sent — held" — but the status column itself said the opposite,
 * and anyone reading the table, or the raw send log which prints the status verbatim, would
 * have counted a send that never happened. A column that has to be read together with a string
 * prefix to be believed is not a record of what happened.
 *
 * Two terminal states join `sent`, and between them they cover every way a row retires without
 * sending:
 *
 *   suppressed — an automation gate held it. A DECISION, made in Admin → Automations, and the
 *                one Brian needs countable: the difference between "the client was told" and
 *                "we chose not to tell them yet".
 *   skipped    — no longer needed. Someone sent it by hand, or the thing it announced stopped
 *                being true. Not a decision about the client, and not a fault.
 *
 * `sent` now means sent.
 *
 * WHY ADD VALUE AND NOT A REBUILD. Renaming the type and creating a new one is tidier to read
 * and was the first version of this migration. It fails: two partial indexes and the
 * `outbox_abandoned_has_error` CHECK carry predicates typed against the old enum, so altering
 * the column mid-transaction leaves `outbox_status = outbox_status_old` with no operator. ADD
 * VALUE disturbs none of them. It cannot be used in the transaction that adds it, hence
 * pgm.noTransaction() and the backfill in its own statement below.
 *
 * Re-runnable if it dies partway: IF NOT EXISTS on the values, and both UPDATEs only match
 * rows that still carry the old marker.
 *
 * BACKFILL SCOPE, listed before it runs (Brian's standing rule). Exactly one row on
 * production: the 2026-09-10 02:56 UTC cancellation notice for Rehearsal Client 2, a test
 * client, held because void_notice was still off. It becomes `suppressed`. No other row in the
 * table carries a `skipped:` marker. No protected client's record is reachable from here — the
 * UPDATEs cannot touch a row that is not already terminal-without-having-sent.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  // ALTER TYPE ... ADD VALUE cannot be used in the transaction that adds it.
  pgm.noTransaction();

  pgm.sql(`ALTER TYPE outbox_status ADD VALUE IF NOT EXISTS 'suppressed';`);
  pgm.sql(`ALTER TYPE outbox_status ADD VALUE IF NOT EXISTS 'skipped';`);

  // 'held — …' is the drain's own wording for a gate hold (outbox.ts), so the two cases
  // separate without guessing. The narrower test runs first.
  pgm.sql(`
    UPDATE outbox
       SET status = 'suppressed', sent_at = NULL, last_error = replace(last_error, 'skipped: ', '')
     WHERE status = 'sent' AND last_error LIKE 'skipped: held —%';
  `);
  pgm.sql(`
    UPDATE outbox
       SET status = 'skipped', sent_at = NULL, last_error = replace(last_error, 'skipped: ', '')
     WHERE status = 'sent' AND last_error LIKE 'skipped:%';
  `);

  pgm.sql(`
    COMMENT ON COLUMN outbox.status IS
      'pending/failed are retryable; sent means the client was actually written to; suppressed means an automation gate held it (a decision, see Admin → Automations); skipped means the effect was no longer needed; abandoned means it failed every attempt and a person was told.';
  `);
};

exports.down = (pgm) => {
  pgm.noTransaction();
  /*
   * The rows go back to what they said before. The two enum VALUES stay: Postgres cannot drop
   * an enum value, and rebuilding the type to lose them would have to drop and restore the two
   * partial indexes and the CHECK constraint that depend on it — more risk on the way down
   * than the unused labels are worth.
   */
  pgm.sql(`
    UPDATE outbox
       SET status = 'sent', sent_at = COALESCE(sent_at, now()), last_error = 'skipped: ' || last_error
     WHERE status IN ('suppressed', 'skipped');
  `);
};
