#!/usr/bin/env node
/*
 * DATE INVARIANTS ALONG THE PATH (Brian, 2026-09-19, report item 10).
 *
 * Every chronology check the code carries, found rather than remembered: database CHECK
 * constraints and trigger functions that compare dates in packages/db/migrations, and API checks
 * that compare a calendar day through calendarDay() or daysBetween(). Printed as report rows
 * (level | where | what) for scripts/report-table.mjs --from-log.
 *
 *   node scripts/date-invariants.mjs > tasks/reports/date-invariants.log
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const rows = [['level', 'where', 'what']];
const clean = (s) => s.replace(/\s+/g, ' ').replace(/\|/g, '/').trim().slice(0, 160);

// Database: CHECK constraints and trigger bodies that compare date-typed things.
const migDir = resolve(root, 'packages', 'db', 'migrations');
for (const f of readdirSync(migDir).filter((x) => x.endsWith('.js')).sort()) {
  const text = readFileSync(resolve(migDir, f), 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const l = line.trim();
    const isCheck = /CHECK\s*\(/.test(l) && /(_at|_on|_date|date|deadline|expires|since)\b/i.test(l) && /(<=|>=|<|>|BETWEEN)/.test(l);
    const isTrigger = /RAISE EXCEPTION/.test(l) && /(date|_on|_at|deadline|signed|filed|expires)/i.test(lines.slice(Math.max(0, i - 6), i).join(' ')) && /(<=|>=|<|>)/.test(lines.slice(Math.max(0, i - 6), i).join(' '));
    if (isCheck || isTrigger) rows.push(['db', `${relative(root, resolve(migDir, f)).replace(/\\/g, '/')}:${i + 1}`, clean(l)]);
  });
}
// API: calendar-day comparisons and day arithmetic.
const apiDir = resolve(root, 'apps', 'api', 'src');
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.ts')) {
      const lines = readFileSync(p, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/calendarDay\([^)]*\)\s*(<=|>=|<|>)\s*calendarDay\(|daysBetween\(|(signedOn|formationDate|effectiveFrom|periodEnd|endedOn)\b[^;]*(<=|>=|<|>)/.test(line) && !/^\s*(\/\/|\*)/.test(line.trim())) {
          rows.push(['app', `${relative(root, p).replace(/\\/g, '/')}:${i + 1}`, clean(line)]);
        }
      });
    }
  }
}
walk(apiDir);
process.stdout.write(rows.map((r) => r.join(' | ')).join('\n') + '\n');
