/* eslint-disable camelcase */
/**
 * 0132 — THE DOCUMENT CHECKLIST FROM THE QUOTED LINES (Brian, 2026-09-27, R83).
 *
 * An accepted tax quote knows what the return is (its lines: the base return, the schedules, the
 * forms). This table says, per price-book item, which documents the client owes for it; acceptance
 * builds one checklist request for the return from its lines, on the document_requests tables that
 * already carry per-item status, the portal's "This fulfills" link, withdraw and the done-rollup.
 *
 *   document_checklist_items          seeded (insert-if-absent: an edited row is never overwritten)
 *                                     and edited in Admin -> Document checklist. Keyed by the price
 *                                     book's item_code, which stays the same across versions, and a
 *                                     doc_key: two lines asking for the same doc_key ask once.
 *   document_requests.source          'staff' (a preparer built it) or 'checklist' (acceptance did).
 *   document_request_items.checklist_doc_key   the row it came from, for a checklist request.
 *   document_request_items.seq        the order the items were written in (the client reads that order).
 */
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS document_checklist_items (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      item_code           text NOT NULL,
      doc_key             text NOT NULL CHECK (doc_key ~ '^[a-z0-9_]+$'),
      label_en            text NOT NULL CHECK (length(btrim(label_en)) > 0),
      label_es            text NOT NULL CHECK (length(btrim(label_es)) > 0),
      sort_order          integer NOT NULL DEFAULT 0,
      active              boolean NOT NULL DEFAULT true,
      updated_by_staff_id uuid REFERENCES staff(id),
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      UNIQUE (item_code, doc_key)
    )
  `);
  await pgm.db.query(`
    COMMENT ON TABLE document_checklist_items IS
      'R83: the documents a client owes for each price-book item. Acceptance of a tax quote builds the return''s checklist request from its lines; Admin -> Document checklist edits the rows.'
  `);
  await pgm.db.query(`
    ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'staff'
      CHECK (source IN ('staff', 'checklist'))
  `);
  await pgm.db.query(`ALTER TABLE document_request_items ADD COLUMN IF NOT EXISTS checklist_doc_key text`);
  // The order the items were written in: one request's items share one created_at (one transaction),
  // and the clock is never an order (the VM clock steps back), so a sequence carries it.
  await pgm.db.query(`ALTER TABLE document_request_items ADD COLUMN IF NOT EXISTS seq bigserial`);
  await pgm.db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_document_requests_checklist
      ON document_requests (tax_engagement_id) WHERE source = 'checklist'
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`DROP INDEX IF EXISTS uq_document_requests_checklist`);
  await pgm.db.query(`ALTER TABLE document_request_items DROP COLUMN IF EXISTS seq`);
  await pgm.db.query(`ALTER TABLE document_request_items DROP COLUMN IF EXISTS checklist_doc_key`);
  await pgm.db.query(`ALTER TABLE document_requests DROP COLUMN IF EXISTS source`);
  await pgm.db.query(`DROP TABLE IF EXISTS document_checklist_items`);
};
