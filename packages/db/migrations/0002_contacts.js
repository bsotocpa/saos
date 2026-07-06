/**
 * 0002 — Contacts domain: unified contact record, businesses, entity groups,
 * consents, referrals.
 *
 * Spec: MP "Unified Contact Record", MP "IRC §7216 Consent", MP "Nonprofit
 * Referral Integrity", MP v4.2 module 2 (entity groups), OF Form 1 (bridge
 * fields BR1–BR6, consents, referral attribution).
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE language_code       AS ENUM ('en', 'es');
    CREATE TYPE contact_method      AS ENUM ('phone', 'email', 'portal', 'text');
    CREATE TYPE soto_status         AS ENUM ('none', 'lead', 'active', 'inactive', 'former');
    CREATE TYPE hilo_status         AS ENUM ('none', 'awareness', 'exploring', 'active', 'referral', 'alumni', 'partner', 'inactive');
    CREATE TYPE record_source       AS ENUM ('native', 'dubsado', 'zoho');
    CREATE TYPE consent_7216_state  AS ENUM ('not_on_file', 'requested', 'signed', 'declined', 'revoked');
    CREATE TYPE letter_status       AS ENUM ('none', 'pending', 'signed');
    CREATE TYPE ssn_state           AS ENUM ('none', 'provide_by_phone', 'on_file');
    CREATE TYPE business_entity_type AS ENUM ('sole_prop', 'llc', 'pllc', 's_corp', 'c_corp', 'partnership', 'nonprofit', 'coop', 'not_sure', 'other');
    CREATE TYPE il_sos_state        AS ENUM ('unknown', 'good_standing', 'not_good_standing', 'not_found');

    ------------------------------------------------------------------
    -- Unified contact record (one record, two branded front doors)
    ------------------------------------------------------------------
    CREATE TABLE contacts (
      id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

      -- Identity (MP Unified Contact Record)
      first_name                text NOT NULL,
      last_name                 text NOT NULL,
      email                     citext,        -- NOT unique: households can share; portal_users.email is the unique login
      phone                     text,
      secondary_phone           text,
      preferred_contact_method  contact_method,
      language                  language_code NOT NULL DEFAULT 'en',  -- applied to ALL outbound communications
      address_line1             text,
      address_line2             text,
      city                      text,
      state                     text,
      zip                       text,

      -- Relationship
      soto_status               soto_status NOT NULL DEFAULT 'none',
      hilo_status               hilo_status NOT NULL DEFAULT 'none',
      client_since              date,
      hilo_first_contact        date,
      assigned_manager_id       uuid REFERENCES staff(id),

      -- Compliance rollups (source of truth: consents / tax_engagements)
      consent_7216_status       consent_7216_state NOT NULL DEFAULT 'not_on_file', -- migrated legacy clients stay 'not_on_file' until signed
      engagement_letter_status  letter_status NOT NULL DEFAULT 'none',
      -- (8879 status is per tax year — read it from tax_engagements, not here)

      -- Hilo bridge fields BR1–BR6 (hidden from cold visitors; set via Hilo transition link only)
      br1_referred_by_hilo          boolean NOT NULL DEFAULT false,
      br2_hilo_status_at_referral   text,
      br3_referred_by_jackson       boolean NOT NULL DEFAULT false,
      br4_hilo_program_participant  boolean NOT NULL DEFAULT false,
      br5_hilo_first_engagement     date,
      br6_referring_staff           text,

      -- Health score (0–100, auto: logins 20 / doc timeliness 20 / payment 20 / response 20 / tenure 20)
      health_score              smallint CHECK (health_score BETWEEN 0 AND 100),
      health_components         jsonb,
      health_computed_at        timestamptz,

      -- Referral attribution (MP Referral tracking; referrals table holds the flows)
      referred_by_contact_id    uuid REFERENCES contacts(id),
      referred_by_text          text,          -- free-text "who referred you" from intake
      cpa_network_source        text,
      how_heard                 text,

      -- Intake consents (TCPA / ESIGN — §7216 lives in consents table)
      sms_consent               boolean NOT NULL DEFAULT false,
      sms_consent_at            timestamptz,
      communication_consent_at  timestamptz,
      esign_consent_at          timestamptz,

      -- SSN handling (OF v4.2 §4): secure portal entry / provide-by-phone / on file.
      ssn_status                ssn_state NOT NULL DEFAULT 'none',
      ssn_encrypted             bytea,         -- encrypted app-side with APP_ENCRYPTION_KEY; NEVER logged, NEVER exported
      ssn_last4                 text CHECK (ssn_last4 ~ '^[0-9]{4}$'),

      source                    record_source NOT NULL DEFAULT 'native',
      source_ref                text,          -- id in the source system (Dubsado/Zoho)
      is_archived               boolean NOT NULL DEFAULT false,
      notes                     text,
      created_at                timestamptz NOT NULL DEFAULT now(),
      updated_at                timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE contacts IS
      'MP Unified Contact Record. One row per person across both entities; §7216 consent status gates every cross-entity use of tax return information.';
    COMMENT ON COLUMN contacts.ssn_encrypted IS
      'Column-level encrypted. Reads are audit-logged. No PII in logs/fixtures (CLAUDE.md).';

    CREATE INDEX idx_contacts_email   ON contacts (email);
    CREATE INDEX idx_contacts_soto    ON contacts (soto_status) WHERE soto_status <> 'none';
    CREATE INDEX idx_contacts_hilo    ON contacts (hilo_status) WHERE hilo_status <> 'none';
    CREATE INDEX idx_contacts_manager ON contacts (assigned_manager_id);
    CREATE INDEX idx_contacts_name    ON contacts (last_name, first_name);

    ------------------------------------------------------------------
    -- Businesses (a contact can own/co-own several — v4.2 entity groups)
    ------------------------------------------------------------------
    CREATE TABLE businesses (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name                  text NOT NULL,
      ein                   text,            -- business identifier; never logged (CLAUDE.md)
      entity_type           business_entity_type,
      irs_activity_code     text,            -- auto-suggested from industry (OF 2.4 NAICS mapping)
      naics_code            text,
      industry              text,            -- slug of the admin-editable industry option; drives module firing
      years_in_business     text,            -- range value from intake ('<1','1-3','3-5','5+')
      revenue_range         text,
      employees_range       text,
      zip                   text,            -- neighborhood analytics (funder reporting)
      state                 text NOT NULL DEFAULT 'IL',
      fiscal_year_end_month smallint NOT NULL DEFAULT 12 CHECK (fiscal_year_end_month BETWEEN 1 AND 12),
        -- ^ feeds the extended-deadline derivation (return type + fiscal year end — MP Tax Ops)
      il_sos_status         il_sos_state NOT NULL DEFAULT 'unknown',   -- v4.2 IL SOS compliance monitor
      il_sos_checked_at     timestamptz,
      source                record_source NOT NULL DEFAULT 'native',
      source_ref            text,
      notes                 text,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE businesses IS 'Business entities. Linked to owners via business_members; grouped via entity_groups.';

    CREATE TABLE business_members (
      business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      member_role text,                      -- 'owner', 'co-owner', … (from intake "your role")
      is_primary  boolean NOT NULL DEFAULT false,
      PRIMARY KEY (business_id, contact_id)
    );

    CREATE TABLE entity_groups (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name       text NOT NULL,              -- e.g. 'Koziura Construction + Frio Equity'
      notes      text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE entity_groups IS
      'v4.2 module 2: multiple entities + their owners as one relationship — consolidated dashboard, group sessions, cross-entity notes, group billing option.';

    CREATE TABLE entity_group_members (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id    uuid NOT NULL REFERENCES entity_groups(id) ON DELETE CASCADE,
      business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
      contact_id  uuid REFERENCES contacts(id) ON DELETE CASCADE,
      member_role text,
      CHECK ((business_id IS NULL) <> (contact_id IS NULL)),  -- exactly one of the two
      UNIQUE NULLS NOT DISTINCT (group_id, business_id, contact_id)
    );

    ------------------------------------------------------------------
    -- Consents (§7216 and friends) — one row per consent event
    ------------------------------------------------------------------
    CREATE TYPE consent_type   AS ENUM ('7216_use', '7216_disclose', 'esign', 'communication', 'sms');
    CREATE TYPE consent_status AS ENUM ('requested', 'signed', 'declined', 'revoked');
    CREATE TYPE consent_method AS ENUM ('docuseal', 'wet_signature', 'intake_checkbox');

    CREATE TABLE consents (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id     uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      type           consent_type NOT NULL,
      status         consent_status NOT NULL DEFAULT 'requested',
      method         consent_method,
      policy_version text,
      document_id    uuid,   -- FK added in 0004 (documents created there)
      envelope_id    uuid,   -- FK added in 0004 (signature_envelopes created there)
      requested_at   timestamptz NOT NULL DEFAULT now(),
      signed_at      timestamptz,
      revoked_at     timestamptz,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE consents IS
      'Consent events. contacts.consent_7216_status is the app-maintained rollup; referral engine, upsell flagging, and cross-entity data use are BLOCKED per client until a signed §7216 row exists (MP §7216 Enforcement).';
    CREATE INDEX idx_consents_contact_type ON consents (contact_id, type);

    ------------------------------------------------------------------
    -- Referrals (both directions, §7216-gated, disclosure-logged)
    ------------------------------------------------------------------
    CREATE TYPE referral_direction AS ENUM ('hilo_to_soto', 'soto_to_hilo');
    CREATE TYPE referral_status    AS ENUM ('suggested', 'pending_approval', 'approved', 'sent', 'converted', 'declined', 'expired');
    CREATE TYPE referral_source    AS ENUM ('session_summary', 'manual', 'portal_cta', 'intake', 'directory');

    CREATE TABLE referrals (
      id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id                uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      direction                 referral_direction NOT NULL,
      status                    referral_status NOT NULL DEFAULT 'suggested',
      source                    referral_source NOT NULL DEFAULT 'manual',
      suggested_by_staff_id     uuid REFERENCES staff(id),
      approved_by_staff_id      uuid REFERENCES staff(id),
      approved_at               timestamptz,
      sent_at                   timestamptz,
      -- Referral integrity (protects Hilo's exempt status / the 990):
      disclosure_shown_at       timestamptz,
      disclosure_policy_version text,
      converted_at              timestamptz,
      notes                     text,
      created_at                timestamptz NOT NULL DEFAULT now(),
      updated_at                timestamptz NOT NULL DEFAULT now(),
      -- A Hilo→Soto referral cannot reach 'sent' without the disclosure trail.
      CHECK (direction <> 'hilo_to_soto' OR status NOT IN ('sent', 'converted') OR disclosure_shown_at IS NOT NULL)
    );
    COMMENT ON TABLE referrals IS
      'MP Nonprofit Referral Integrity: every Hilo→Soto referral records that alternatives-exist disclosure was shown, with policy version and timestamp. App layer additionally blocks creation without §7216 consent when tax data is involved.';
    CREATE INDEX idx_referrals_contact ON referrals (contact_id);
    CREATE INDEX idx_referrals_queue   ON referrals (direction, status);

    CREATE TRIGGER trg_contacts_updated_at    BEFORE UPDATE ON contacts       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_businesses_updated_at  BEFORE UPDATE ON businesses     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_egroups_updated_at     BEFORE UPDATE ON entity_groups  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_consents_updated_at    BEFORE UPDATE ON consents       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_referrals_updated_at   BEFORE UPDATE ON referrals      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS referrals;
    DROP TYPE  IF EXISTS referral_source;
    DROP TYPE  IF EXISTS referral_status;
    DROP TYPE  IF EXISTS referral_direction;
    DROP TABLE IF EXISTS consents;
    DROP TYPE  IF EXISTS consent_method;
    DROP TYPE  IF EXISTS consent_status;
    DROP TYPE  IF EXISTS consent_type;
    DROP TABLE IF EXISTS entity_group_members;
    DROP TABLE IF EXISTS entity_groups;
    DROP TABLE IF EXISTS business_members;
    DROP TABLE IF EXISTS businesses;
    DROP TABLE IF EXISTS contacts;
    DROP TYPE  IF EXISTS il_sos_state;
    DROP TYPE  IF EXISTS business_entity_type;
    DROP TYPE  IF EXISTS ssn_state;
    DROP TYPE  IF EXISTS letter_status;
    DROP TYPE  IF EXISTS consent_7216_state;
    DROP TYPE  IF EXISTS record_source;
    DROP TYPE  IF EXISTS hilo_status;
    DROP TYPE  IF EXISTS soto_status;
    DROP TYPE  IF EXISTS contact_method;
    DROP TYPE  IF EXISTS language_code;
  `);
};
