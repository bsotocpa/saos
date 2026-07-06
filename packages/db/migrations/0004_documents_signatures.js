/**
 * 0004 — Documents (MinIO-backed) + document requests + e-signature envelopes
 * (Docuseal) + KBA verifications.
 *
 * Spec: MP "Client Portal → Document Center", MP "E-Signature Module",
 * MP "Compliance Layer" (every access audit-logged; 8879 remote path requires
 * KBA ahead of the Docuseal envelope, vendor pluggable).
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE document_category AS ENUM (
      'tax_documents', 'business_records', 'id_verification', 'irs_notices',
      'signed_authorizations', 'return_deliverable', 'other'
    );
    CREATE TYPE document_status AS ENUM ('uploaded', 'under_review', 'accepted', 'needs_replacement', 'archived');
    CREATE TYPE uploader_type   AS ENUM ('client', 'staff', 'system');

    ------------------------------------------------------------------
    -- Documents: metadata only — bytes live in private MinIO buckets.
    ------------------------------------------------------------------
    CREATE TABLE documents (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id        uuid NOT NULL REFERENCES contacts(id),
      business_id       uuid REFERENCES businesses(id),
      tax_engagement_id uuid REFERENCES tax_engagements(id),
      tax_year          smallint,
      category          document_category NOT NULL,
      status            document_status NOT NULL DEFAULT 'uploaded',
      filename          text NOT NULL,
      mime_type         text,
      size_bytes        bigint,
      minio_bucket      text NOT NULL,
      minio_key         text NOT NULL UNIQUE,
      sha256            text,                -- integrity check on upload
      uploaded_by_type  uploader_type NOT NULL,
      uploaded_by_id    uuid,
      uploaded_at       timestamptz NOT NULL DEFAULT now(),
      archived_at       timestamptz,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE documents IS
      'Every view/download/edit is audit-logged by the document service (M10) — no feature touches client documents without audit coverage. Documents travel by portal only, never SMS/email attachment.';
    COMMENT ON COLUMN documents.category IS
      'Portal categories per MP Document Center; return_deliverable = final return PDF uploaded by the preparer from ATX (My Returns).';
    CREATE INDEX idx_documents_contact ON documents (contact_id, category);
    CREATE INDEX idx_documents_tax_eng ON documents (tax_engagement_id);

    ------------------------------------------------------------------
    -- Document requests (drive Pending Client Response + chase automations)
    ------------------------------------------------------------------
    CREATE TYPE doc_request_status      AS ENUM ('open', 'partially_received', 'complete', 'cancelled');
    CREATE TYPE doc_request_item_status AS ENUM ('pending', 'received', 'waived');

    CREATE TABLE document_requests (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id          uuid NOT NULL REFERENCES contacts(id),
      engagement_id       uuid REFERENCES engagements(id),
      tax_engagement_id   uuid REFERENCES tax_engagements(id),
      status              doc_request_status NOT NULL DEFAULT 'open',
      -- Client-facing copy ships bilingual (EN/ES DoD):
      title_en            text NOT NULL,
      title_es            text,
      note_en             text,
      note_es             text,
      due_date            date,
      created_by_staff_id uuid REFERENCES staff(id),
      last_reminder_at    timestamptz,       -- 3-day reminder cadence (automation 4)
      reminder_count      integer NOT NULL DEFAULT 0,
      completed_at        timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE document_requests IS
      'Creating one flips the tax engagement to pending_client_response (automation 4); 7-day non-response alerts Brian+Jackson (automation 5).';
    CREATE INDEX idx_doc_requests_open ON document_requests (contact_id) WHERE status IN ('open', 'partially_received');

    CREATE TABLE document_request_items (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id    uuid NOT NULL REFERENCES document_requests(id) ON DELETE CASCADE,
      label_en      text NOT NULL,
      label_es      text,
      status        doc_request_item_status NOT NULL DEFAULT 'pending',
      document_id   uuid REFERENCES documents(id),
      waived_reason text,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    );

    ------------------------------------------------------------------
    -- Signature envelopes (Docuseal) + pluggable KBA verification
    ------------------------------------------------------------------
    CREATE TYPE envelope_type   AS ENUM ('engagement_letter', 'consent_7216', 'f8879', 'w9', 'grant_agreement', 'other');
    CREATE TYPE envelope_status AS ENUM ('draft', 'kba_required', 'kba_pending', 'sent', 'viewed', 'completed', 'declined', 'voided', 'expired');

    CREATE TABLE signature_envelopes (
      id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id             uuid NOT NULL REFERENCES contacts(id),
      engagement_id          uuid REFERENCES engagements(id),
      tax_engagement_id      uuid REFERENCES tax_engagements(id),
      type                   envelope_type NOT NULL,
      status                 envelope_status NOT NULL DEFAULT 'draft',
      template_key           text,           -- references templates.key (0005); send path checks is_placeholder
      docuseal_template_id   text,
      docuseal_submission_id text,
      recipient_email        citext,
      sent_at                timestamptz,
      viewed_at              timestamptz,
      completed_at           timestamptz,
      declined_at            timestamptz,
      voided_at              timestamptz,
      signed_document_id     uuid REFERENCES documents(id),  -- executed copy, auto-filed to MinIO
      signature_method       signature_method,               -- 8879: remote_kba / in_person_wet
      created_by_staff_id    uuid REFERENCES staff(id),
      created_at             timestamptz NOT NULL DEFAULT now(),
      updated_at             timestamptz NOT NULL DEFAULT now(),
      -- IRS Pub 1345: a remote 8879 envelope cannot be sent without KBA — the
      -- signing service (M11) enforces the passed-KBA check; kba_required/kba_pending
      -- statuses exist so an f8879 can never skip the step silently.
      CHECK (type <> 'f8879' OR status NOT IN ('sent', 'viewed', 'completed') OR signature_method IS NOT NULL)
    );
    CREATE INDEX idx_envelopes_contact ON signature_envelopes (contact_id, type, status);

    CREATE TABLE kba_verifications (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      envelope_id    uuid NOT NULL REFERENCES signature_envelopes(id) ON DELETE CASCADE,
      vendor         text NOT NULL,          -- pluggable adapter key — swapping vendors must not touch the signing flow
      vendor_ref     text,
      status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'passed', 'failed', 'error')),
      attempts       smallint NOT NULL DEFAULT 0,
      verified_at    timestamptz,
      failure_reason text,
      cost_cents     integer,                -- per-signature KBA cost tracking (~$1–3)
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE kba_verifications IS
      'Knowledge-based authentication ahead of remote 8879 signing. Vendor is pluggable (MP: never hardcoded).';

    -- Late FKs now that documents/signature_envelopes exist:
    ALTER TABLE consents
      ADD CONSTRAINT fk_consents_document FOREIGN KEY (document_id) REFERENCES documents(id),
      ADD CONSTRAINT fk_consents_envelope FOREIGN KEY (envelope_id) REFERENCES signature_envelopes(id);
    ALTER TABLE irs_notices
      ADD CONSTRAINT fk_notices_document FOREIGN KEY (document_id) REFERENCES documents(id);

    CREATE TRIGGER trg_documents_updated_at    BEFORE UPDATE ON documents              FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_doc_requests_updated_at BEFORE UPDATE ON document_requests      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_doc_req_items_updated   BEFORE UPDATE ON document_request_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_envelopes_updated_at    BEFORE UPDATE ON signature_envelopes    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_kba_updated_at          BEFORE UPDATE ON kba_verifications      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE irs_notices DROP CONSTRAINT IF EXISTS fk_notices_document;
    ALTER TABLE consents    DROP CONSTRAINT IF EXISTS fk_consents_envelope;
    ALTER TABLE consents    DROP CONSTRAINT IF EXISTS fk_consents_document;
    DROP TABLE IF EXISTS kba_verifications;
    DROP TABLE IF EXISTS signature_envelopes;
    DROP TYPE  IF EXISTS envelope_status;
    DROP TYPE  IF EXISTS envelope_type;
    DROP TABLE IF EXISTS document_request_items;
    DROP TABLE IF EXISTS document_requests;
    DROP TYPE  IF EXISTS doc_request_item_status;
    DROP TYPE  IF EXISTS doc_request_status;
    DROP TABLE IF EXISTS documents;
    DROP TYPE  IF EXISTS uploader_type;
    DROP TYPE  IF EXISTS document_status;
    DROP TYPE  IF EXISTS document_category;
  `);
};
