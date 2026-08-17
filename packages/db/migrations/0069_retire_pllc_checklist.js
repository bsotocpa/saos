/*
 * RETIRE `pllc_conversions.checklist` (Brian's ruling 2026-08-17).
 *
 * CLAUDE.md: "Every work item in every module IS a task object in the unified task system — no
 * module-local to-do lists, ever." This column was one: six ordered steps, `done` flags, an
 * assignee beside it, and no task. Flagging a conversion produced a checklist nobody was
 * assigned to work.
 *
 * The conversion now spawns a real task carrying the same six steps, so the column became a
 * SECOND list about the same work — two places to tick, free to disagree, with nothing deciding
 * which one was true.
 *
 * THE soto_status MIGRATION PATTERN, as ruled: mirror-with-one-writer ONLY if a reader cannot
 * move immediately, ripped out at zero readers. Here nothing could not move, so there is no
 * mirror phase:
 *
 *   · The ops UI never read it. There is no PLLC screen yet — the only consumer of
 *     GET /pllc-conversions was a test.
 *   · That GET now composes the checklist from `task_checklist_items` and returns the `taskId`
 *     alongside, so whenever the screen is built it reads the one source and ticks through the
 *     `/tasks/:id/checklist` endpoints that already exist.
 *   · PATCH /pllc-conversions/:id REFUSES a `checklist` field with a message naming the task
 *     endpoint. Dropping it from the schema would have zod strip it and answer 200 — a caller
 *     ticking an item would be told it worked and see nothing change.
 *
 * Reader count: zero. So the column goes now rather than lingering as a mirror nobody reads,
 * which is how a mirror becomes a second source of truth again.
 *
 * NOT DROPPED SILENTLY: the down migration restores the column but CANNOT restore its contents,
 * because the truth moved to the task. Rolling back gives you the shape, and the task keeps the
 * data — which is the honest outcome and is stated here so nobody discovers it during a
 * rollback.
 */

exports.up = (pgm) => {
  /*
   * Anything ticked on the old column, for the record, before it goes. Production has zero PLLC
   * conversions today (the module has never fired), so this is a precaution rather than a
   * rescue — but a migration that only works on an empty table is a migration nobody has
   * thought about.
   */
  pgm.sql(`
    DO $audit$
    DECLARE
      n int;
      ticked int;
    BEGIN
      SELECT count(*) INTO n FROM pllc_conversions;
      SELECT count(*) INTO ticked
        FROM pllc_conversions p, jsonb_array_elements(p.checklist) AS e
       WHERE (e->>'done')::boolean IS TRUE;
      IF n > 0 THEN
        INSERT INTO audit_log (actor_type, actor_label, action, object_type, details)
        VALUES ('system', 'migration 0069', 'pllc_conversion.checklist_retired', 'pllc_conversion',
                jsonb_build_object(
                  'conversions', n,
                  'items_already_ticked', ticked,
                  'note', 'checklist column dropped; the conversion task carries the steps now'
                ));
        RAISE WARNING '0069: % conversion(s), % ticked item(s) — see audit_log before relying on the column', n, ticked;
      END IF;
    END
    $audit$;
  `);

  pgm.sql(`ALTER TABLE pllc_conversions DROP COLUMN checklist;`);
};

exports.down = (pgm) => {
  // Shape only — the items live on the conversion's task and are not copied back.
  pgm.sql(`
    ALTER TABLE pllc_conversions
      ADD COLUMN checklist jsonb NOT NULL DEFAULT '[]'::jsonb;
  `);
};
