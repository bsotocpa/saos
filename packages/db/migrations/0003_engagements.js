/**
 * 0003 — Engagements: generic engagement, tax engagement (full field set incl.
 * extension block), stage history, IRS notices, entity compliance, PLLC
 * conversions.
 *
 * Spec: MP "Tax Operations" (Tax Engagement Module, Pipeline, Extension
 * Workflow, IRS Notice Module), MP "Bookkeeping & Advisory → Entity module",
 * MP v4.2 Service Delivery Model (attest independence override fields),
 * OF Module I (PLLC conversion pipeline).
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE service_line      AS ENUM ('tax', 'bookkeeping', 'payroll', 'sales_tax', 'advisory', 'coo', 'entity', 'attest', 'specialized_cpa', 'nonprofit_cfo');
    CREATE TYPE engagement_status AS ENUM ('draft', 'active', 'on_hold', 'completed', 'withdrawn');

    ------------------------------------------------------------------
    -- Generic engagement (per service line). Tax details hang off it.
    ------------------------------------------------------------------
    CREATE TABLE engagements (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id    uuid NOT NULL REFERENCES contacts(id),
      business_id   uuid REFERENCES businesses(id),
      service_line  service_line NOT NULL,
      status        engagement_status NOT NULL DEFAULT 'draft',
      title         text,
      lead_staff_id uuid REFERENCES staff(id),
      started_on    date,
      ended_on      date,
      -- Attest independence check (MP v4.2): creating an 'attest' engagement for a
      -- client with active bookkeeping/payroll/management services is BLOCKED in
      -- code unless Brian's documented override is recorded here.
      independence_override_by_id uuid REFERENCES staff(id),
      independence_override_note  text,
      independence_override_at    timestamptz,
      notes         text,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
      -- price_book_version_id + price-lock fields are added in 0007 (price book).
    );
    COMMENT ON TABLE engagements IS
      'One row per service engagement. tax_engagements extends service_line=tax; bookkeeping/advisory modules extend it in Phase 3.';
    CREATE INDEX idx_engagements_contact ON engagements (contact_id, service_line);
    CREATE INDEX idx_engagements_active  ON engagements (service_line, status) WHERE status = 'active';

    ------------------------------------------------------------------
    -- Tax engagement (MP Tax Engagement Module — field-for-field)
    ------------------------------------------------------------------
    CREATE TYPE tax_stage AS ENUM (
      'intake_started', 'scheduled', 'documents_requested', 'pending_client_response',
      'in_preparation', 'internal_review', 'client_review', 'ready_to_file',
      'filed', 'completed', 'on_hold', 'withdrawn'
    );
    CREATE TYPE return_type        AS ENUM ('1040', '1065', '1120s', '1120', '990', '990ez', '1120c', '1120f', '1120h', '1120pol', 'w7_itin');
    CREATE TYPE tax_client_type    AS ENUM ('individual', 'business', 'nonprofit');
    CREATE TYPE scope_creep_reason AS ENUM ('additional_states', 'additional_sch_c', 'additional_sch_e', 'foreign', 'late_docs', 'prior_year_cleanup', 'irs_notice', 'other');
    CREATE TYPE signature_method   AS ENUM ('remote_kba', 'in_person_wet');
    CREATE TYPE payment_status     AS ENUM ('unbilled', 'invoiced', 'partial', 'paid', 'overdue', 'written_off');

    CREATE TABLE tax_engagements (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      engagement_id uuid NOT NULL UNIQUE REFERENCES engagements(id) ON DELETE CASCADE,

      -- Core
      tax_year    smallint NOT NULL,
      return_type return_type NOT NULL,
      client_type tax_client_type,
      preparer_id uuid REFERENCES staff(id),
      reviewer_id uuid REFERENCES staff(id),
      stage       tax_stage NOT NULL DEFAULT 'intake_started',

      -- Pricing (all values trace to a price_book version — no literals in code)
      estimated_fee_min_cents integer,
      estimated_fee_max_cents integer CHECK (estimated_fee_max_cents IS NULL OR estimated_fee_min_cents IS NULL OR estimated_fee_max_cents >= estimated_fee_min_cents),
      estimate_locked_at      timestamptz,   -- automation 8: estimate locked → preparation unlocked
      final_fee_cents         integer,
      discount_cents          integer NOT NULL DEFAULT 0,
      pricing_tier            text,          -- admin-configurable tier label (never a hardcoded price point)
      scope_creep_flag        boolean NOT NULL DEFAULT false,  -- auto when final > estimate top
      scope_creep_reason      scope_creep_reason,
      scope_creep_description text,
      CHECK (NOT scope_creep_flag OR scope_creep_reason IS NOT NULL),          -- reason is REQUIRED once flagged
      CHECK (scope_creep_reason IS DISTINCT FROM 'other' OR scope_creep_description IS NOT NULL),

      -- Operational
      complexity_score             numeric(2,1) CHECK (complexity_score BETWEEN 1 AND 5),  -- L1–L5, formula in MP
      complexity_inputs            jsonb NOT NULL DEFAULT '{}'::jsonb,  -- sch_c count, k1s, states, foreign, … (M7 scorer)
      client_responsiveness_score  smallint,
      docs_requested_at            timestamptz,
      docs_received_at             timestamptz,
      filed_date                   date,
      gross_revenue_cents          bigint,    -- gross revenue/contributions (990s)

      -- Extension block (MP Tax Ops — 30–40% of clients)
      extension_recommended            boolean NOT NULL DEFAULT false,
      extension_filed                  boolean NOT NULL DEFAULT false,
      extension_filed_date             date,
      extension_payment_estimate_cents integer,
      extension_payment_made           boolean NOT NULL DEFAULT false,
      original_deadline                date,
      extended_deadline                date,  -- DERIVED from return type + fiscal year end by the
                                              -- deadline engine (M8). Never a hardcoded date swap.

      -- Financial (denormalized per spec; invoices table links back in M13)
      invoice_number       text,
      invoice_amount_cents integer,
      payment_status       payment_status NOT NULL DEFAULT 'unbilled',
      invoice_sent_at      timestamptz,
      payment_received_at  timestamptz,
      qb_exported_at       timestamptz,      -- QB export flag (weekly CSV handoff)

      -- Compliance gates (enforced in code: letter → past Scheduled; 8879 → Filed)
      engagement_letter_signed_at timestamptz,
      f8879_signed_at             timestamptz,
      f8879_signature_method      signature_method,  -- remote-KBA / in-person wet, recorded per 8879

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE tax_engagements IS
      'MP Tax Engagement Module. Stage gates (engagement letter, 8879) are enforced in the transition service (M7) and mirrored by timestamps here.';
    CREATE INDEX idx_tax_eng_stage    ON tax_engagements (stage);
    CREATE INDEX idx_tax_eng_year     ON tax_engagements (tax_year);
    CREATE INDEX idx_tax_eng_preparer ON tax_engagements (preparer_id, stage);
    CREATE INDEX idx_tax_eng_deadline ON tax_engagements (extended_deadline) WHERE extension_filed;

    ------------------------------------------------------------------
    -- Stage history — client-vs-staff delay attribution
    ------------------------------------------------------------------
    CREATE TYPE waiting_on AS ENUM ('client', 'staff');

    CREATE TABLE engagement_stage_history (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tax_engagement_id   uuid NOT NULL REFERENCES tax_engagements(id) ON DELETE CASCADE,
      stage               tax_stage NOT NULL,
      entered_at          timestamptz NOT NULL DEFAULT now(),
      changed_by_staff_id uuid REFERENCES staff(id),  -- NULL = automation/system
      waiting_on          waiting_on,                 -- 'client' while pending_client_response
      note                text
    );
    COMMENT ON TABLE engagement_stage_history IS
      'Every stage transition. Durations in pending_client_response separate client delay from staff delay (SLA dashboards).';
    CREATE INDEX idx_stage_history_eng ON engagement_stage_history (tax_engagement_id, entered_at);

    ------------------------------------------------------------------
    -- IRS notices (MP IRS Notice Module)
    ------------------------------------------------------------------
    CREATE TYPE notice_status AS ENUM ('received', 'under_review', 'response_drafted', 'response_sent', 'resolved', 'escalated');
    CREATE TYPE notice_tier   AS ENUM ('standard', 'premium');   -- standard: client sends / premium: firm sends on behalf
    CREATE TYPE notice_source AS ENUM ('portal_upload', 'manual', 'mail', 'email');

    CREATE TABLE irs_notices (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id         uuid NOT NULL REFERENCES contacts(id),
      business_id        uuid REFERENCES businesses(id),
      tax_engagement_id  uuid REFERENCES tax_engagements(id),
      notice_type        text NOT NULL,      -- admin-editable dropdown value or free text ("Other")
      tax_year           smallint,
      notice_date        date,
      response_deadline  date,               -- auto-derived from notice type + date (M9)
      handler_staff_id   uuid REFERENCES staff(id),  -- app default: Ana-Maria
      service_tier       notice_tier NOT NULL DEFAULT 'standard',
      status             notice_status NOT NULL DEFAULT 'received',
      amount_cents       bigint,
      resolution_notes   text,
      source             notice_source NOT NULL DEFAULT 'manual',
      document_id        uuid,               -- FK added in 0004
      received_at        timestamptz NOT NULL DEFAULT now(),
      first_actioned_at  timestamptz,        -- unactioned 48h → Brian+Jackson alert
      escalated_at       timestamptz,        -- deadline <14 days → Brian escalation
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_notices_handler  ON irs_notices (handler_staff_id, status);
    CREATE INDEX idx_notices_deadline ON irs_notices (response_deadline) WHERE status NOT IN ('resolved');

    ------------------------------------------------------------------
    -- Entity compliance (Laura) + annual reports + PLLC conversions
    ------------------------------------------------------------------
    CREATE TYPE compliance_status AS ENUM ('unknown', 'good', 'due_soon', 'overdue', 'filed');
    CREATE TYPE ar_filing_status  AS ENUM ('upcoming', 'reminded_staff', 'reminded_client', 'filed', 'late');

    CREATE TABLE entity_compliance (
      id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id            uuid NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
      assigned_staff_id      uuid REFERENCES staff(id),  -- app default: Laura
      state                  text NOT NULL DEFAULT 'IL',
      formation_date         date,
      annual_report_due_date date,           -- auto-calculated per state rules (M9)
      status                 compliance_status NOT NULL DEFAULT 'unknown',
      last_filed_date        date,
      notes                  text,
      created_at             timestamptz NOT NULL DEFAULT now(),
      updated_at             timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE annual_report_filings (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_compliance_id uuid NOT NULL REFERENCES entity_compliance(id) ON DELETE CASCADE,
      period_year          smallint NOT NULL,
      due_date             date NOT NULL,
      filed_date           date,
      status               ar_filing_status NOT NULL DEFAULT 'upcoming',  -- reminders: Laura T-60, client T-30
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      UNIQUE (entity_compliance_id, period_year)
    );

    CREATE TYPE pllc_status AS ENUM ('flagged', 'client_notified', 'advisory_scheduled', 'in_progress', 'filed', 'completed', 'dismissed');

    CREATE TABLE pllc_conversions (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id          uuid NOT NULL REFERENCES contacts(id),
      business_id         uuid REFERENCES businesses(id),
      detected_via        text NOT NULL DEFAULT 'module_i',  -- 'module_i' | 'manual' | 'sos_check'
      license_type        text,               -- OF Module I I1 (LCPC, LCSW, …)
      current_entity_type business_entity_type,
      status              pllc_status NOT NULL DEFAULT 'flagged',
      license_verified    boolean NOT NULL DEFAULT false,    -- license verification step (MP entity module)
      assigned_staff_id   uuid REFERENCES staff(id),         -- app default: Laura + advisory flag
      checklist           jsonb NOT NULL DEFAULT '[]'::jsonb, -- conversion filing checklist items
      notes               text,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE pllc_conversions IS
      'OF Module I auto-flag: licensed professional + LLC/sole-prop + IL = improperly formed → PLLC conversion opportunity. This IS the new service pipeline.';

    CREATE TRIGGER trg_engagements_updated_at  BEFORE UPDATE ON engagements           FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_tax_eng_updated_at      BEFORE UPDATE ON tax_engagements       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_notices_updated_at      BEFORE UPDATE ON irs_notices           FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_entity_comp_updated_at  BEFORE UPDATE ON entity_compliance     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_ar_filings_updated_at   BEFORE UPDATE ON annual_report_filings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_pllc_updated_at         BEFORE UPDATE ON pllc_conversions      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS pllc_conversions;
    DROP TYPE  IF EXISTS pllc_status;
    DROP TABLE IF EXISTS annual_report_filings;
    DROP TYPE  IF EXISTS ar_filing_status;
    DROP TABLE IF EXISTS entity_compliance;
    DROP TYPE  IF EXISTS compliance_status;
    DROP TABLE IF EXISTS irs_notices;
    DROP TYPE  IF EXISTS notice_source;
    DROP TYPE  IF EXISTS notice_tier;
    DROP TYPE  IF EXISTS notice_status;
    DROP TABLE IF EXISTS engagement_stage_history;
    DROP TYPE  IF EXISTS waiting_on;
    DROP TABLE IF EXISTS tax_engagements;
    DROP TYPE  IF EXISTS payment_status;
    DROP TYPE  IF EXISTS signature_method;
    DROP TYPE  IF EXISTS scope_creep_reason;
    DROP TYPE  IF EXISTS tax_client_type;
    DROP TYPE  IF EXISTS return_type;
    DROP TYPE  IF EXISTS tax_stage;
    DROP TABLE IF EXISTS engagements;
    DROP TYPE  IF EXISTS engagement_status;
    DROP TYPE  IF EXISTS service_line;
  `);
};
