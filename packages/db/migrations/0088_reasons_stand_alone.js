/* eslint-disable camelcase */
/**
 * REASONS STAND ALONE (2026-09-12, Brian's carry-over ruling from the 09-10 phone walk).
 *
 * Ruling 3 landed on the invoice and not on the engagement. A sweep of every narrative text
 * column on production (engagements.close_reason, quotes.decline_reason, tasks, notes, void
 * reasons) found eight rows that cite a conversation, a migration number, a ruling number, a
 * rehearsal, or a bare record id. Nobody reading those rows in a year knows what "ruling 1" was,
 * "migration 0061" is a fact about the codebase not the client, and an eight-character id is
 * not something a person can look up from a printed engagement letter.
 *
 * Standing rule: reason text is written for the next reader, never references a conversation.
 *
 * ROWS, LISTED BY NAME BEFORE RUNNING (Brian's standing rule). Seven engagements and one quote.
 *
 *   engagement 70adeb82  Rehearsal Client 2 (test)   "…(migration 0061)"
 *   engagement 94fce63c  BRIAN S. (test)             "…(migration 0061)"
 *   engagement d2ff818c  BRIAN S. (test)             "…(migration 0061)"
 *   engagement e54e1ac3  Brian S. — NOT a test row;  "…(migration 0061)"
 *                        Brian's own contact record, not a protected client
 *   engagement abb43fc6  Rehearsal Client 2 (test)   "…superseded by 6e474b1f (Brian's ruling 1)"
 *   engagement 6adbbab4  Rehearsal Client 2 (test)   "duplicate accept — rehearsal 2026-09-09"
 *   engagement ef90aabc  Rehearsal Client 2 (test)   "rehearsal consolidation — superseded by 6e474b1f"
 *   quote      6d3e20d4  BRIAN S. (test)             "…dress rehearsal… Canonical quote: e0acf123-…"
 *
 * No protected client (Jackson F., Josean I., Joseph B.) is reachable: every UPDATE names one
 * primary key. audit_log rows that carry ruling labels in actor_label are the record of what was
 * done and are deliberately left as written; the record is not rewritten.
 */
exports.shorthands = undefined;

const DUPLICATE_ACCEPT =
  'Withdrawn: this quote was accepted twice for the same service line. The engagement created by the first acceptance remains open and carries the work.';

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE engagements SET close_reason = '${DUPLICATE_ACCEPT}'
     WHERE id IN ('70adeb82-e6ee-44e1-8352-5b03ec5faa1f',
                  '94fce63c-d018-48c0-8865-8a25f6cfef86',
                  'd2ff818c-c8fe-4ff6-a6d2-aacd82845c8f',
                  'e54e1ac3-b7ab-4aad-b42d-1ab02473255e')
       AND close_reason LIKE '%migration 0061%';
  `);
  pgm.sql(`
    UPDATE engagements
       SET close_reason = 'Withdrawn: a duplicate acceptance of the same 2025 individual return. The work and the paid deposit moved to the engagement that remains open.'
     WHERE id = 'abb43fc6-4c0a-4588-9a67-200783593b58';
  `);
  pgm.sql(`
    UPDATE engagements
       SET close_reason = 'Withdrawn: created in September 2026 as a duplicate of the client''s 2025 individual return engagement. The return is carried by the engagement that remains open.'
     WHERE id = '6adbbab4-c7cc-45b3-91a6-457fda4220b4';
  `);
  pgm.sql(`
    UPDATE engagements
       SET close_reason = 'Withdrawn: an earlier general "Taxes" engagement folded into the client''s 2025 individual return engagement, which carries the work and the deposit.'
     WHERE id = 'ef90aabc-0ea1-41a0-96d6-55d2afcc8c31';
  `);
  pgm.sql(`
    UPDATE quotes
       SET decline_reason = 'Declined: this quote was sent twice on 2026-08-10 because the send confirmation did not persist. The first copy is the one the client acted on.'
     WHERE id = '6d3e20d4-c9f8-4c85-9470-ba49ec8a0805';
  `);
};

exports.down = () => {
  /* The old wording cited conversations; there is nothing to restore that a reader should see. */
};
