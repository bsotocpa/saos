/*
 * R43 PRODUCTION CLEANUP (Brian Soto, CPA, 2026-09-26) — THROUGH THE DOORS, NEVER RAW SQL.
 *
 * On 2026-09-20 the firm's ATX "E-Files.csv" (500 rows) met an acknowledgment parser written against
 * an imagined report. It read the empty "Client #" column as the client name, found no tax-year
 * column, matched nothing, raised ONE TASK PER ROW (500) and stored the file verbatim — full SSNs and
 * EINs in efile_ack_reports.raw_text. This script undoes what that upload did, through the same
 * code paths the Ops controls use, acting as the system with an audit row on every write:
 *
 *   close     every open task the upload raised → setTaskStatus(…, 'completed', system actor,
 *             { reason }) — the Ops task close door — with Brian's reason, verbatim, on the audit row:
 *             "Raised in error by an acknowledgment parser that could not read the ATX export. No
 *             action is needed."
 *   purge     purgeReportIdentifiers → every full identifier in the stored file, on the report's
 *             rows and in the tasks it raised rewritten to its last four; counts on the audit row.
 *   withdraw  withdrawReport → the report is void and its file can be uploaded again. Needs the
 *             withdrawn_at column (migration 0118), so this step runs after that deploy.
 *
 * WHERE IT RUNS. In a container of the API image with this checkout's apps/api/src mounted over
 * /app/apps/api/src and the compose project's .env, on the saos network — the same code the deploy
 * ships, against the production database, one script. Copied to the box from a file, run, deleted
 * (lessons.md: never piped on stdin). Dry run by default; --execute writes.
 *
 *   node apps/api/scripts/r43-ack-cleanup.ts --report <uuid> [--steps close,purge,withdraw] [--execute]
 *
 * It prints COUNTS AND BOOLEANS ONLY: no names, no identifiers, no task text.
 */
import { buildServer } from '../src/server.ts';
import { loadConfig } from '../src/config.ts';
import type { Mailer } from '../src/mailer.ts';
import { setTaskStatus } from '../src/modules/tasks/service.ts';
import { purgeReportIdentifiers, withdrawReport, IDENTIFIER_SQL } from '../src/modules/tax/efile-ack.ts';

const REASON = 'Raised in error by an acknowledgment parser that could not read the ATX export. No action is needed.';
const ACTOR_LABEL = 'R43 cleanup script (Brian Soto, 2026-09-26)';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const EXECUTE = argv.includes('--execute');
const reportId = flag('report');
const steps = new Set((flag('steps') ?? 'close,purge,withdraw').split(',').map((s) => s.trim()).filter(Boolean));
if (!reportId || !/^[0-9a-f-]{36}$/.test(reportId)) { console.error('usage: --report <uuid> [--steps close,purge,withdraw] [--execute]'); process.exit(2); }

const config = loadConfig();
const silent: Mailer = { transport: 'console', async send() { throw new Error('this script sends nothing'); } };
const app = buildServer(config, { mailer: silent });
await app.ready();
const db = app.db;
const say = (label: string, value: unknown) => console.log(`${label} | ${String(value)}`);

try {
  const rep = await db.query<{ filename_len: number; uploaded_at: string; row_count: number; task_count: number; released: boolean; raw_len: number; raw_ids: string }>(
    `SELECT length(filename) AS filename_len, uploaded_at::text AS uploaded_at, row_count, task_count, released_at IS NOT NULL AS released, length(raw_text) AS raw_len,
            (SELECT count(*) FROM regexp_matches(raw_text, $2, 'g'))::text AS raw_ids
       FROM efile_ack_reports WHERE id = $1`, [reportId, IDENTIFIER_SQL]);
  if (!rep.rows[0]) { console.error('no such report'); process.exit(1); }
  const r = rep.rows[0];
  say('mode', EXECUTE ? 'EXECUTE' : 'dry run');
  say('database', config.DATABASE_URL.replace(/\/\/[^@]*@/, '//…@'));
  say('report uploaded_at', r.uploaded_at);
  say('report rows / tasks (as recorded)', `${r.row_count} / ${r.task_count}`);
  say('report released', r.released);
  say('raw file chars', r.raw_len);
  say('raw file nine-digit identifiers before', r.raw_ids);

  const open = await db.query<{ id: string; contact_id: string | null }>(
    `SELECT id, contact_id FROM tasks WHERE source_type = 'efile_ack_review' AND source_id LIKE $1 AND status NOT IN ('completed', 'cancelled') ORDER BY created_at`,
    [`${reportId}:%`]);
  say('open tasks from the upload before', open.rows.length);

  if (steps.has('close')) {
    let closed = 0; let failed = 0;
    for (const t of open.rows) {
      if (!EXECUTE) continue;
      try {
        await setTaskStatus(app, t.id, 'completed', { id: null, fullName: ACTOR_LABEL }, { reason: REASON });
        closed++;
      } catch (e) {
        failed++;
        console.error(`close failed for one task: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    say('tasks closed through setTaskStatus', EXECUTE ? closed : `(dry run: would close ${open.rows.length})`);
    say('tasks whose close failed', failed);
  }

  if (steps.has('purge')) {
    if (EXECUTE) {
      const out = await purgeReportIdentifiers(app, { id: null, label: ACTOR_LABEL }, reportId);
      say('purge: raw file identifiers masked', out.rawFileIdentifiers);
      say('purge: ack rows rewritten', out.ackRowsRewritten);
      say('purge: tasks rewritten', out.tasksRewritten);
      say('purge: audit rows holding identifiers (counted, not rewritten)', out.auditRowsHoldingIdentifiers);
    } else {
      say('purge', '(dry run: would mask the raw file and rewrite rows and tasks)');
    }
  }

  if (steps.has('withdraw')) {
    const col = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'efile_ack_reports' AND column_name = 'withdrawn_at'`);
    if (!col.rows.length) {
      say('withdraw', 'SKIPPED: efile_ack_reports.withdrawn_at is not on this database yet (migration 0118); run this step after the deploy');
    } else if (EXECUTE) {
      const out = await withdrawReport(app, { id: null, label: ACTOR_LABEL }, reportId, REASON);
      say('withdraw: queued rows voided', out.queuedVoided);
    } else {
      say('withdraw', '(dry run: would mark the report withdrawn)');
    }
  }

  const after = await db.query<{ open_tasks: string; raw_ids: string; task_ids: string; ack_ids: string }>(
    `SELECT (SELECT count(*) FROM tasks WHERE source_type = 'efile_ack_review' AND source_id LIKE $1 || ':%' AND status NOT IN ('completed', 'cancelled'))::text AS open_tasks,
            (SELECT count(*) FROM regexp_matches((SELECT raw_text FROM efile_ack_reports WHERE id = $1::uuid), $2, 'g'))::text AS raw_ids,
            (SELECT count(*) FROM tasks WHERE source_type = 'efile_ack_review' AND source_id LIKE $1 || ':%' AND concat_ws(' ', title, description) ~ $2)::text AS task_ids,
            (SELECT count(*) FROM efile_acknowledgments WHERE report_id = $1::uuid AND concat_ws(' ', client_name_raw, disposition_note, status_raw, submission_id, reject_code, reject_reason) ~ $2)::text AS ack_ids`,
    [reportId, IDENTIFIER_SQL]);
  say('open tasks from the upload after', after.rows[0]!.open_tasks);
  say('raw file nine-digit identifiers after', after.rows[0]!.raw_ids);
  say('tasks with a nine-digit run after', after.rows[0]!.task_ids);
  say('ack rows with a nine-digit run after', after.rows[0]!.ack_ids);
} finally {
  await app.close();
}
