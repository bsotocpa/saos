/**
 * 0006 — Operations: meeting intelligence, tasks, time entries, data-migration
 * staging, grants-received (minimal), forms & onboarding modules (as data),
 * portal onboarding checklist, resource library, admin settings.
 *
 * Spec: MP "Meeting Intelligence", MP "Time Tracking", MP "Data Migration",
 * MP "Grant Modules → B" (schema only in Phase 1 — Grant Tracker import
 * lands here), OF Forms 1–5 + Module Builder (modules stored as data),
 * MP "Admin Interface" (settings, resource library).
 */

exports.up = (pgm) => {
  pgm.sql(`
    ------------------------------------------------------------------
    -- Meeting intelligence (Zoom webhook / browser recorder / voice memo)
    ------------------------------------------------------------------
    CREATE TYPE meeting_type   AS ENUM ('zoom', 'phone', 'in_person');
    CREATE TYPE meeting_source AS ENUM ('zoom_webhook', 'browser_recorder', 'voice_memo_upload', 'manual');
    CREATE TYPE meeting_status AS ENUM ('recorded', 'transcribing', 'summarizing', 'ready', 'failed');
    CREATE TYPE recap_status   AS ENUM ('none', 'drafted', 'approved', 'sent');

    CREATE TABLE meetings (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id            uuid REFERENCES contacts(id),
      staff_id              uuid REFERENCES staff(id),
      type                  meeting_type NOT NULL,
      source                meeting_source NOT NULL,
      status                meeting_status NOT NULL DEFAULT 'recorded',
      title                 text,            -- auto-generated "CLIENT — Session Type" (v4.2 convention)
      started_at            timestamptz,
      duration_seconds      integer,
      recording_document_id uuid REFERENCES documents(id),  -- audio lives in MinIO 'saos-recordings'
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_meetings_contact ON meetings (contact_id, started_at DESC);

    CREATE TABLE transcripts (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      meeting_id uuid NOT NULL UNIQUE REFERENCES meetings(id) ON DELETE CASCADE,
      engine     text NOT NULL DEFAULT 'whisper_local',
      language   language_code,
      content    text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE transcripts IS
      'Client data: stays on owned infrastructure. LLM API fallback receives cleaned text only — never audio or raw transcripts with identifiers (MP stack rules).';

    CREATE TABLE meeting_summaries (
      id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      meeting_id                 uuid NOT NULL UNIQUE REFERENCES meetings(id) ON DELETE CASCADE,
      model                      text,       -- 'ollama_local' | api fallback model id
      summary                    text,       -- 3–5 sentences
      decisions                  jsonb NOT NULL DEFAULT '[]'::jsonb,
      action_items               jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{owner, due, text}] → auto-created tasks
      tax_need                   boolean NOT NULL DEFAULT false,
      tax_need_description       text,
      referral_rec_hilo_to_soto  boolean NOT NULL DEFAULT false,      -- queued for approval, §7216-gated
      referral_rec_soto_to_hilo  boolean NOT NULL DEFAULT false,
      -- Client-facing session recap (v4.2 module 6) — approval-gated, never auto-sent:
      client_recap_status        recap_status NOT NULL DEFAULT 'none',
      recap_body_en              text,
      recap_body_es              text,
      recap_approved_by_staff_id uuid REFERENCES staff(id),
      recap_approved_at          timestamptz,
      created_at                 timestamptz NOT NULL DEFAULT now(),
      updated_at                 timestamptz NOT NULL DEFAULT now()
    );

    ------------------------------------------------------------------
    -- Tasks (automation outputs + manual)
    ------------------------------------------------------------------
    CREATE TYPE task_status AS ENUM ('open', 'in_progress', 'done', 'cancelled');
    CREATE TYPE task_source AS ENUM ('manual', 'meeting', 'automation', 'system');

    CREATE TABLE tasks (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title             text NOT NULL,
      description       text,
      assigned_staff_id uuid REFERENCES staff(id),
      contact_id        uuid REFERENCES contacts(id),
      due_date          date,
      priority          smallint NOT NULL DEFAULT 0,
      status            task_status NOT NULL DEFAULT 'open',
      source            task_source NOT NULL DEFAULT 'manual',
      source_type       text,               -- e.g. 'meeting', 'magic_link_bounce', 'irs_notice'
      source_id         text,
      completed_at      timestamptz,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_tasks_assignee ON tasks (assigned_staff_id, status);
    CREATE INDEX idx_tasks_contact  ON tasks (contact_id);

    ------------------------------------------------------------------
    -- Time entries (10-second logging; meeting summaries suggest entries)
    ------------------------------------------------------------------
    CREATE TYPE time_entry_status AS ENUM ('suggested', 'confirmed', 'discarded');

    CREATE TABLE time_entries (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      staff_id     uuid NOT NULL REFERENCES staff(id),
      contact_id   uuid REFERENCES contacts(id),
      service_type text,                     -- includes Hilo 'grant_application_assistance' (pro bono metric)
      hours        numeric(5,2) NOT NULL CHECK (hours > 0),  -- 0.25h increments enforced in UI
      is_pro_bono  boolean NOT NULL DEFAULT false,           -- Hilo work auto-suggests true
      entry_date   date NOT NULL DEFAULT CURRENT_DATE,
      status       time_entry_status NOT NULL DEFAULT 'confirmed',
      meeting_id   uuid REFERENCES meetings(id),             -- set when suggested from a recording
      notes        text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE time_entries IS
      'Feeds pro bono hours + dollar value for funder reports, staff utilization, and engagement profitability (MP Time Tracking).';

    ------------------------------------------------------------------
    -- Data-migration staging (Dubsado / Zoho / Grant Tracker)
    ------------------------------------------------------------------
    CREATE TYPE import_source        AS ENUM ('dubsado', 'zoho', 'grant_tracker');
    CREATE TYPE import_record_status AS ENUM ('pending', 'imported', 'skipped', 'duplicate', 'error');

    CREATE TABLE import_batches (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source              import_source NOT NULL,
      filename            text,
      dry_run             boolean NOT NULL DEFAULT true,  -- dry-run report reviewed with Brian before commit (M22)
      started_at          timestamptz NOT NULL DEFAULT now(),
      completed_at        timestamptz,
      stats               jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by_staff_id uuid REFERENCES staff(id)
    );

    CREATE TABLE import_records (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_id   uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
      source_ref text,
      raw        jsonb NOT NULL,             -- original row, kept for traceability
      status     import_record_status NOT NULL DEFAULT 'pending',
      contact_id uuid REFERENCES contacts(id),
      error      text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_import_records_batch ON import_records (batch_id, status);

    CREATE TABLE enrichment_queue (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id     uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      missing_fields text[] NOT NULL DEFAULT '{}',  -- e.g. {email, ein, entity_type, industry}
      resolved_at    timestamptz,            -- NULL = open; portal Step 1 backfill resolves these
      created_at     timestamptz NOT NULL DEFAULT now()
    );

    ------------------------------------------------------------------
    -- Grants received (minimal — Grant Tracker import target; full
    -- fundraising module with reporting obligations lands in Phase 3)
    ------------------------------------------------------------------
    CREATE TYPE grant_submission_type AS ENUM ('loi', 'application', 'proposal', 'rfp');
    CREATE TYPE grant_status          AS ENUM ('prospect', 'loi', 'in_progress', 'submitted', 'pending', 'approved', 'denied', 'ineligible');

    CREATE TABLE grants_received (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      funder            text NOT NULL,
      program           text,
      amount_cents      bigint,
      submission_type   grant_submission_type,
      lead_staff_id     uuid REFERENCES staff(id),  -- app default: Jackson
      internal_deadline date,
      hard_deadline     date,
      status            grant_status NOT NULL DEFAULT 'prospect',
      materials_link    text,
      notes             text,
      source            record_source NOT NULL DEFAULT 'native',
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE grants_received IS
      'Funder-portal CREDENTIALS never live here or in any spreadsheet — Vaultwarden only (MP Grants Received).';

    ------------------------------------------------------------------
    -- Forms as data (admin-editable selects; Form 5 modules; analytics)
    ------------------------------------------------------------------
    CREATE TYPE form_submission_status AS ENUM ('in_progress', 'submitted', 'abandoned');
    CREATE TYPE form_event_type        AS ENUM ('started', 'screen_completed', 'submitted');

    CREATE TABLE form_definitions (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key                 text NOT NULL,     -- 'soto_intake' | 'hilo_intake' | 'transition' | 'portal_onboarding' | 'service_onboarding'
      version             integer NOT NULL DEFAULT 1,
      title_en            text,
      title_es            text,
      definition          jsonb NOT NULL,    -- screens, fields, options (EN+ES), conditional logic — exactly as OF specs
      is_active           boolean NOT NULL DEFAULT true,
      updated_by_staff_id uuid REFERENCES staff(id),
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      UNIQUE (key, version)
    );
    COMMENT ON TABLE form_definitions IS
      'Forms are data: Brian edits selects (industries, services) without code (OF Build Notes).';

    CREATE TABLE onboarding_modules (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key                 text NOT NULL UNIQUE,  -- 'module_a' … 'module_i' + admin-created
      name_en             text NOT NULL,
      name_es             text,
      trigger             jsonb NOT NULL,    -- e.g. {"industry": "food_beverage"} — Module B fires on industry ALONE (v4.1 fix)
      questions           jsonb NOT NULL,    -- [{id, label_en, label_es, type, required, options[]}]
      flags               jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{flag_key, route_to_role, alert}] e.g. PLLC conversion (Module I)
      is_active           boolean NOT NULL DEFAULT true,
      sort_order          integer NOT NULL DEFAULT 0,
      updated_by_staff_id uuid REFERENCES staff(id),
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE onboarding_modules IS
      'Form 5 service-onboarding modules stored as data so the Phase 2 no-code Module Builder edits rows, not code (OF Module Builder).';

    CREATE TABLE form_submissions (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      form_key          text NOT NULL,
      form_version      integer,
      contact_id        uuid REFERENCES contacts(id),  -- linked/created on submit
      status            form_submission_status NOT NULL DEFAULT 'in_progress',
      language          language_code NOT NULL DEFAULT 'en',
      answers           jsonb NOT NULL DEFAULT '{}'::jsonb,  -- autosaved per screen (mobile users get interrupted)
      screen_reached    smallint NOT NULL DEFAULT 0,
      source            text,                -- 'public' | 'hilo_link' | 'portal' — hilo_link populates BR1–BR6
      resume_token_hash text UNIQUE,         -- resume via magic link
      started_at        timestamptz NOT NULL DEFAULT now(),
      submitted_at      timestamptz,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_form_submissions ON form_submissions (form_key, status);

    CREATE TABLE form_events (
      id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      form_key      text NOT NULL,
      submission_id uuid REFERENCES form_submissions(id) ON DELETE SET NULL,
      event         form_event_type NOT NULL,
      screen        smallint,
      occurred_at   timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE form_events IS 'Form analytics: started / completed / drop-off screen per form (OF Build Notes). No PII.';
    CREATE INDEX idx_form_events ON form_events (form_key, occurred_at);

    ------------------------------------------------------------------
    -- Portal first-login onboarding checklist (Form 4)
    ------------------------------------------------------------------
    CREATE TYPE onboarding_variant AS ENUM ('new', 'migrated');

    CREATE TABLE portal_onboarding (
      contact_id                  uuid PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
      variant                     onboarding_variant NOT NULL DEFAULT 'new',
      step_confirm_info_at        timestamptz,
      step_sign_docs_at           timestamptz,
      step_upload_prior_return_at timestamptz,  -- migrated variant: "review your documents"
      step_book_consult_at        timestamptz,  -- migrated variant: quick service-request buttons
      completed_at                timestamptz,
      created_at                  timestamptz NOT NULL DEFAULT now(),
      updated_at                  timestamptz NOT NULL DEFAULT now()
    );

    ------------------------------------------------------------------
    -- Resource library (EN/ES, both portals)
    ------------------------------------------------------------------
    CREATE TYPE resource_audience AS ENUM ('soto', 'hilo', 'both');
    CREATE TYPE resource_domain   AS ENUM ('accounting_tax', 'legal_licensing', 'operations_training', 'branding_marketing');
    CREATE TYPE resource_level    AS ENUM ('foundation', 'growth', 'scale');

    CREATE TABLE resource_library (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title_en       text NOT NULL,
      title_es       text,
      description_en text,
      description_es text,
      audience       resource_audience NOT NULL DEFAULT 'both',
      domain         resource_domain,       -- Hilo curriculum domains (nullable for Soto guides)
      level          resource_level,        -- Foundation / Growth / Scale
      resource_type  text NOT NULL DEFAULT 'guide',  -- guide | template | recording | faq | link
      document_id    uuid REFERENCES documents(id),
      url            text,
      is_published   boolean NOT NULL DEFAULT false,
      sort_order     integer NOT NULL DEFAULT 0,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now()
    );

    ------------------------------------------------------------------
    -- Admin settings (SLA windows, alert thresholds, defaults)
    ------------------------------------------------------------------
    CREATE TABLE app_settings (
      key                 text PRIMARY KEY,
      value               jsonb NOT NULL,
      description         text,
      updated_by_staff_id uuid REFERENCES staff(id),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE app_settings IS
      'Brian-configurable knobs (MP Admin Interface): SLA windows, alert thresholds, owner-comp default, backup schedule. Client-facing copy lives in templates, prices in price_book — never here.';

    CREATE TRIGGER trg_meetings_updated_at     BEFORE UPDATE ON meetings           FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_summaries_updated_at    BEFORE UPDATE ON meeting_summaries  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_tasks_updated_at        BEFORE UPDATE ON tasks              FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_time_entries_updated_at BEFORE UPDATE ON time_entries       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_grants_updated_at       BEFORE UPDATE ON grants_received    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_form_defs_updated_at    BEFORE UPDATE ON form_definitions   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_onb_modules_updated_at  BEFORE UPDATE ON onboarding_modules FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_form_subs_updated_at    BEFORE UPDATE ON form_submissions   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_portal_onb_updated_at   BEFORE UPDATE ON portal_onboarding  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_resources_updated_at    BEFORE UPDATE ON resource_library   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS app_settings;
    DROP TABLE IF EXISTS resource_library;
    DROP TYPE  IF EXISTS resource_level;
    DROP TYPE  IF EXISTS resource_domain;
    DROP TYPE  IF EXISTS resource_audience;
    DROP TABLE IF EXISTS portal_onboarding;
    DROP TYPE  IF EXISTS onboarding_variant;
    DROP TABLE IF EXISTS form_events;
    DROP TABLE IF EXISTS form_submissions;
    DROP TABLE IF EXISTS onboarding_modules;
    DROP TABLE IF EXISTS form_definitions;
    DROP TYPE  IF EXISTS form_event_type;
    DROP TYPE  IF EXISTS form_submission_status;
    DROP TABLE IF EXISTS grants_received;
    DROP TYPE  IF EXISTS grant_status;
    DROP TYPE  IF EXISTS grant_submission_type;
    DROP TABLE IF EXISTS enrichment_queue;
    DROP TABLE IF EXISTS import_records;
    DROP TABLE IF EXISTS import_batches;
    DROP TYPE  IF EXISTS import_record_status;
    DROP TYPE  IF EXISTS import_source;
    DROP TABLE IF EXISTS time_entries;
    DROP TYPE  IF EXISTS time_entry_status;
    DROP TABLE IF EXISTS tasks;
    DROP TYPE  IF EXISTS task_source;
    DROP TYPE  IF EXISTS task_status;
    DROP TABLE IF EXISTS meeting_summaries;
    DROP TABLE IF EXISTS transcripts;
    DROP TABLE IF EXISTS meetings;
    DROP TYPE  IF EXISTS recap_status;
    DROP TYPE  IF EXISTS meeting_status;
    DROP TYPE  IF EXISTS meeting_source;
    DROP TYPE  IF EXISTS meeting_type;
  `);
};
