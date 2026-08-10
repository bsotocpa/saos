/**
 * Schedule F — attest services (SOTO_Schedule_F_Attest_FINALFORM).
 *
 * Schedule F carries the STANDING attest terms. What makes an attest engagement
 * properly agreed is the PER-ENGAGEMENT Addendum, and that is a professional-
 * standards requirement, not paperwork:
 *
 *   AU-C 210 (audits) and AR-C 90 (reviews) require the engagement's terms —
 *   the entity, the statements and period, the reporting framework, and the fee
 *   — to be agreed for EACH engagement before work begins.
 *
 * So the Addendum is modelled as a row with a completeness CHECK rather than a
 * form we hope somebody fills in. An attest packet cannot be assembled from an
 * incomplete Addendum, and the database is what says so.
 *
 * Fee fields are PINNED FROM THE PRICE BOOK at Addendum creation (the same
 * price-lock pattern quotes and engagements use) — never typed in free-hand, and
 * never a literal in code.
 *
 * Deliberately NOT touched here: the independence gate. Active bookkeeping /
 * payroll / management services still block attest engagement creation absent
 * Brian's documented override (engagements/service.ts). Schedule F loading does
 * not loosen that by one inch — its own Independence section says the same thing.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE attest_engagement_type AS ENUM ('review', 'audit', 'insurance_wc');
    CREATE TYPE attest_fee_basis       AS ENUM ('fixed', 'hourly');

    -- Schedule F may carry a schedule_code, so widen the A–E constraints.
    ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_schedule_code_check;
    ALTER TABLE templates
      ADD CONSTRAINT templates_schedule_code_check
      CHECK (schedule_code IS NULL OR schedule_code ~ '^[A-F]$');

    ALTER TABLE service_schedules DROP CONSTRAINT IF EXISTS service_schedules_schedule_code_check;
    ALTER TABLE service_schedules
      ADD CONSTRAINT service_schedules_schedule_code_check
      CHECK (schedule_code ~ '^[A-F]$');

    -- The per-engagement agreed terms. One per attest engagement.
    CREATE TABLE attest_addenda (
      id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      engagement_id          uuid NOT NULL UNIQUE REFERENCES engagements(id) ON DELETE CASCADE,
      contact_id             uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

      -- Entity: the FK when the business is on file, and always the name as it
      -- will be printed, because the Addendum is a document.
      entity_business_id     uuid REFERENCES businesses(id),
      entity_name            text NOT NULL CHECK (length(btrim(entity_name)) > 1),

      engagement_type        attest_engagement_type NOT NULL,
      statements_and_periods text NOT NULL CHECK (length(btrim(statements_and_periods)) > 3),
      reporting_framework    text NOT NULL CHECK (length(btrim(reporting_framework)) > 1),

      -- Fee, pinned from the price book at creation.
      price_book_version_id  uuid NOT NULL REFERENCES price_book_versions(id),
      fee_item_code          text NOT NULL,
      fee_basis              attest_fee_basis NOT NULL,
      fee_fixed_cents        integer CHECK (fee_fixed_cents IS NULL OR fee_fixed_cents >= 0),
      fee_hourly_rate_cents  integer CHECK (fee_hourly_rate_cents IS NULL OR fee_hourly_rate_cents >= 0),
      estimated_hours        numeric(6,2) CHECK (estimated_hours IS NULL OR estimated_hours > 0),
      deposit_cents          integer NOT NULL CHECK (deposit_cents >= 0),

      expected_report_date   date NOT NULL,

      created_by_staff_id    uuid REFERENCES staff(id),
      created_at             timestamptz NOT NULL DEFAULT now(),
      updated_at             timestamptz NOT NULL DEFAULT now(),

      -- AU-C 210 / AR-C 90: the fee is agreed as EITHER a fixed fee OR an hourly
      -- rate with an estimate. "Hourly, hours unknown" is not agreed terms.
      CONSTRAINT attest_addenda_fee_agreed CHECK (
        (fee_basis = 'fixed'
           AND fee_fixed_cents IS NOT NULL
           AND fee_hourly_rate_cents IS NULL
           AND estimated_hours IS NULL)
        OR
        (fee_basis = 'hourly'
           AND fee_hourly_rate_cents IS NOT NULL
           AND estimated_hours IS NOT NULL
           AND fee_fixed_cents IS NULL)
      )
    );
    COMMENT ON TABLE attest_addenda IS
      'Per-engagement attest terms (AU-C 210 / AR-C 90). Completeness is a CHECK, not a convention: packet assembly refuses an attest engagement without a complete Addendum.';

    CREATE TRIGGER trg_attest_addenda_updated_at BEFORE UPDATE ON attest_addenda
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE INDEX idx_attest_addenda_contact ON attest_addenda (contact_id);

    -- The packet carries the Addendum that was signed with it.
    ALTER TABLE engagement_packets
      ADD COLUMN attest_addendum_id uuid REFERENCES attest_addenda(id);
    COMMENT ON COLUMN engagement_packets.attest_addendum_id IS
      'Set when Schedule F rides in this packet: Master + Schedule F + this Addendum, one signature.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE engagement_packets DROP COLUMN attest_addendum_id;
    DROP TABLE attest_addenda;
    ALTER TABLE service_schedules DROP CONSTRAINT service_schedules_schedule_code_check;
    ALTER TABLE service_schedules
      ADD CONSTRAINT service_schedules_schedule_code_check CHECK (schedule_code ~ '^[A-E]$');
    ALTER TABLE templates DROP CONSTRAINT templates_schedule_code_check;
    ALTER TABLE templates
      ADD CONSTRAINT templates_schedule_code_check
      CHECK (schedule_code IS NULL OR schedule_code ~ '^[A-E]$');
    DROP TYPE attest_fee_basis;
    DROP TYPE attest_engagement_type;
  `);
};
