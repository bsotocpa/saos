/* eslint-disable camelcase */
/**
 * NO MONEY RECORD EVER READS "UNKNOWN" (2026-09-10, Brian's ruling on the phone walk).
 *
 * SA-2026-0004's void line read: `void · engagement withdrawn — duplicate accept — superseded by
 * 6e474b1f (Brian's ruling 1) · (actor unknown) · Sep 10, 2026`.
 *
 * Two defects in one line.
 *
 * THE ACTOR. The invoice was not voided by a person pressing Void. It was voided by the
 * withdrawal cascade (engagements/retire-invoices.ts), which ran under a system actor with no
 * staff id — so `voided_by_staff_id` was null, the display's join found nothing, and the row
 * said the one thing a money record may never say. The originating actor was known the whole
 * time; it simply had nowhere to live. `voided_by_label` is that place: free text written by
 * whoever performed the void, person or mechanism, e.g. "system — engagement withdrawal by
 * Brian Soto". The staff id stays, and the display still prefers the joined name when there is
 * one; the label is what answers when the actor was a cascade.
 *
 * THE REASON. "superseded by 6e474b1f (Brian's ruling 1)" cites a conversation. Nobody reading
 * that row in a year knows which ruling that was, and the engagement id is not a thing a person
 * can look up from a printed invoice. Reason text is written for the next reader.
 *
 * BACKFILL SCOPE, listed before it runs (Brian's standing rule). Two rows, both on Rehearsal
 * Client 2, a test client:
 *
 *   SA-2026-0004  actor  -> 'system — engagement withdrawal by Brian Soto'
 *                 reason -> stands alone, no ruling number, no bare id
 *   SA-2026-0002  actor  -> already a staff id (Brian Soto); untouched
 *
 * No protected client's record is reachable: the UPDATE names one invoice number on one test
 * contact. Every other void row keeps its label null and its joined staff name.
 */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS voided_by_label text;
    COMMENT ON COLUMN invoices.voided_by_label IS
      'Who or what voided this invoice, in words. A person''s name when a person pressed Void; "system — <mechanism> by <person>" when a cascade did it. Never null for a void written after 2026-09-10, and never displayed as "unknown".';
  `);

  // The actor the cascade had all along, recovered from the audit row that recorded it.
  pgm.sql(`
    UPDATE invoices i
       SET voided_by_label = 'system — engagement withdrawal by Brian Soto'
     WHERE i.invoice_number = 'SA-2026-0004'
       AND i.status = 'void'
       AND i.voided_by_staff_id IS NULL
       AND i.voided_by_label IS NULL;
  `);

  // A reason that stands on its own, for whoever reads this row next.
  pgm.sql(`
    UPDATE invoices
       SET void_reason = 'Engagement withdrawn: this was a duplicate acceptance of the same 2025 individual return. The work and the paid deposit moved to the engagement that remains open.'
     WHERE invoice_number = 'SA-2026-0004'
       AND status = 'void';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE invoices
       SET void_reason = 'engagement withdrawn — duplicate accept — superseded by 6e474b1f (Brian''s ruling 1)'
     WHERE invoice_number = 'SA-2026-0004' AND status = 'void';
    ALTER TABLE invoices DROP COLUMN IF EXISTS voided_by_label;
  `);
};
