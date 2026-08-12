/**
 * FINDING #11 — attachments in Messages, routed into the Documents pipeline.
 *
 * Clients will try to send files in the conversation; that is where they are. The
 * portal-only document rule stays intact by making this a PORTAL UPLOAD THAT HAPPENS
 * TO START IN CHAT: the file goes through the same uploadDocument path as the
 * Documents page, with identical provenance, and the message merely points at it.
 *
 * Brian's requirement: downstream filing, chase and Documents logic must not be able
 * to distinguish a Messages-originated file from a direct portal upload. So there is
 * deliberately NO source column on documents — nothing for that logic to branch on.
 * The linkage lives here, on the message, in one direction only.
 *
 * Brian's ruling on the shape (2026-08-12): REFERENCE PLUS IMMUTABLE TEXT.
 *  · messages.body keeps its own sentence ("Attached receipt.pdf"), written once and
 *    never recomputed, so the conversation still reads correctly years later.
 *  · messages.document_id references the document, ON DELETE SET NULL — if the
 *    document is deleted or refiled, the sentence survives and the link degrades to
 *    plain text instead of leaving a hole in the thread.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE messages
      ADD COLUMN document_id uuid REFERENCES documents(id) ON DELETE SET NULL;

    COMMENT ON COLUMN messages.document_id IS
      'Set when this message carried a file. ON DELETE SET NULL by design: messages.body holds its own immutable sentence, so a deleted or refiled document degrades the link without breaking the conversation. There is intentionally no matching source column on documents — a Messages-originated upload must be indistinguishable downstream from a direct portal upload.';

    CREATE INDEX idx_messages_document ON messages (document_id) WHERE document_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_messages_document;
    ALTER TABLE messages DROP COLUMN document_id;
  `);
};
