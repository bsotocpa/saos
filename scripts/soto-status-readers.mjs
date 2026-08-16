#!/usr/bin/env node
/*
 * WHO STILL READS soto_status (#42 migration tracker).
 *
 * `contact_status` is the lifecycle field now; `soto_status` survives as a legacy mirror
 * with exactly one writer (`refreshContactStatus`) so the two cannot drift. Brian's
 * condition for ripping it out is that the reader count reaches zero — so the count has to
 * be a number anyone can produce, not a memory of a grep.
 *
 * Run it to see where the migration stands:
 *     node scripts/soto-status-readers.mjs
 *
 * Writers are listed separately, because there must only ever be one and a second
 * appearing is the failure mode this whole arrangement exists to prevent.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SCAN = ['apps/api/src', 'apps/internal/app', 'apps/portal/app', 'packages/db'];
const TESTS = 'apps/api/test';

/** The one place allowed to WRITE soto_status. */
const SANCTIONED_WRITER = 'apps/api/src/modules/crm/lifecycle.ts';

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.next') continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(e)) out.push(full);
  }
  return out;
}

const files = [...SCAN, TESTS].flatMap((d) => walk(join(ROOT, d)));
const readers = [];
const writers = [];

/*
 * WRITE DETECTION IS STATEMENT-AWARE, not line-aware.
 *
 * `soto_status = 'active'` is a WRITE in `UPDATE contacts SET …` and a READ in
 * `WHERE …`, and the two look identical on their own line. Two line-based attempts at
 * this both cried wolf — first on the list filter, then on the health query — and a
 * check that cries wolf is one people switch off.
 *
 * So: find each SET clause (from `SET` to the statement's `WHERE`/backtick end) and mark
 * the line numbers inside it. Anything else mentioning the column is a read.
 */
function setClauseLines(src) {
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;
  const inside = new Set();
  for (const m of src.matchAll(/\bSET\b/gi)) {
    const start = m.index;
    const rest = src.slice(start);
    const stop = rest.search(/\bWHERE\b|`|;/i);
    const region = rest.slice(0, stop < 0 ? 200 : stop);
    if (!/soto_status/.test(region)) continue;
    const hit = start + region.indexOf('soto_status');
    inside.add(lineOf(hit));
  }
  return inside;
}

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const src = readFileSync(file, 'utf8');
  const writeLines = setClauseLines(src);
  src.split(/\r?\n/).forEach((line, i) => {
    if (!/soto_status|sotoStatus/.test(line)) return;
    const isWrite = writeLines.has(i + 1);
    (isWrite ? writers : readers).push({ rel, line: i + 1, text: line.trim().slice(0, 100) });
  });
}

const isTest = (r) => r.rel.startsWith('apps/api/test/');
const prod = readers.filter((r) => !isTest(r));
const test = readers.filter(isTest);

const byFile = (rows) => {
  const m = new Map();
  for (const r of rows) m.set(r.rel, (m.get(r.rel) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};

console.log(`\nsoto_status — #42 migration tracker\n${'='.repeat(52)}`);
console.log(`\nPRODUCTION READERS: ${prod.length} references in ${byFile(prod).length} files`);
console.log('  (these are the ones that must reach zero before the column can go)\n');
for (const [file, n] of byFile(prod)) console.log(`  ${String(n).padStart(3)}  ${file}`);

console.log(`\nTEST REFERENCES: ${test.length} in ${byFile(test).length} files`);
console.log('  (fixtures — they follow the production readers, they do not lead)\n');
for (const [file, n] of byFile(test)) console.log(`  ${String(n).padStart(3)}  ${file}`);

/*
 * Writers are split the same way readers are. A second PRODUCTION writer is a failure —
 * the mirror only holds while one function owns both columns. Test fixtures seeding a
 * status are a migration to-do, not a break: they set up state rather than encode
 * behaviour, and failing the build on them would give us a permanently red check, which
 * is a thing this codebase has already been bitten by.
 */
/*
 * Migrations are exempt. Backfilling the column IS their job — 0062 and 0063 exist
 * precisely to set it — and they run once against a known state rather than at runtime.
 * Counting them as rogue application writers would make this permanently red.
 */
const isMigration = (w) => w.rel.startsWith('packages/db/migrations/');
const prodWriters = writers.filter((w) => !isTest(w) && !isMigration(w));
const testWriters = writers.filter(isTest);

console.log(`\nPRODUCTION WRITERS: ${prodWriters.length} (must be exactly one)`);
let rogue = false;
for (const w of prodWriters) {
  const ok = w.rel === SANCTIONED_WRITER;
  if (!ok) rogue = true;
  console.log(`  ${ok ? '✓' : '✖'} ${w.rel}:${w.line}  ${w.text}`);
}

console.log(`\nTEST FIXTURES SEEDING IT DIRECTLY: ${testWriters.length}`);
console.log('  (each one creates a contact whose two status fields disagree — move them');
console.log('   to contact_status as the production readers migrate)\n');
for (const [file, n] of byFile(testWriters)) console.log(`  ${String(n).padStart(3)}  ${file}`);

if (rogue) {
  console.error(`\n✖ A second PRODUCTION writer of soto_status exists. The mirror only holds`);
  console.error(`  while ${SANCTIONED_WRITER} is the only one — otherwise the`);
  console.error(`  two fields drift, which is the entire failure this arrangement prevents.\n`);
  process.exit(1);
}
console.log(`\n  One production writer, as intended.\n`);
