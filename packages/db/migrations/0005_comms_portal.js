/**
 * 0005 — Templates (bilingual, placeholder-gated), portal message threads,
 * notifications/alerts, and client portal auth (magic links).
 *
 * Spec: MP "Communication System → Templates", MP "§7216 Consent" (PLACEHOLDER
 * launch gate), MP "Client Portal → Auth" (magic link, bounce fallback),
 * MP "Dashboards → Alert Center", CLAUDE.md (copy changes never require a
 * code deploy → templates are fully DB-driven).
 */

exports.up = (pgm) => {
  pgm.sql(`
    ------------------------------------------------------------------
    -- Templates: ALL client-facing copy, EN + ES, admin-editable
    ------------------------------------------------------------------
    CREATE TYPE template_channel AS ENUM ('email', 'sms', 'portal', 'document');

    CREATE TABLE templates (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key                 text NOT NULL UNIQUE,   -- stable machine key, e.g. 'engagement_letter_tax'
      name                text NOT NULL,
      channel             template_channel NOT NULL,
      subject_en          text,
      subject_es          text,
      body_en             text NOT NULL,
      body_es             text,                   -- nullable while drafting; launch gate checks completeness
      is_placeholder      boolean NOT NULL DEFAULT false,
      variables           jsonb NOT NULL DEFAULT '[]'::jsonb,  -- documented merge variables, e.g. ["client_name","deadline"]
      version             integer NOT NULL DEFAULT 1,
      updated_by_staff_id uuid REFERENCES staff(id),
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE templates IS
      'All outbound copy lives here (EN+ES), admin-editable — copy changes never require a deploy.';
    COMMENT ON COLUMN templates.is_placeholder IS
      'LAUNCH GATE (MP §7216, CLAUDE.md non-negotiable): while true, this template is BLOCKED from being sent to any production client. Brian drops in final legal language via admin, clears the flag, and only then can it send. The gate is enforced in the send path (M11) — never remove it.';

    ------------------------------------------------------------------
    -- Portal message threads (Phase 1: portal + outbound email; SMS/voice
    -- join in Phase 2 via the unified inbox — same tables, more channels)
    ------------------------------------------------------------------
    CREATE TYPE message_channel   AS ENUM ('portal', 'email', 'sms', 'system');
    CREATE TYPE message_direction AS ENUM ('inbound', 'outbound');
    CREATE TYPE sender_type       AS ENUM ('staff', 'client', 'system');
    CREATE TYPE delivery_status   AS ENUM ('queued', 'sent', 'delivered', 'bounced', 'failed');
    CREATE TYPE thread_status     AS ENUM ('open', 'closed', 'archived');

    CREATE TABLE message_threads (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id      uuid NOT NULL REFERENCES contacts(id),
      subject         text,
      status          thread_status NOT NULL DEFAULT 'open',
      last_message_at timestamptz,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE message_threads IS
      'One conversation history per client regardless of channel (MP: history never fragments).';
    CREATE INDEX idx_threads_contact ON message_threads (contact_id, last_message_at DESC);

    CREATE TABLE messages (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id       uuid NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
      direction       message_direction NOT NULL,
      channel         message_channel NOT NULL DEFAULT 'portal',
      sender_type     sender_type NOT NULL,
      sender_staff_id uuid REFERENCES staff(id),
      body            text NOT NULL,
      template_key    text,                  -- set when rendered from a template
      language        language_code,         -- language the message was sent in
      delivery_status delivery_status,       -- outbound only; 'bounced' triggers the Rene fallback task
      external_ref    text,                  -- SES message id, etc.
      sent_at         timestamptz NOT NULL DEFAULT now(),
      read_at         timestamptz,
      created_at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_messages_thread ON messages (thread_id, sent_at);

    ------------------------------------------------------------------
    -- Notifications (staff alerts; ntfy push mirrors 'push' channel)
    ------------------------------------------------------------------
    CREATE TYPE notification_severity AS ENUM ('info', 'warning', 'critical');

    CREATE TABLE notifications (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      staff_id            uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      type                text NOT NULL,     -- alert key, e.g. 'irs_notice_unactioned_48h'
      severity            notification_severity NOT NULL DEFAULT 'info',
      title               text NOT NULL,
      body                text,
      contact_id          uuid REFERENCES contacts(id),
      related_object_type text,
      related_object_id   text,
      read_at             timestamptz,
      pushed_at           timestamptz,       -- ntfy delivery timestamp (Brian + Jackson, iPhone)
      created_at          timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_notifications_staff ON notifications (staff_id, read_at, created_at DESC);

    ------------------------------------------------------------------
    -- Client portal auth: magic link first, optional password, optional MFA
    ------------------------------------------------------------------
    CREATE TABLE portal_users (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      contact_id      uuid NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
      email           citext NOT NULL UNIQUE,   -- the magic-link address (contact email at creation)
      password_hash   text,                     -- optional, set after first login
      totp_secret_enc bytea,                    -- MFA optional for clients (required for staff)
      totp_enabled    boolean NOT NULL DEFAULT false,
      is_active       boolean NOT NULL DEFAULT true,
      last_login_at   timestamptz,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE portal_users IS
      'Clients see only their own records — every portal query is scoped by contact_id (fails closed, tested in M5).';

    CREATE TYPE magic_link_purpose AS ENUM ('login', 'form_resume', 'signature');

    CREATE TABLE magic_link_tokens (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
      token_hash     text NOT NULL UNIQUE,   -- single-use; only the hash stored
      purpose        magic_link_purpose NOT NULL DEFAULT 'login',
      expires_at     timestamptz NOT NULL,
      used_at        timestamptz,            -- set on redemption; reuse fails
      created_ip     inet,
      used_ip        inet,
      created_at     timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE magic_link_tokens IS
      'Bounced delivery of a magic link creates a verification task for Rene (MP Portal Auth bounce fallback).';
    CREATE INDEX idx_magic_links_user ON magic_link_tokens (portal_user_id);

    CREATE TABLE portal_sessions (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      portal_user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
      token_hash     text NOT NULL UNIQUE,
      ip             inet,
      user_agent     text,
      created_at     timestamptz NOT NULL DEFAULT now(),
      expires_at     timestamptz NOT NULL,
      revoked_at     timestamptz
    );
    CREATE INDEX idx_portal_sessions_user ON portal_sessions (portal_user_id);

    CREATE TRIGGER trg_templates_updated_at    BEFORE UPDATE ON templates       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_threads_updated_at      BEFORE UPDATE ON message_threads FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER trg_portal_users_updated_at BEFORE UPDATE ON portal_users    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS portal_sessions;
    DROP TABLE IF EXISTS magic_link_tokens;
    DROP TYPE  IF EXISTS magic_link_purpose;
    DROP TABLE IF EXISTS portal_users;
    DROP TABLE IF EXISTS notifications;
    DROP TYPE  IF EXISTS notification_severity;
    DROP TABLE IF EXISTS messages;
    DROP TABLE IF EXISTS message_threads;
    DROP TYPE  IF EXISTS thread_status;
    DROP TYPE  IF EXISTS delivery_status;
    DROP TYPE  IF EXISTS sender_type;
    DROP TYPE  IF EXISTS message_direction;
    DROP TYPE  IF EXISTS message_channel;
    DROP TABLE IF EXISTS templates;
    DROP TYPE  IF EXISTS template_channel;
  `);
};
