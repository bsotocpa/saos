/**
 * v4.6: task dependencies are first-class. A task may be "blocked by" other
 * tasks; blocked tasks cannot complete before their blockers, and a blocker
 * reaching a terminal state cascades unblock notifications. The resolution
 * lane (M26.5) chains per-year engagements oldest-year-first on top of this.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE task_dependencies (
      blocked_task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      blocker_task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      created_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (blocked_task_id, blocker_task_id),
      CHECK (blocked_task_id <> blocker_task_id)
    );
    CREATE INDEX idx_task_deps_blocker ON task_dependencies (blocker_task_id);
    COMMENT ON TABLE task_dependencies IS
      'v4.6 "blocked by" relations. Cycle prevention is enforced in the service layer (graph walk on insert).';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE task_dependencies;`);
};
