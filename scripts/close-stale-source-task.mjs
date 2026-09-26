#!/usr/bin/env node
/**
 * CLOSE ONE SYSTEM TASK BY ITS SOURCE, THROUGH THE CLOSE DOOR (Brian, 2026-09-26, R52).
 *
 * "Fix saos-trello-rehearsal — unhealthy" sat open on production from 2026-09-20 07:10 UTC: the
 * 2026-09-20 import rehearsal ran in a throwaway container that went unhealthy long enough for the
 * watchdog to open its task, and was then torn down. Nothing closed the task, because until today
 * container-health never closed one (it does now, for any container the host no longer lists).
 *
 * WHY A SCRIPT AND NOT SQL: a task closes through `setTaskStatus()` — the Ops control, the bulk
 * edit and a one-off like this one all use the same door, so the blocker rule, the cascade and the
 * audit row (task.status_changed, with the reason verbatim) are one code path. An UPDATE would leave
 * a completed task with no record of who closed it or why.
 *
 * USAGE (inside saos-api-1, run from a FILE — never from stdin):
 *   node /tmp/close-stale-source-task.mjs --source-type container_unhealthy --source-id saos-trello-rehearsal \
 *        --reason "…a standalone sentence…"              # dry run: what would close
 *   node … --execute                                     # close it
 *
 * The actor is the system, named after this script; the reason is required and recorded verbatim.
 * Safe to re-run: only open tasks with that source are considered.
 */

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  if (a === '--execute') { args.set('execute', true); continue; }
  args.set(a.slice(2), process.argv[++i]);
}
const sourceType = args.get('source-type');
const sourceId = args.get('source-id');
const reason = (args.get('reason') ?? '').trim();
const EXECUTE = args.get('execute') === true;
if (!sourceType || !sourceId || reason.length < 10) {
  console.error('usage: --source-type <type> --source-id <id> --reason "<a standalone sentence, 10+ chars>" [--execute]');
  process.exit(2);
}

const { buildServer } = await import('/app/apps/api/src/server.ts');
const { loadConfig } = await import('/app/apps/api/src/config.ts');
const { setTaskStatus, OPEN_STATUSES } = await import('/app/apps/api/src/modules/tasks/service.ts');

const app = buildServer(loadConfig());
await app.ready();
try {
  const { rows } = await app.db.query(
    `SELECT id, status::text AS status, created_at::text AS created_at FROM tasks
      WHERE source_type = $1 AND source_id = $2 AND status = ANY($3::task_status[]) ORDER BY created_at`,
    [sourceType, sourceId, OPEN_STATUSES]
  );
  console.log(`${sourceType}/${sourceId}: ${rows.length} open task(s)`);
  for (const r of rows) console.log(`  ${r.id}  ${r.status}  created ${r.created_at}`);
  if (!EXECUTE) { console.log('dry run; add --execute to close through setTaskStatus'); }
  else {
    for (const r of rows) {
      await setTaskStatus(app, r.id, 'completed', { id: null, fullName: 'one-off: close-stale-source-task' }, { reason });
      console.log(`  closed ${r.id} (completed; audit task.status_changed with the reason)`);
    }
  }
  const after = await app.db.query(
    `SELECT status::text AS status, count(*)::int AS n FROM tasks WHERE source_type = $1 AND source_id = $2 GROUP BY status ORDER BY status`,
    [sourceType, sourceId]
  );
  console.log('now:', after.rows.map((r) => `${r.status}=${r.n}`).join(' '));
} finally {
  await app.close();
}
