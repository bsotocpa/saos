/**
 * Recurring engagement configurator (v4.2 Service Delivery Model) — and the
 * home of the S CORP SESSION FLOOR, which CLAUDE.md names as non-negotiable:
 * "the engagement configurator must not allow an active S corp client below
 * 2 CPA sessions/year."
 *
 * Two independent dials, per the spec:
 *   Dial 1 — prep cadence:    how often books close / statements compile
 *   Dial 2 — session cadence: how often the client sits with Brian
 * plus a per-service scope ladder rung.
 *
 * The floor lives in code, not in this table, and deliberately so: a
 * configuration that violates it can never be WRITTEN, so there is no column
 * here to switch it off. `s_corp_floor_applied` records that the floor was
 * evaluated and bound on this engagement — it is evidence, not a toggle.
 *
 * sessions_per_year is STORED even though it derives from session_cadence.
 * That is on purpose: it is the entitlement the utilization report compares
 * against, and it makes "below the floor" answerable in SQL without teaching
 * every query the cadence table.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE prep_cadence    AS ENUM ('weekly', 'monthly', 'quarterly', 'semi_annual');
    CREATE TYPE session_cadence AS ENUM ('weekly', 'biweekly', 'monthly', 'quarterly', 'semi_annual', 'annual');
    CREATE TYPE scope_rung      AS ENUM ('registration_setup', 'review_audit', 'admin_training', 'full_management');

    ALTER TABLE engagements
      ADD COLUMN prep_cadence         prep_cadence,
      ADD COLUMN session_cadence      session_cadence,
      -- Derived from session_cadence at configure time; the entitlement the
      -- utilization report measures against.
      ADD COLUMN sessions_per_year    integer CHECK (sessions_per_year IS NULL OR sessions_per_year > 0),
      ADD COLUMN scope_rung           scope_rung,
      -- Maintenance mode (spec): keep prep cadence, reduce session cadence.
      -- Presented to the client as a positive state, not a downgrade.
      ADD COLUMN maintenance_mode     boolean NOT NULL DEFAULT false,
      ADD COLUMN maintenance_mode_at  timestamptz,
      -- Evidence that the S corp floor bound this configuration. NOT a switch.
      ADD COLUMN s_corp_floor_applied boolean NOT NULL DEFAULT false,
      ADD COLUMN configured_at        timestamptz,
      ADD COLUMN configured_by_staff_id uuid REFERENCES staff(id),
      -- Both dials set, or neither: a half-configured recurring engagement
      -- would price wrong and schedule nothing.
      ADD CONSTRAINT engagements_cadence_pair
        CHECK ((prep_cadence IS NULL) = (session_cadence IS NULL)),
      -- sessions_per_year travels with the session dial.
      ADD CONSTRAINT engagements_sessions_derived
        CHECK ((session_cadence IS NULL) = (sessions_per_year IS NULL));

    COMMENT ON COLUMN engagements.sessions_per_year IS
      'Configured CPA sessions per year, derived from session_cadence. An active S corp can never be below 2 (CLAUDE.md hard rule, enforced in the configurator).';
    COMMENT ON COLUMN engagements.s_corp_floor_applied IS
      'True when the S corp session floor was evaluated and bound this configuration. Evidence for the file — never a way to disable the floor.';

    CREATE INDEX idx_engagements_recurring ON engagements (session_cadence, sessions_per_year)
      WHERE session_cadence IS NOT NULL;

    CREATE TABLE engagement_config_history (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      engagement_id       uuid NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
      prep_cadence        prep_cadence NOT NULL,
      session_cadence     session_cadence NOT NULL,
      sessions_per_year   integer NOT NULL,
      scope_rung          scope_rung,
      maintenance_mode    boolean NOT NULL DEFAULT false,
      s_corp_floor_applied boolean NOT NULL DEFAULT false,
      monthly_equivalent_cents integer,
      price_book_version_id uuid REFERENCES price_book_versions(id),
      changed_by_staff_id uuid REFERENCES staff(id),
      note                text,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_engagement_config_history ON engagement_config_history (engagement_id, created_at DESC);
    COMMENT ON TABLE engagement_config_history IS
      'Every configuration change, so a cadence downgrade is answerable later: who reduced it, when, and what the floor did.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE engagement_config_history;
    DROP INDEX IF EXISTS idx_engagements_recurring;
    ALTER TABLE engagements
      DROP CONSTRAINT engagements_sessions_derived,
      DROP CONSTRAINT engagements_cadence_pair,
      DROP COLUMN configured_by_staff_id,
      DROP COLUMN configured_at,
      DROP COLUMN s_corp_floor_applied,
      DROP COLUMN maintenance_mode_at,
      DROP COLUMN maintenance_mode,
      DROP COLUMN scope_rung,
      DROP COLUMN sessions_per_year,
      DROP COLUMN session_cadence,
      DROP COLUMN prep_cadence;
    DROP TYPE scope_rung;
    DROP TYPE session_cadence;
    DROP TYPE prep_cadence;
  `);
};
