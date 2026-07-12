/**
 * v4.5 addendum: task system UX at Zoho parity (docs/reference screenshots
 * are the benchmark).
 *  - Status set becomes Not Started / In Progress / Waiting for input /
 *    Completed / Deferred ('cancelled' kept as an internal terminal state).
 *    RENAME VALUE converts existing rows in place — no data rewrite.
 *  - "Waiting for input" is load-bearing: waiting_since + ladder_rung carry
 *    the D3/D7/D14/D30 escalation state per task.
 *  - Dual lookups (contact AND business), tags, reminder, recurrence,
 *    parent linkage (follow-ups/duplicates/recurrence chains).
 *  - task_views: saved views (filters + sort + columns + view type),
 *    private or shared.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TYPE task_status RENAME VALUE 'open' TO 'not_started';
    ALTER TYPE task_status RENAME VALUE 'done' TO 'completed';
    ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'waiting_for_input';
    ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'deferred';
  `);

  pgm.sql(`
    ALTER TABLE tasks ADD COLUMN business_id    uuid REFERENCES businesses(id);
    ALTER TABLE tasks ADD COLUMN tags           text[] NOT NULL DEFAULT '{}';
    ALTER TABLE tasks ADD COLUMN remind_at      timestamptz;
    ALTER TABLE tasks ADD COLUMN reminded_at    timestamptz;
    ALTER TABLE tasks ADD COLUMN recur_freq     text CHECK (recur_freq IN ('daily','weekly','monthly','quarterly','annually','custom'));
    ALTER TABLE tasks ADD COLUMN recur_interval integer NOT NULL DEFAULT 1 CHECK (recur_interval > 0);
    ALTER TABLE tasks ADD COLUMN parent_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL;
    ALTER TABLE tasks ADD COLUMN waiting_since  timestamptz;
    ALTER TABLE tasks ADD COLUMN ladder_rung    smallint NOT NULL DEFAULT 0;  -- 0 none, 1=D3, 2=D7, 3=D14, 4=D30
    COMMENT ON COLUMN tasks.waiting_since IS
      'v4.5: set when status enters waiting_for_input (or a client-visible task opens) — the D3/D7/D14/D30 escalation ladder clocks from here.';
    CREATE INDEX idx_tasks_business ON tasks (business_id) WHERE business_id IS NOT NULL;
    -- No status predicate: the ladder also clocks client-visible open tasks,
    -- and a new enum value can't be referenced in the transaction that adds it.
    CREATE INDEX idx_tasks_waiting ON tasks (waiting_since) WHERE waiting_since IS NOT NULL;
    CREATE INDEX idx_tasks_reminders ON tasks (remind_at) WHERE remind_at IS NOT NULL AND reminded_at IS NULL;
    CREATE INDEX idx_tasks_tags ON tasks USING gin (tags);

    CREATE TABLE task_views (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name           text NOT NULL,
      owner_staff_id uuid NOT NULL REFERENCES staff(id),
      shared         boolean NOT NULL DEFAULT false,
      view_type      text NOT NULL DEFAULT 'list' CHECK (view_type IN ('list','kanban','calendar','timeline')),
      filters        jsonb NOT NULL DEFAULT '{}'::jsonb,
      sort           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { field, dir }
      columns        jsonb NOT NULL DEFAULT '[]'::jsonb,   -- visible list columns
      group_by       text,                                 -- kanban group field
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_task_views_owner ON task_views (owner_staff_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE task_views;
    ALTER TABLE tasks
      DROP COLUMN business_id, DROP COLUMN tags, DROP COLUMN remind_at, DROP COLUMN reminded_at,
      DROP COLUMN recur_freq, DROP COLUMN recur_interval, DROP COLUMN parent_task_id,
      DROP COLUMN waiting_since, DROP COLUMN ladder_rung;

    UPDATE tasks SET status = 'not_started' WHERE status IN ('waiting_for_input', 'deferred');
    ALTER TYPE task_status RENAME VALUE 'not_started' TO 'open';
    ALTER TYPE task_status RENAME VALUE 'completed' TO 'done';
    ALTER TYPE task_status RENAME TO task_status_old;
    CREATE TYPE task_status AS ENUM ('open', 'in_progress', 'done', 'cancelled');
    ALTER TABLE tasks ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE tasks ALTER COLUMN status TYPE task_status USING status::text::task_status;
    ALTER TABLE tasks ALTER COLUMN status SET DEFAULT 'open';
    DROP TYPE task_status_old;
  `);
};
