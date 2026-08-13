/**
 * FINDING #17 — record WHY a quote was sent over existing coverage.
 *
 * Brian accepted a quote on a client with a signed Master and nothing happened. Two
 * problems lived behind that: the visible consequence was skipped (fixed in code —
 * the task was inside `if (rene)` and nobody holds comms_billing), and nothing stopped
 * a second quote for a schedule the client had already accepted in the first place.
 *
 * His ruling: block at SEND time with "this client already has an active Schedule A —
 * adding work or duplicating?" So the sender has to answer, and the answer is worth
 * keeping: months later, "why does this client have two Schedule A engagements?" is a
 * real question, and "someone clicked through a warning" is not an answer.
 *
 * Deliberately an ENUM, not a boolean override. "Adding work" and "this replaces the
 * old one" have different downstream meanings — one implies concurrent scope, the
 * other implies something should have been closed — and a force flag would record
 * neither.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE quote_duplicate_intent AS ENUM ('additional_work', 'replaces_existing');

    ALTER TABLE quotes
      ADD COLUMN duplicate_intent quote_duplicate_intent,
      ADD COLUMN duplicate_intent_schedules text[];

    COMMENT ON COLUMN quotes.duplicate_intent IS
      'Set only when this quote was sent over schedules the client had ALREADY accepted. NULL is the normal case (no overlap), not "unanswered" — send refuses to proceed with an overlap and no intent.';
    COMMENT ON COLUMN quotes.duplicate_intent_schedules IS
      'The overlapping schedule codes at send time, snapshotted. Kept alongside the intent so the record still reads correctly after later schedule changes.';

    -- Rare by nature, so a partial index keeps "show me the deliberate duplicates"
    -- cheap without carrying every quote.
    CREATE INDEX idx_quotes_duplicate_intent ON quotes (contact_id)
      WHERE duplicate_intent IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_quotes_duplicate_intent;
    ALTER TABLE quotes
      DROP COLUMN duplicate_intent_schedules,
      DROP COLUMN duplicate_intent;
    DROP TYPE quote_duplicate_intent;
  `);
};
