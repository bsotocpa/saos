/**
 * Master + Schedules legal architecture (SOTO_Legal_Text_Package_FINAL_v3).
 *
 * Replaces five standalone engagement letters with ONE Master Engagement
 * Agreement plus Service Schedules A–E. From Master §1:
 *
 *   "Your signature below constitutes acceptance of this Agreement and every
 *    Service Schedule attached at signing. Services added later are engaged by
 *    your electronic acceptance of the applicable Schedule through the client
 *    portal, without re-execution of this Agreement."
 *
 * That sentence is the whole data model, so it is enforced rather than described:
 *
 *  · ONE master acceptance per client, ever. A second Master signature is a
 *    mistake, so a partial unique index makes it impossible.
 *  · EVERY schedule acceptance records HOW it was accepted — by the Master
 *    signature or by later portal acceptance — because "did this client actually
 *    agree to bookkeeping terms" must be answerable per service, not inferred.
 *  · A schedule cannot be accepted before the Master, since it incorporates it.
 *
 * Also here: `needs_es_review`. v3 states "English text controls; Spanish
 * translations to follow." Until Brian approves a translation, the Spanish body
 * is not something we can put in front of a client — so the flag exists, the send
 * path honours it, and English is used instead of unapproved Spanish.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE template_kind AS ENUM ('master', 'schedule', 'consent', 'operational');
    CREATE TYPE acceptance_via AS ENUM ('master_signature', 'portal_acceptance');

    ALTER TABLE templates
      ADD COLUMN kind          template_kind NOT NULL DEFAULT 'operational',
      -- Retiring the five old letters without deleting them: they are the terms
      -- some historical engagement was signed under, and that record matters.
      ADD COLUMN is_active     boolean NOT NULL DEFAULT true,
      ADD COLUMN retired_at    timestamptz,
      ADD COLUMN retired_reason text,
      -- 'A'..'E' for schedules; NULL for everything else.
      ADD COLUMN schedule_code text CHECK (schedule_code IS NULL OR schedule_code ~ '^[A-E]$'),
      -- English controls. TRUE means the Spanish body is absent or unapproved and
      -- must not be sent to a client.
      ADD COLUMN needs_es_review boolean NOT NULL DEFAULT false,
      ADD COLUMN es_approved_by_staff_id uuid REFERENCES staff(id),
      ADD COLUMN es_approved_at timestamptz,
      ADD CONSTRAINT templates_schedule_code_only_on_schedules CHECK (
        (kind = 'schedule') = (schedule_code IS NOT NULL)
      ),
      ADD CONSTRAINT templates_es_approval_recorded CHECK (
        needs_es_review OR es_approved_at IS NULL OR es_approved_by_staff_id IS NOT NULL
      );

    COMMENT ON COLUMN templates.needs_es_review IS
      'v3: English text controls, Spanish to follow. TRUE = do not send the Spanish body; the render path falls back to English and records that it did.';
    COMMENT ON COLUMN templates.is_active IS
      'Retired templates stay for the record — they are the terms a past engagement was signed under.';

    CREATE UNIQUE INDEX idx_templates_schedule_code ON templates (schedule_code)
      WHERE schedule_code IS NOT NULL AND is_active;

    -- Which service lines each schedule covers. Data, not a code switch, so
    -- adding a service line to a schedule is an admin edit.
    CREATE TABLE service_schedules (
      schedule_code text PRIMARY KEY CHECK (schedule_code ~ '^[A-E]$'),
      template_key  text NOT NULL REFERENCES templates(key),
      title         text NOT NULL,
      service_lines service_line[] NOT NULL,
      sort_order    integer NOT NULL DEFAULT 0,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE service_schedules IS
      'service_line → Schedule A–E. A line with no schedule is REFUSED at packet assembly rather than silently attached to the wrong terms (attest has no v3 schedule).';

    -- One packet per signing event: the Master plus the schedules attached at
    -- signing, as one Docuseal envelope.
    CREATE TABLE engagement_packets (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id          uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      master_template_key text NOT NULL REFERENCES templates(key),
      master_version      integer NOT NULL,
      schedule_codes      text[] NOT NULL,
      envelope_id         uuid REFERENCES signature_envelopes(id),
      status              text NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'sent', 'signed', 'void')),
      sent_at             timestamptz,
      signed_at           timestamptz,
      created_by_staff_id uuid REFERENCES staff(id),
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      CHECK (array_length(schedule_codes, 1) >= 1),
      CHECK (status <> 'signed' OR signed_at IS NOT NULL)
    );
    CREATE TRIGGER trg_engagement_packets_updated_at BEFORE UPDATE ON engagement_packets
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE INDEX idx_engagement_packets_contact ON engagement_packets (contact_id, created_at DESC);

    -- ONE signed Master per client, ever. Master §1 says later services need no
    -- re-execution, so a second signed packet means something went wrong.
    CREATE UNIQUE INDEX idx_one_signed_master_per_contact
      ON engagement_packets (contact_id) WHERE status = 'signed';

    CREATE TABLE schedule_acceptances (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id    uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      schedule_code text NOT NULL REFERENCES service_schedules(schedule_code),
      -- HOW it was accepted is the audit question that matters.
      via           acceptance_via NOT NULL,
      packet_id     uuid REFERENCES engagement_packets(id),
      template_version integer NOT NULL,
      accepted_at   timestamptz NOT NULL DEFAULT now(),
      ip            text,
      user_agent    text,
      UNIQUE (contact_id, schedule_code),
      -- A signature-based acceptance must point at the packet that carried it.
      CHECK (via <> 'master_signature' OR packet_id IS NOT NULL)
    );
    COMMENT ON TABLE schedule_acceptances IS
      'Per-service agreement. One row per (client, schedule) recording whether it came in on the Master signature or by later portal acceptance, and which template version they agreed to.';
    CREATE INDEX idx_schedule_acceptances_contact ON schedule_acceptances (contact_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE schedule_acceptances;
    DROP INDEX IF EXISTS idx_one_signed_master_per_contact;
    DROP TABLE engagement_packets;
    DROP TABLE service_schedules;
    DROP INDEX IF EXISTS idx_templates_schedule_code;
    ALTER TABLE templates
      DROP CONSTRAINT templates_es_approval_recorded,
      DROP CONSTRAINT templates_schedule_code_only_on_schedules,
      DROP COLUMN es_approved_at,
      DROP COLUMN es_approved_by_staff_id,
      DROP COLUMN needs_es_review,
      DROP COLUMN schedule_code,
      DROP COLUMN retired_reason,
      DROP COLUMN retired_at,
      DROP COLUMN is_active,
      DROP COLUMN kind;
    DROP TYPE acceptance_via;
    DROP TYPE template_kind;
  `);
};
