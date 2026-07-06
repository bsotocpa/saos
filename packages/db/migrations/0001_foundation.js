/**
 * 0001 — Foundation: extensions, helper functions, staff/RBAC, audit log.
 *
 * Spec: MP "Team & Access" (roles), MP "Compliance Layer / WISP-Grade
 * Security" (MFA on all staff accounts, immutable audit log, lockout).
 */

exports.up = (pgm) => {
  pgm.sql(`
    -- citext: case-insensitive emails without lower() gymnastics.
    CREATE EXTENSION IF NOT EXISTS citext;

    -- Shared trigger: keep updated_at honest on every mutable table.
    CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    -- Shared trigger: makes a table append-only (used by audit_log).
    CREATE FUNCTION forbid_row_change() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION '% is append-only: % not allowed', TG_TABLE_NAME, TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    ------------------------------------------------------------------
    -- Roles & permissions (RBAC, least privilege)
    ------------------------------------------------------------------
    CREATE TABLE roles (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key         text NOT NULL UNIQUE,     -- stable machine key, e.g. 'ceo'
      name        text NOT NULL,            -- display name
      description text,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE roles IS
      'Staff roles per MP Team & Access. Seeded with the 8 current roles plus the future ones (client_success, advisory_manager) so permission levels exist now.';

    CREATE TABLE role_permissions (
      role_id    uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission text NOT NULL,             -- e.g. 'contacts.read', 'pricing.edit'
      PRIMARY KEY (role_id, permission)
    );
    COMMENT ON TABLE role_permissions IS
      'Permission grants per role. RBAC middleware (M4) checks these; UI hides what a role cannot do.';

    ------------------------------------------------------------------
    -- Staff accounts
    ------------------------------------------------------------------
    CREATE TABLE staff (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      full_name          text NOT NULL,
      email              citext NOT NULL UNIQUE,
      phone              text,
      role_id            uuid NOT NULL REFERENCES roles(id),
      is_active          boolean NOT NULL DEFAULT true,
      -- Credentials land in M4; columns exist now so auth needs no schema change.
      password_hash      text,
      totp_secret_enc    bytea,             -- encrypted with APP_ENCRYPTION_KEY; MFA REQUIRED for staff (WISP)
      totp_enabled       boolean NOT NULL DEFAULT false,
      failed_login_count integer NOT NULL DEFAULT 0,
      locked_until       timestamptz,       -- failed-login lockout (WISP)
      last_login_at      timestamptz,
      notes              text,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE staff IS 'Internal team accounts. MFA required (enforced at login, M4).';
    COMMENT ON COLUMN staff.totp_secret_enc IS 'Never stored in plaintext; encrypted app-side. Never logged.';

    CREATE TRIGGER trg_roles_updated_at BEFORE UPDATE ON roles
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_staff_updated_at BEFORE UPDATE ON staff
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE staff_sessions (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      staff_id   uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,      -- only the hash is stored, never the token
      ip         inet,
      user_agent text,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,      -- session timeout (WISP)
      revoked_at timestamptz
    );
    CREATE INDEX idx_staff_sessions_staff ON staff_sessions (staff_id);

    ------------------------------------------------------------------
    -- Audit log (immutable, exportable — FTC Safeguards Rule)
    ------------------------------------------------------------------
    CREATE TYPE audit_actor_type AS ENUM ('staff', 'client', 'system');

    CREATE TABLE audit_log (
      id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      actor_type  audit_actor_type NOT NULL,
      actor_id    uuid,                     -- staff.id or portal_users.id; NULL for system
      actor_label text,                     -- denormalized name/email snapshot (rows must stand alone forever)
      action      text NOT NULL,            -- dotted verb, e.g. 'document.download', 'permission.change'
      object_type text,                     -- e.g. 'document', 'contact', 'tax_engagement'
      object_id   text,
      contact_id  uuid,                     -- deliberately NO foreign key: audit rows must never
                                            -- block or be touched by contact lifecycle changes
      ip          inet,
      user_agent  text,
      details     jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    COMMENT ON TABLE audit_log IS
      'Every view/download/edit of a client document or PII field, and every permission change (who, what, when, from where). Append-only by trigger; exportable for the WISP security summary.';
    COMMENT ON COLUMN audit_log.details IS
      'Structured context. NEVER contains document contents, SSNs, EINs, or DOBs — identifiers and metadata only (no-PII-in-logs rule).';

    CREATE TRIGGER trg_audit_log_append_only
      BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION forbid_row_change();

    CREATE INDEX idx_audit_log_occurred ON audit_log (occurred_at DESC);
    CREATE INDEX idx_audit_log_contact  ON audit_log (contact_id, occurred_at DESC);
    CREATE INDEX idx_audit_log_object   ON audit_log (object_type, object_id);
    CREATE INDEX idx_audit_log_actor    ON audit_log (actor_type, actor_id);
    CREATE INDEX idx_audit_log_action   ON audit_log (action);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS audit_log;
    DROP TYPE  IF EXISTS audit_actor_type;
    DROP TABLE IF EXISTS staff_sessions;
    DROP TABLE IF EXISTS staff;
    DROP TABLE IF EXISTS role_permissions;
    DROP TABLE IF EXISTS roles;
    DROP FUNCTION IF EXISTS forbid_row_change();
    DROP FUNCTION IF EXISTS set_updated_at();
    DROP EXTENSION IF EXISTS citext;
  `);
};
