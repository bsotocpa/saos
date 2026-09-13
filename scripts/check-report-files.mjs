#!/usr/bin/env node
// BUILD GUARD (Brian, 2026-09-14, ruling 1): every file under tasks/reports/ was written by
// scripts/report-table.mjs: it names its generator and row count on line 3, carries the query in a
// sql fence, and its table holds exactly the rows it claims. A hand-edited or hand-written file
// fails the root suite, because the point of the folder is that nothing in it was composed.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, '..', 'tasks', 'reports');
if (!existsSync(dir)) { console.log('check:report-files — no tasks/reports yet'); process.exit(0); }
let bad = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
  const text = readFileSync(resolve(dir, f), 'utf8');
  const lines = text.split(/\r?\n/);
  const gen = /^Generated \S+ by scripts\/report-table\.mjs from .+; (\d+) row\(s\)\.$/.exec(lines[2] ?? '');
  const hasSql = /```sql\n[\s\S]+?\n```/.test(text);
  const rows = lines.filter((l) => l.trim().startsWith('|') && !/^\|?\s*-{3,}/.test(l.trim())).length - 1; // minus the header
  const claimed = gen ? Number(gen[1]) : -1;
  if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/.test(f) || !gen || !hasSql || rows !== claimed) {
    bad++;
    console.error(`RED  tasks/reports/${f}: ${!gen ? 'no generator line' : !hasSql ? 'no query' : rows !== claimed ? `claims ${claimed} row(s), holds ${rows}` : 'bad name'}`);
  }
}
if (bad) process.exit(1);
console.log('check:report-files — every report table names its query and its rows');
