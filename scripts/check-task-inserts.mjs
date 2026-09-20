#!/usr/bin/env node
/*
 * ONE DOOR FOR WORK CREATION, EVERYWHERE A TASK CAN BE WRITTEN (Brian, ruling R8, 2026-09-20).
 *
 * `createTask()` in apps/api/src/modules/tasks is where the owner rule, the
 * (source_type, source_id) dedupe and the SOP hook live. A raw `INSERT INTO tasks` does not skip
 * one of those checks — it skips all three at once, silently. That is not a hypothesis: eight task
 * types were invisible until 2026-08-17 because eight raw inserts meant eight SOP decisions nobody
 * was ever asked to make, and the M25 Trello importer retired by this same ruling was a ninth —
 * `apps/api/src/migration/trello.ts`, which wrote cards straight into `tasks` with no owner
 * resolution, no dedupe through the door and no registered task type.
 *
 * WHY THIS IS A SECOND FILE AND NOT A LINE IN check-role-guarded-tasks.mjs.
 * That guard's rule 4 already refuses a raw insert, and it is the right rule — but it reads only the
 * files that already call `createTask(` or `notifyOnce(` (its file list is that grep), under
 * apps/api/src alone, and it exempts `apps/api/src/migration/` outright. So three real places could
 * write a task by hand and satisfy it completely:
 *
 *   · a file under apps/api/src that calls neither function — a pure-SQL module
 *   · anything in apps/api/scripts — where the CLI importers and the harness boot live
 *   · anything under apps/api/src/migration/ — the named exemption, which is exactly where the
 *     importer being deleted today sat for two months
 *
 * This guard reads the TREE, not a call graph, and carries no path exemption. The exemption in the
 * older guard existed for one file; that file is gone, and nothing replaces it.
 *
 * WHAT IS ALLOWED, and why each entry is here by name rather than by pattern (a pattern is how a
 * new raw insert inherits somebody else's permission):
 *
 *   · the tasks service — it IS the door
 *   · two migrations that adopt work which already exists. A migration is not a feature: it runs
 *     once, against rows already in the database, and `createTask()` cannot express what it needs
 *     (a historical status, a recovered clock). Both are listed with what they insert and why.
 *
 * NOT SCANNED: apps/api/test. A test may write whatever row it needs to set up a fixture; it is
 * proving behaviour, not creating work anybody has to do. Synthetic data only, per CLAUDE.md.
 *
 * Comments are blanked before the scan. Three files in the tree DISCUSS `INSERT INTO tasks` in
 * prose — the tasks-SOP registry, the portal-auth service and the older guard itself — and a guard
 * that reads documentation as code fails on the sentence explaining the bug it just fixed, which is
 * how people learn to stop trusting guards.
 *
 * Run via `npm run check:task-inserts` (wired into `npm test`).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Every place a shipped task row can be written from. */
const ROOTS = [
  'apps/api/src',
  'apps/api/scripts',
  'packages/db/seeds',
  // Included so a NEW migration that inserts tasks is a decision, not a default. The two that
  // legitimately do are named below; a third goes red until it is ruled on.
  'packages/db/migrations',
];

const SCANNED = /\.(ts|tsx|js|mjs|cjs|sql)$/;

/** file (posix path from the repo root) -> why a raw insert is correct there. */
const ALLOWED = new Map([
  [
    'apps/api/src/modules/tasks/service.ts',
    'THE DOOR. createTask() is this insert; the owner rule, the (source_type, source_id) dedupe and the SOP hook are the lines around it.',
  ],
  [
    'packages/db/migrations/0012_unified_tasks.js',
    'M25 backfill: every OPEN enrichment_queue row becomes a task, once, with its historical source_id. The rows already existed as queue entries — the migration moves work, it does not create it. Idempotent on (source_type, source_id).',
  ],
  [
    'packages/db/migrations/0068_perfection_clock_owned.js',
    'Recovery, not a feature: adopts perfection clocks that were already running with no owning task (the statutory window nobody was told about). It sets an owner resolved in PL/pgSQL and a due date in the past, neither of which createTask() accepts — correctly, because neither is a thing a live automation should be able to do.',
  ],
]);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // a root that does not exist in this checkout is not a violation
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (SCANNED.test(entry)) yield full;
  }
}

/**
 * The file with every comment blanked and every newline kept, so a match's line number is the
 * line number in the file a person opens.
 *
 * Handles `//`, `/* … *\/` and SQL `--`. Template literals are left alone deliberately: the SQL
 * this guard is looking for lives inside them, and `--` inside a SQL string is a comment in that
 * SQL too, so blanking it is right either way.
 */
function codeOnly(src) {
  let out = '';
  let inBlock = false;
  for (const raw of src.split('\n')) {
    let line = raw;
    if (inBlock) {
      const close = line.indexOf('*/');
      if (close === -1) {
        out += '\n';
        continue;
      }
      line = ' '.repeat(close + 2) + line.slice(close + 2);
      inBlock = false;
    }
    for (;;) {
      const open = line.indexOf('/*');
      if (open === -1) break;
      const close = line.indexOf('*/', open + 2);
      if (close === -1) {
        line = line.slice(0, open);
        inBlock = true;
        break;
      }
      line = line.slice(0, open) + ' '.repeat(close + 2 - open) + line.slice(close + 2);
    }
    const slashes = line.indexOf('//');
    if (slashes !== -1) line = line.slice(0, slashes);
    const dashes = line.indexOf('--');
    if (dashes !== -1) line = line.slice(0, dashes);
    out += line + '\n';
  }
  return out;
}

/*
 * Whitespace-tolerant and case-insensitive, over the whole file rather than line by line: the
 * inserts in this codebase are inside template literals that wrap wherever the column ran out, so
 * `INSERT INTO\n  tasks` is an ordinary way to write one. `\btasks\b` keeps `task_comments`,
 * `task_checklist_items` and a hypothetical `tasks_archive` out of it.
 */
const RAW_INSERT = /insert\s+into\s+tasks\b/gi;

const violations = [];
const usedAllowances = new Set();

for (const dir of ROOTS) {
  for (const file of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, file).split(sep).join('/');
    const text = codeOnly(readFileSync(file, 'utf8'));
    for (const m of text.matchAll(RAW_INSERT)) {
      if (ALLOWED.has(rel)) {
        usedAllowances.add(rel);
        continue;
      }
      violations.push({ file: rel, line: text.slice(0, m.index).split('\n').length });
    }
  }
}

if (violations.length > 0) {
  console.error('');
  for (const v of violations) {
    console.error(`RED  ${v.file}:${v.line}  raw INSERT INTO tasks outside the one door`);
  }
  console.error('');
  console.error('Tasks are created through createTask() in apps/api/src/modules/tasks/service.ts, which is');
  console.error('where the owner rule (CEO fallback), the (source_type, source_id) dedupe and the SOP hook');
  console.error('live. A raw insert skips all three without saying so.');
  console.error('');
  console.error('  Fix: await createTask(app, { title, assignedStaffId, contactId, source, sourceType,');
  console.error('  sourceId, … }) — and register the sourceType in TASK_TYPE_SOPS (check:sops).');
  console.error('');
  console.error('  A migration adopting work that already happened is the one other case. It goes in the');
  console.error('  ALLOWED list in this file, by name, with what it inserts and why — not by pattern.');
  console.error('');
  console.error('THE RULE (Brian, 2026-08-17, restated as R8 on 2026-09-20): one door for work creation,');
  console.error('same as one settlement path for money.');
  process.exit(1);
}

/*
 * A stale allowance is reported and does not fail: the file being gone is the good outcome (it is
 * how `apps/api/src/migration/trello.ts` left this tree), and a guard that goes red when someone
 * deletes a raw insert is teaching the wrong lesson.
 */
const stale = [...ALLOWED.keys()].filter((f) => !usedAllowances.has(f));
console.log(
  `✓ One door for work creation: no raw INSERT INTO tasks in ${ROOTS.join(', ')} ` +
    `outside createTask() and ${ALLOWED.size - 1} named migration(s).`
);
if (stale.length > 0) {
  console.log(`  (note: ${stale.length} allowance(s) no longer insert tasks and can be removed: ${stale.join(', ')})`);
}
