/**
 * M26 flow 2 (v4.3): entity-group workflow.
 *  - billing_mode per group: consolidated (default — ONE invoice, line-
 *    itemed per entity) or per_entity; changeable anytime, next cycle.
 *  - ONE bundled Docuseal envelope + ONE KBA covers every group 8879:
 *    envelopes gain entity_group_id, and signature_envelope_items links
 *    each covered tax engagement so completion stamps them all.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE entity_groups ADD COLUMN billing_mode text NOT NULL DEFAULT 'consolidated'
      CHECK (billing_mode IN ('consolidated', 'per_entity'));

    ALTER TABLE signature_envelopes ADD COLUMN entity_group_id uuid REFERENCES entity_groups(id);

    CREATE TABLE signature_envelope_items (
      envelope_id       uuid NOT NULL REFERENCES signature_envelopes(id) ON DELETE CASCADE,
      tax_engagement_id uuid NOT NULL REFERENCES tax_engagements(id) ON DELETE CASCADE,
      PRIMARY KEY (envelope_id, tax_engagement_id)
    );
    COMMENT ON TABLE signature_envelope_items IS
      'Bundled envelopes (entity-group 8879s): one envelope + one KBA covers every listed engagement; completion stamps them all.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE signature_envelope_items;
    ALTER TABLE signature_envelopes DROP COLUMN entity_group_id;
    ALTER TABLE entity_groups DROP COLUMN billing_mode;
  `);
};
