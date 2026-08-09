/**
 * M26 flow 3 (v4.3): auto-extension batch. At the season cutoffs — Mar 25 for
 * March filers (business returns), Apr 1 for April filers — engagements whose
 * documents are still missing are swept into a batch, the client is told a
 * protective extension is coming, and BRIAN REVIEWS THE BATCH before any
 * preparer files. Approval is the gate: filing a batch item is refused until
 * the batch is approved (v4.3 "Brian reviews the batch list before preparers
 * file").
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE extension_batches (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tax_year             integer NOT NULL,
      lane                 text NOT NULL CHECK (lane IN ('business', 'individual')),
      cutoff_date          date NOT NULL,
      status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'filed')),
      approved_by_staff_id uuid REFERENCES staff(id),
      approved_at          timestamptz,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tax_year, lane)
    );
    CREATE TRIGGER trg_extension_batches_updated_at BEFORE UPDATE ON extension_batches
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE extension_batch_items (
      batch_id           uuid NOT NULL REFERENCES extension_batches(id) ON DELETE CASCADE,
      tax_engagement_id  uuid NOT NULL REFERENCES tax_engagements(id) ON DELETE CASCADE,
      client_notified_at timestamptz,
      filed_at           timestamptz,
      removed_at         timestamptz,      -- Brian pulled it out during review
      added_at           timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (batch_id, tax_engagement_id)
    );
    COMMENT ON TABLE extension_batch_items IS
      'Engagements swept into a season extension batch. filed_at is set only through the batch-filing endpoint, which requires batch status = approved.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE extension_batch_items;
    DROP TABLE extension_batches;
  `);
};
