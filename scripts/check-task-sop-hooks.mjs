#!/usr/bin/env node
// CLAUDE.md hard rule: "Tasks link to SOPs: task types carry an optional 'how to
// do this' link into the knowledge base; building a task-generating feature
// without its SOP hook is incomplete."
//
// "Incomplete" needs teeth, or it degrades into a comment nobody reads. This
// scans for every task type the system can emit and fails the build if one is
// missing from TASK_TYPE_SOPS. The registry allows `sop: null`, so the rule is
// not "write an SOP for everything"; it is "decide, in writing, whether this
// needs one".
//
// ── WHERE IT LOOKS, AND WHY IT GREW (Brian, ruling R9, 2026-09-20) ──────────
//
// It used to read apps/api/src alone, for `sourceType: '...'` literals. That is
// the shape of the first offender rather than the rule, and two real emitters
// sat outside it:
//
//   · apps/api/scripts — the CLI importers and the harness boot call createTask()
//     exactly like a module does. apps/api/scripts/trello-import.ts introduced
//     `trello_ar_worklist` and nothing asked for an SOP decision.
//   · packages/db/migrations — a migration can INSERT a task row with a
//     source_type in SQL, positionally, with no `sourceType:` anywhere in it.
//     Migration 0068 did exactly that. The eight types that were invisible until
//     2026-08-17 were invisible for this reason: the scan read the function-call
//     shape and the writes were SQL.
//
// So it now reads BOTH shapes, over every root a shipped task row can be written
// from, and SQL is read positionally: inside an `INSERT INTO tasks (…) VALUES/SELECT …`
// it finds the source_type COLUMN and takes the literal in that position.
//
// NOT SCANNED, deliberately:
//   · apps/api/test — a fixture writes whatever row it needs; it proves behaviour
//     rather than creating work. (Synthetic data only, per CLAUDE.md.)
//   · apps/internal — Ops cannot name a task type. POST /tasks hardcodes
//     `source: 'manual'` and its CreateBody has no sourceType field, so the only
//     `sourceType` in the frontend is a search filter.
//
// Its companion is scripts/check-task-inserts.mjs, which refuses a raw
// `INSERT INTO tasks` outside createTask() and two named migrations. Together:
// a task row can only be written through the door or by a migration somebody
// named, and either way its type must carry an SOP decision.
//
// Run via `npm run check:sops` (wired into `npm test`).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'apps', 'api', 'src');
const REGISTRY = join(SRC, 'modules', 'sops', 'task-types.ts');

/** Every place a shipped task row can be written from. Same roots as check-task-inserts.mjs. */
const ROOTS = [
  join('apps', 'api', 'src'),
  join('apps', 'api', 'scripts'),
  join('packages', 'db', 'seeds'),
  join('packages', 'db', 'migrations'),
];
const SCANNED = /\.(ts|js|mjs|cjs|sql)$/;

/*
 * ── PROPOSED, NOT YET RULED (R9, 2026-09-20) ────────────────────────────────
 *
 * A task type that exists in code while Brian has not yet ruled on its SOP. This is NOT the
 * registry's `sop: null` — that is a decision ("no procedure needed, here is why"). This is the
 * absence of a decision, held here rather than in TASK_TYPE_SOPS so that the registry never
 * contains an entry nobody approved, and so that the pending decision is visible in every run's
 * output instead of living in a report.
 *
 * The allowance is the PAIR (type, file). A proposal cannot spread: the same string emitted from a
 * second file is a violation, because "Brian has not ruled on this one script's task type" is not
 * permission for the codebase at large.
 *
 * It is a holding pen with one occupant and it is meant to empty. When the type reaches
 * TASK_TYPE_SOPS this guard says the proposal is ruled and the entry can be deleted.
 */
const PROPOSED = new Map([
  /*
   * EMPTY, AND IT EMPTIED THE WAY IT WAS MEANT TO (2026-09-20). Its one occupant plus the two the
   * Trello import added the same day — trello_ar_worklist, trello_amendment, trello_books_review —
   * were ruled by Brian in R20 and moved into TASK_TYPE_SOPS with real SOP pages behind them, and
   * R23's two new types (trello_confirm_jurisdictions, trello_notify_client) were registered
   * straight away rather than parked here. A holding pen with nothing in it is the goal state, not
   * a sign nobody is using it: the next unruled type goes here with its reason and comes out when
   * Brian decides.
   */
]);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (SCANNED.test(entry)) yield full;
  }
}

// Registered keys, read straight out of the registry file so this check needs no
// TypeScript loader and cannot drift from what the app imports.
const registrySource = readFileSync(REGISTRY, 'utf8');
const registryBody = registrySource.slice(
  registrySource.indexOf('TASK_TYPE_SOPS'),
  registrySource.indexOf('/** Every registered task type. */')
);
const registered = new Set(
  [...registryBody.matchAll(/^\s{2}([a-z][a-z0-9_]*)\s*:\s*\{/gm)].map((m) => m[1])
);

if (registered.size === 0) {
  console.error('✖ Could not parse TASK_TYPE_SOPS — the checker needs updating alongside the registry.');
  process.exit(1);
}

/**
 * Split a SQL value list on its TOP-LEVEL commas.
 *
 * Needed because the literal is found by position, and the values are not simple: migration 0012's
 * SELECT list contains `array_to_string(q.missing_fields, ', ')`, whose comma sits inside both a
 * function call and a string literal. Tracks parens, brackets and single quotes (with '' escaping)
 * so neither one is mistaken for a separator.
 */
function topLevelSplit(text) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      cur += c;
      if (c === "'") {
        if (text[i + 1] === "'") { cur += text[++i]; continue; }
        quoted = false;
      }
      continue;
    }
    if (c === "'") { quoted = true; cur += c; continue; }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') { if (depth === 0) break; depth--; }
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/**
 * The projection of a `SELECT … FROM …`, i.e. everything before its own FROM.
 *
 * Written because `/\bfrom\b/i` found the wrong one. Migration 0012's projection begins with the
 * string literal 'Migrated from the enrichment queue. Missing: ' — the word FROM inside prose,
 * which truncated the value list, made it disagree with the column list, and silently dropped the
 * statement from the scan. A guard that skips what it cannot parse must be careful about what it
 * cannot parse: this walks the text, so quotes and subqueries are not mistaken for the keyword.
 */
function projection(text) {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "'") { if (text[i + 1] === "'") { i++; continue; } quoted = false; }
      continue;
    }
    if (c === "'") { quoted = true; continue; }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (
      depth === 0 &&
      (c === 'f' || c === 'F') &&
      /^from\b/i.test(text.slice(i, i + 5)) &&
      !/[\w$]/.test(text[i - 1] ?? ' ')
    ) {
      return text.slice(0, i);
    }
  }
  return text;
}

/**
 * The balanced parenthesised group starting at `from` (which must be its `(`), or null.
 */
function balanced(text, from) {
  if (text[from] !== '(') return null;
  let depth = 0;
  let quoted = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "'") { if (text[i + 1] === "'") { i++; continue; } quoted = false; }
      continue;
    }
    if (c === "'") { quoted = true; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return { body: text.slice(from + 1, i), end: i }; }
  }
  return null;
}

/**
 * Task types written by SQL: the literal sitting in the source_type column's position of an
 * `INSERT INTO tasks (…) VALUES (…)` or `… SELECT …`.
 *
 * Positional on purpose. Matching any quoted word inside the statement would hand back 'system',
 * 'automation' and 'open' as task types and the guard would go red on its own imprecision — which
 * is how a guard gets switched off.
 */
function sqlEmittedTypes(text) {
  const out = [];
  for (const m of text.matchAll(/insert\s+into\s+tasks\s*(?=\()/gi)) {
    const cols = balanced(text, m.index + m[0].length);
    if (!cols) continue;
    const names = topLevelSplit(cols.body).map((s) => s.trim().toLowerCase());
    const at = names.indexOf('source_type');
    if (at === -1) continue;

    const rest = text.slice(cols.end + 1);
    const values = /^\s*values\s*(?=\()/i.exec(rest);
    let list;
    if (values) {
      const group = balanced(rest, values.index + values[0].length);
      if (!group) continue;
      list = topLevelSplit(group.body);
    } else {
      // `INSERT INTO tasks (…) SELECT a, b, … FROM …` — the projection up to its FROM.
      const sel = /^\s*select\b/i.exec(rest);
      if (!sel) continue;
      list = topLevelSplit(projection(rest.slice(sel.index + sel[0].length)));
    }
    if (list.length !== names.length) continue; // shapes disagree; say nothing rather than guess
    const lit = /^\s*'([a-z][a-z0-9_]*)'\s*$/.exec(list[at] ?? '');
    if (lit) out.push({ type: lit[1], index: m.index });
  }
  return out;
}

// Every task type the code actually emits: type -> { file, line }.
const emitted = new Map();
const emittedBy = new Map(); // type -> Set of files, for the PROPOSED pair check
const lineAt = (text, index) => text.slice(0, index).split('\n').length;

function note(type, file, line) {
  if (!emitted.has(type)) emitted.set(type, { file, line });
  if (!emittedBy.has(type)) emittedBy.set(type, new Set());
  emittedBy.get(type).add(file);
}

for (const dir of ROOTS) {
  for (const file of walk(join(ROOT, dir))) {
    if (file === REGISTRY) continue;
    const rel = relative(ROOT, file).split(sep).join('/');
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/sourceType:\s*'([a-z][a-z0-9_]*)'/g)) note(m[1], rel, lineAt(text, m.index));
    for (const e of sqlEmittedTypes(text)) note(e.type, rel, lineAt(text, e.index));
  }
}

const missing = [];
const pending = [];
for (const [type, where] of emitted) {
  if (registered.has(type)) continue;
  const proposal = PROPOSED.get(type);
  const files = [...emittedBy.get(type)];
  // The allowance is the (type, file) pair: a proposal does not travel.
  if (proposal && files.length === 1 && files[0] === proposal.file) {
    pending.push({ type, ...where, why: proposal.why });
    continue;
  }
  missing.push({ type, ...where, ...(proposal ? { spread: files.filter((f) => f !== proposal.file) } : {}) });
}

// A registry entry with no emitter is stale, not dangerous — report it, don't fail.
const unused = [...registered].filter((type) => !emitted.has(type) && type !== 'manual');
// A proposal that has since been ruled on, or whose emitter is gone, is bookkeeping to clear.
const settled = [...PROPOSED.keys()].filter((t) => registered.has(t) || !emitted.has(t));

if (missing.length > 0) {
  console.error('✖ Task types generated in code but not registered in TASK_TYPE_SOPS.');
  console.error('  Each needs an SOP slug, or sop: null WITH a reason (see CLAUDE.md).\n');
  for (const m of missing) {
    console.error(`RED  ${m.type}  —  emitted in ${m.file}:${m.line}`);
    if (m.spread?.length) {
      console.error(
        `     (${m.type} is a PROPOSED type allowed only in ${PROPOSED.get(m.type).file}; ` +
          `it is now also emitted from ${m.spread.join(', ')}. A proposal does not travel — get the ruling.)`
      );
    }
  }
  process.exit(1);
}

console.log(`✓ All ${emitted.size} generated task types are registered with an SOP decision.`);
if (pending.length > 0) {
  console.log(`  ${pending.length} PROPOSED, awaiting Brian's ruling (not registered):`);
  for (const p of pending) console.log(`    ${p.type}  —  ${p.file}:${p.line}`);
}
if (unused.length > 0) {
  console.log(`  (note: ${unused.length} registered but not currently emitted: ${unused.join(', ')})`);
}
if (settled.length > 0) {
  console.log(`  (note: ${settled.length} proposal(s) now ruled or no longer emitted; remove from PROPOSED: ${settled.join(', ')})`);
}
