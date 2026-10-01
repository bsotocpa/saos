#!/usr/bin/env node
/*
 * THE FIRM'S DAY IS CHICAGO'S (Brian, 2026-09-30, R104). The database clock is UTC: CURRENT_DATE,
 * now()::date and date_trunc on now() read tomorrow from 19:00 Chicago, and so does a JavaScript
 * new Date().toISOString().slice(0, 10). A stored instant cast ::date is its UTC day. Every "today",
 * month or year boundary in apps/api/src is computed in Chicago (apps/api/src/chicago-day.ts,
 * todayChicago, chicagoDate). This refuses the server-clock forms; a harmless one is named below with
 * why it is harmless, and a named line that no longer matches is refused too, so the list stays true.
 *
 *   npm run check:chicago-dates
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'apps', 'api', 'src');
const FORMS = [
  [/\bCURRENT_DATE\b/, 'CURRENT_DATE (the database\'s UTC day)'],
  [/now\(\)\s*::\s*date/, 'now()::date (the database\'s UTC day)'],
  [/date_trunc\('[a-z]+',\s*now\(\)\)/, 'date_trunc on now() (the database\'s UTC month or year)'],
  [/new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/, 'new Date().toISOString().slice(0, 10) (the UTC day)'],
  [/\b[a-z0-9_.]+_at\)?::date\b/, 'a stored instant cast ::date (its UTC day); use chicagoDayOf'],
];
/** Harmless, by file and the text on the line: (a) in the R104 table. */
const HARMLESS = [
  { file: 'apps/api/src/modules/admin/container-health.ts', text: 'relatedObjectId: `${c.name}:${new Date().toISOString().slice(0, 10)}`', why: 'a once-a-day dedupe key for a container alert; which day it names decides nothing' },
  { file: 'apps/api/src/modules/admin/container-health.ts', text: 'relatedObjectId: `${name}:${new Date().toISOString().slice(0, 10)}`', why: 'the same dedupe key for the recovery alert' },
  ...['apps/api/src/modules/crm/routes.ts', 'apps/api/src/modules/tax/pipeline.ts', 'apps/api/src/modules/tax/routes.ts'].map((file) => ({
    file, text: 'te.f8879_signed_at::date::text AS f8879_signed_on',
    why: 'f8879_signed_at holds a calendar day written as $n::date::timestamptz (pipeline.ts, signed-8879.ts) and is read back ::date in the same session zone: the day round-trips',
  })),
];

const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith('.ts')) files.push(p); } };
walk(src);
const problems = [];
const used = new Set();
for (const f of files) {
  const rel = relative(root, f).split(sep).join('/');
  if (rel === 'apps/api/src/chicago-day.ts') continue;
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    if (/^\s*(\*|\/\/)/.test(line)) return;
    for (const [re, what] of FORMS) {
      if (!re.test(line) || /AT TIME ZONE/.test(line)) continue;
      const ok = HARMLESS.findIndex((h) => h.file === rel && line.includes(h.text));
      if (ok >= 0) { used.add(ok); continue; }
      problems.push(`${rel}:${i + 1} ${what}`);
    }
  });
}
HARMLESS.forEach((h, i) => { if (!used.has(i)) problems.push(`${h.file}: the named harmless line "${h.text}" is gone; remove it from check-chicago-dates.mjs`); });
if (problems.length) {
  console.error('check:chicago-dates: a day, month or year read from the server clock instead of Chicago\'s.');
  for (const p of problems) console.error(`RED ${p}`);
  process.exit(1);
}
console.log(`check:chicago-dates: every day, month and year boundary in apps/api/src is Chicago's (${files.length} files; ${HARMLESS.length} harmless lines named).`);
