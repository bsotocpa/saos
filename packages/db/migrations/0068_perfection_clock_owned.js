/*
 * A PERFECTION CLOCK CANNOT RUN UNOWNED (#48, Brian's ruling 2026-08-17: "that's a statutory
 * deadline, same tier as the deadline table").
 *
 * The perfection window is the IRS's, not ours. A rejected return re-filed inside it keeps its
 * ORIGINAL filing date; miss the window and the return is late, with penalties and interest
 * dated from the original due date. Five days for a 1040, ten for a business return.
 *
 * What I found while confirming the transaction fix covered this: it did not.
 * `recordEfileResult` resolved the task owner with `firstActiveByRole('tax_preparer')`, which
 * has no fallback, and nobody currently holds that role — so the task was created UNASSIGNED
 * and the alert, gated on `if (owner)`, never fired. The clock started and nobody was told.
 * Wrapping the branch in a transaction made the clock and the task land TOGETHER, which
 * happily included "together with no owner".
 *
 * The service now uses `ownerForRole` (falls back to Brian). This makes the pairing
 * structural, because the service being right today is not the same as it being right after
 * the next edit — the same argument as the withdrawn-reason and terminal-date constraints.
 *
 * A DEFERRED CONSTRAINT TRIGGER, not a CHECK: the rule spans two tables, and the task is
 * inserted AFTER the deadline is stamped. Checked at COMMIT, both halves exist (or neither
 * does), which is exactly the window the transaction work created and the only point where
 * this question has a meaningful answer.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE FUNCTION perfection_clock_must_be_owned() RETURNS trigger AS $$
    DECLARE
      owning_tasks int;
    BEGIN
      -- Only a LIVE clock needs an owner. Clearing it (a successful re-file) is the resolution.
      IF NEW.perfection_deadline IS NULL THEN
        RETURN NULL;
      END IF;

      SELECT count(*) INTO owning_tasks
        FROM tasks t
       WHERE t.source_type = 'efile_reject'
         AND t.source_id = NEW.id::text
         AND t.status <> ALL (ARRAY['completed', 'cancelled']::task_status[]);

      IF owning_tasks = 0 THEN
        RAISE EXCEPTION
          'perfection clock on tax engagement % has no open owning task — a statutory deadline cannot run unwatched. Create the efile_reject task in the same transaction that sets perfection_deadline.',
          NEW.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;

      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;

    CREATE CONSTRAINT TRIGGER trg_perfection_clock_owned
      AFTER INSERT OR UPDATE OF perfection_deadline ON tax_engagements
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION perfection_clock_must_be_owned();

    COMMENT ON FUNCTION perfection_clock_must_be_owned() IS
      '#48: a live perfection_deadline requires an open efile_reject task. Deferred to COMMIT because the task is written after the deadline, and because the pair is what matters rather than the order.';
  `);

  /*
   * Any clock already running unowned would make the constraint unenforceable on the next
   * touch of that row, so it is repaired now rather than left as a trap. Zero rows in
   * production today — the first IRS rejection has not happened — but a migration that only
   * works on an empty table is a migration nobody has thought about.
   */
  pgm.sql(`
    DO $backfill$
    DECLARE
      orphan record;
      owner_id uuid;
      n int := 0;
    BEGIN
      SELECT st.id INTO owner_id
        FROM staff st JOIN roles r ON r.id = st.role_id
       WHERE r.key = 'tax_preparer' AND st.is_active ORDER BY st.created_at LIMIT 1;
      IF owner_id IS NULL THEN
        SELECT st.id INTO owner_id
          FROM staff st JOIN roles r ON r.id = st.role_id
         WHERE r.key = 'ceo' AND st.is_active ORDER BY st.created_at LIMIT 1;
      END IF;

      FOR orphan IN
        SELECT te.id, te.perfection_deadline, te.tax_year, te.return_type, e.contact_id,
               c.first_name, c.last_name
          FROM tax_engagements te
          JOIN engagements e ON e.id = te.engagement_id
          JOIN contacts c ON c.id = e.contact_id
         WHERE te.perfection_deadline IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM tasks t
              WHERE t.source_type = 'efile_reject' AND t.source_id = te.id::text
                AND t.status <> ALL (ARRAY['completed', 'cancelled']::task_status[])
           )
      LOOP
        INSERT INTO tasks (title, description, assigned_staff_id, contact_id, due_date,
                           priority, source, source_type, source_id)
        VALUES (
          'E-file REJECTED: ' || orphan.first_name || ' ' || orphan.last_name || ' ' ||
            orphan.tax_year || ' ' || upper(orphan.return_type::text) || ' — fix & re-file by ' ||
            orphan.perfection_deadline,
          'Recovered by migration 0068: this perfection clock was running with no owning task, ' ||
            'so nobody had been told. Re-file inside the window to keep the original filing date.',
          owner_id, orphan.contact_id, orphan.perfection_deadline,
          1, 'automation', 'efile_reject', orphan.id::text
        );
        n := n + 1;
      END LOOP;
      IF n > 0 THEN
        RAISE WARNING '0068: adopted % unowned perfection clock(s)', n;
      END IF;
    END
    $backfill$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_perfection_clock_owned ON tax_engagements;
    DROP FUNCTION IF EXISTS perfection_clock_must_be_owned();
  `);
};
