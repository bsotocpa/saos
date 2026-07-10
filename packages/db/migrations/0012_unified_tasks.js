/**
 * M25 (spec v4.4): unified task & project management — the connective layer.
 * Everything here is ADDITIVE (columns + new tables); production carries no
 * task rows yet beyond automation output. The one data move: open
 * enrichment_queue rows materialize as tasks (the rule: no module-local
 * to-do lists — the queue table remains as the auto-resolution source).
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TYPE task_source ADD VALUE IF NOT EXISTS 'import';  -- Trello importer
  `);

  pgm.sql(`
    ------------------------------------------------------------------
    -- Project boards (kanban): firm projects, Brian's personal board.
    ------------------------------------------------------------------
    CREATE TABLE boards (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name           text NOT NULL,
      owner_staff_id uuid REFERENCES staff(id),   -- NULL = shared/firm board
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE board_columns (
      id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      name     text NOT NULL,
      position integer NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_board_columns_board ON board_columns (board_id, position);

    ------------------------------------------------------------------
    -- Task object extensions (v4.4 task object fields)
    ------------------------------------------------------------------
    ALTER TABLE tasks ADD COLUMN engagement_id       uuid REFERENCES engagements(id);
    ALTER TABLE tasks ADD COLUMN client_visible      boolean NOT NULL DEFAULT false;
    ALTER TABLE tasks ADD COLUMN sop_link            text;   -- "how to do this" (KB lands M27; link field now)
    ALTER TABLE tasks ADD COLUMN board_column_id     uuid REFERENCES board_columns(id) ON DELETE SET NULL;
    ALTER TABLE tasks ADD COLUMN board_position      integer;
    ALTER TABLE tasks ADD COLUMN created_by_staff_id uuid REFERENCES staff(id);
    COMMENT ON COLUMN tasks.client_visible IS
      'v4.4 client to-dos: shows on the client portal "Your to-dos" list (staff-added items; system items aggregate from doc requests/envelopes).';
    CREATE INDEX idx_tasks_board ON tasks (board_column_id, board_position) WHERE board_column_id IS NOT NULL;
    CREATE INDEX idx_tasks_client_visible ON tasks (contact_id, status) WHERE client_visible;
    CREATE INDEX idx_tasks_source ON tasks (source_type, source_id);

    CREATE TABLE task_comments (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id    uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      staff_id   uuid NOT NULL REFERENCES staff(id),
      body       text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_task_comments_task ON task_comments (task_id, created_at);

    CREATE TABLE task_checklist_items (
      id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id  uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      label    text NOT NULL,
      done     boolean NOT NULL DEFAULT false,
      position integer NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_task_checklist_task ON task_checklist_items (task_id, position);

    CREATE TABLE task_documents (
      task_id     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, document_id)
    );

    ------------------------------------------------------------------
    -- Checklist templates (tax-season opening, onboarding, month-close);
    -- instantiable per client or per season (v4.4).
    ------------------------------------------------------------------
    CREATE TABLE task_templates (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name             text NOT NULL,
      description      text,
      default_priority smallint NOT NULL DEFAULT 0,
      sop_link         text,
      items            jsonb NOT NULL DEFAULT '[]'::jsonb,  -- ["label", ...]
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now()
    );

    ------------------------------------------------------------------
    -- Lightweight time log (v4.4): minutes/start-stop on tasks and
    -- engagements; hourly work flows to invoices via rate_item_code
    -- (a PRICE BOOK item code — never a dollar literal).
    ------------------------------------------------------------------
    ALTER TABLE time_entries ADD COLUMN task_id        uuid REFERENCES tasks(id) ON DELETE SET NULL;
    ALTER TABLE time_entries ADD COLUMN engagement_id  uuid REFERENCES engagements(id);
    ALTER TABLE time_entries ADD COLUMN started_at     timestamptz;  -- running timer when hours pending
    ALTER TABLE time_entries ADD COLUMN rate_item_code text;
    ALTER TABLE time_entries ADD COLUMN invoice_id     uuid REFERENCES invoices(id);
    CREATE INDEX idx_time_entries_task ON time_entries (task_id);
    CREATE INDEX idx_time_entries_unbilled ON time_entries (contact_id)
      WHERE invoice_id IS NULL AND rate_item_code IS NOT NULL;
  `);

  // Backfill: every OPEN enrichment gap becomes a real task (idempotent —
  // the ongoing sync keys on source_type/source_id).
  pgm.sql(`
    INSERT INTO tasks (title, description, contact_id, priority, source, source_type, source_id, status)
    SELECT
      'Complete missing client info: ' || c.first_name || ' ' || c.last_name,
      'Migrated from the enrichment queue. Missing: ' || array_to_string(q.missing_fields, ', ') ||
        '. Portal first-login backfill resolves most of these automatically.',
      q.contact_id,
      0,
      'system',
      'enrichment',
      q.id::text,
      'open'
    FROM enrichment_queue q
    JOIN contacts c ON c.id = q.contact_id
    WHERE q.resolved_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM tasks t WHERE t.source_type = 'enrichment' AND t.source_id = q.id::text
      );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM tasks WHERE source_type = 'enrichment';
    ALTER TABLE time_entries
      DROP COLUMN task_id, DROP COLUMN engagement_id, DROP COLUMN started_at,
      DROP COLUMN rate_item_code, DROP COLUMN invoice_id;
    DROP TABLE task_templates;
    DROP TABLE task_documents;
    DROP TABLE task_checklist_items;
    DROP TABLE task_comments;
    ALTER TABLE tasks
      DROP COLUMN engagement_id, DROP COLUMN client_visible, DROP COLUMN sop_link,
      DROP COLUMN board_column_id, DROP COLUMN board_position, DROP COLUMN created_by_staff_id;
    DROP TABLE board_columns;
    DROP TABLE boards;

    ALTER TYPE task_source RENAME TO task_source_old;
    CREATE TYPE task_source AS ENUM ('manual', 'meeting', 'automation', 'system');
    ALTER TABLE tasks ALTER COLUMN source DROP DEFAULT;
    ALTER TABLE tasks ALTER COLUMN source TYPE task_source USING source::text::task_source;
    ALTER TABLE tasks ALTER COLUMN source SET DEFAULT 'manual';
    DROP TYPE task_source_old;
  `);
};
