#!/usr/bin/env node
/*
 * THE GUARD ON A REPORT DRAFT (Brian, 2026-09-14, ruling 1): every table row in a report draft
 * must exist verbatim in a file under tasks/reports/. No file, no table. A row that is not in
 * any file was composed, and the draft is refused with the row named.
 *
 *   node scripts/check-report-draft.mjs <draft.md>
 *
 * A table is any run of lines starting with "|". Header and separator lines are skipped (a
 * header is the line before a "|---|" separator). The comparison is on the whole row, whitespace
 * around cells collapsed. Every table must match rows from ONE file, so a table is not stitched
 * from two sources either.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const draftPath = process.argv[2];
if (!draftPath) { console.error('usage: node scripts/check-report-draft.mjs <draft.md>'); process.exit(2); }

const norm = (line) => line.trim().split('|').map((c) => c.trim()).join('|');
const isSep = (line) => /^\|?\s*:?-{3,}/.test(line.trim());

export function tablesIn(text) {
  const lines = text.split(/\r?\n/);
  const tables = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim().startsWith('|')) {
      if (!cur) cur = { start: i + 1, rows: [] };
      if (isSep(l)) { cur.rows = []; continue; }              // the separator: what came before was the header
      cur.rows.push(norm(l));
    } else if (cur) { tables.push(cur); cur = null; }
  }
  if (cur) tables.push(cur);
  return tables;
}

const reportsDir = resolve(root, 'tasks', 'reports');
const files = existsSync(reportsDir) ? readdirSync(reportsDir).filter((f) => f.endsWith('.md')) : [];
const known = new Map(files.map((f) => [f, new Set(tablesIn(readFileSync(resolve(reportsDir, f), 'utf8')).flatMap((t) => t.rows))]));

const draft = readFileSync(resolve(draftPath), 'utf8');
const tables = tablesIn(draft);
let bad = 0;
for (const t of tables) {
  if (t.rows.length === 0) continue;
  const source = files.find((f) => t.rows.every((r) => known.get(f).has(r)));
  if (source) { console.log(`ok   table at line ${t.start}: ${t.rows.length} row(s), all in tasks/reports/${source}`); continue; }
  bad++;
  const missing = t.rows.filter((r) => !files.some((f) => known.get(f).has(r)));
  console.error(`RED  table at line ${t.start}: ${t.rows.length} row(s); ${missing.length} not in any tasks/reports file${missing.length ? `, first: ${missing[0]}` : ' (rows come from more than one file)'}`);
}
if (tables.length === 0) console.log('no tables in the draft');
process.exit(bad ? 1 : 0);
