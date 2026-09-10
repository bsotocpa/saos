#!/usr/bin/env node
// BUILD GUARD: no raw timestamp reaches a screen (2026-09-09, Brian's ruling).
//
// "ended 2026-08-16T00:00:00.000Z" rendered on the Ops client page. One date helper per app
// now (apps/internal/lib/dates.ts in Chicago time, apps/portal/lib/dates.ts in the client's
// locale) and every page goes through it. This guard reads every page and fails the build on:
//
//   1. a timestamp or date field interpolated raw: {x.created_at} / `${x.ended_on}` /
//      {view.dueDate} — the exact defect (the walk caught dueDate after the first sweep);
//   2. a timestamp field truncated by hand: x.created_at.slice(0, 10);
//   3. Date formatting done inline: new Date(...).toLocaleDateString / toLocaleString /
//      toLocaleTimeString — the ad-hoc formatting the helper replaces;
//   4. TYPED INPUT (2026-09-09, "started Sep 9 · ended Sep 8"): a *_at / *At field (an
//      instant) handed to formatDate, which is for calendar days — use dayOf; and a *_on /
//      *_date / *Date field (a calendar day) handed to dayOf / formatDateTime / formatTime,
//      which are for instants — use formatDate. The helper marks the runtime case with ⚠;
//      this rule refuses it at build time.
//
// Exempt: a controlled input's value (the raw value IS the control's contract) and a line
// carrying `date-ok`, which is a reviewed exception with its reason beside it.
//
// Static on purpose: there is no render harness for the front-ends. The runtime check is the
// browser walk, which greps rendered text for the ISO-T shape (RAW_TIMESTAMP in the helper).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const roots = [resolve(here, '..', 'apps', 'internal', 'app'), resolve(here, '..', 'apps', 'portal', 'app')];
/*
 * Item 0 (2026-09-09): CONSUMERS, not just renderers. A DATE column leaves the driver as
 * 'YYYY-MM-DD' text; a raw < > <= >= against it, or a Date built from it, is the class of bug
 * that reads "not overdue" when it is. The API source is in scope for this rule alone; every
 * such comparison goes through calendarDay() (apps/api/src/modules/tax/deadlines.ts, and
 * apps/internal/lib/dates.ts for Ops).
 */
const consumerRoots = [...roots, resolve(here, '..', 'apps', 'api', 'src')];
const DAY_FIELD = String.raw`[A-Za-z_$][\w$.?!]*\.(?:[a-z_]+_(?:on|date|deadline|expiry)|overdue_since|client_since|[a-z]+(?:On|Date|Deadline|Expiry)|overdueSince|clientSince)\b`;
const CONSUMER_RULES = [
  { name: 'raw comparison on a calendar-day field (use calendarDay)', re: new RegExp(String.raw`(?<!calendarDay\(\s*)(?:${DAY_FIELD})\s*(?:<=|>=|<|>)\s*(?!\s*\d)`, 'g') },
  { name: 'raw comparison on a calendar-day field (use calendarDay)', re: new RegExp(String.raw`(?:<=|>=|<|>)\s*(?!\s*\d)(?<!calendarDay\()(?:${DAY_FIELD})\b(?!\s*\))`, 'g') },
  { name: 'a Date built from a calendar-day field (use daysBetween/calendarDay)', re: new RegExp(String.raw`new Date\(\s*(?:${DAY_FIELD})\s*\)`, 'g') },
];

function* tsxFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* tsxFiles(p);
    else if (p.endsWith('.tsx')) yield p;
  }
}
function* tsFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* tsFiles(p);
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) yield p;
  }
}

const RULES = [
  { name: 'raw timestamp interpolated', re: /(\{|\$\{)\s*[A-Za-z_$][\w$.?!]*\.(?:[a-z_]+_(?:at|on|date)|[a-z]+(?:At|On|Date))\s*\}/g },
  { name: 'timestamp truncated by hand', re: /\.(?:[a-z_]+_(?:at|on|date)|[a-z]+(?:At|On|Date))\??\.slice\(0,\s*10\)/g },
  { name: 'inline Date formatting', re: /new Date\([^)]*\)\.toLocale(?:Date|Time)?String\(/g },
  { name: 'an instant handed to formatDate (use dayOf)', re: /\bformatDate\(\s*[A-Za-z_$][\w$.?!]*\.(?:[a-z_]+_at|[a-z]+At)\b/g },
  { name: 'a calendar day handed to an instant formatter (use formatDate)', re: /\b(?:dayOf|formatDateTime|formatTime)\(\s*[A-Za-z_$][\w$.?!]*\.(?:[a-z_]+_(?:on|date)|[a-z]+(?:On|Date))\b/g },
];

let failures = 0;
let files = 0;
for (const root of roots) {
  for (const file of tsxFiles(root)) {
    files++;
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (const rule of RULES) {
      for (const m of text.matchAll(rule.re)) {
        const line = text.slice(0, m.index).split('\n').length;
        const lineText = lines[line - 1] ?? '';
        // Comments are prose; a code sample in a comment is not a render.
        if (/^\s*(\/\/|\*|\/\*)/.test(lineText)) continue;
        // A controlled input carries the raw value on purpose; a reviewed exception says so.
        if (/value=\{/.test(lineText) || lineText.includes('date-ok')) continue;
        failures++;
        console.error(`  ✖ ${relative(resolve(here, '..'), file)}:${line}: ${rule.name} — ${m[0].trim()}`);
      }
    }
  }
}

for (const root of consumerRoots) {
  for (const file of tsFiles(root)) {
    const raw = readFileSync(file, 'utf8');
    // SQL lives in template literals and compares in Postgres: blank their contents, keep the lines.
    const text = raw.replace(/`[^`]*`/g, (lit) => lit.replace(/[^\n]/g, ' '));
    const lines = raw.split('\n');
    for (const rule of CONSUMER_RULES) {
      for (const m of text.matchAll(rule.re)) {
        const line = text.slice(0, m.index).split('\n').length;
        const lineText = lines[line - 1] ?? '';
        if (/^\s*(\/\/|\*|\/\*)/.test(lineText)) continue;
        if (lineText.includes('calendarDay(') || lineText.includes('date-ok')) continue;
        // JSX comparisons of a field against a literal are handled by the rule's lookahead; SQL
        // text inside template literals compares in Postgres, not here.
        if (/^\s*(SELECT|WHERE|AND|OR|WHEN|SET|ORDER|CASE|JOIN|ON|LEFT|COALESCE|--)\b/i.test(lineText.trim())) continue;
        if (/`[^`]*$/.test(lineText.slice(0, lineText.indexOf(m[0]))) && !/\$\{/.test(lineText)) continue;
        failures++;
        console.error(`  ✖ ${relative(resolve(here, '..'), file)}:${line}: ${rule.name} — ${m[0].trim()}`);
      }
    }
  }
}

if (failures > 0) {
  console.error(`\ncheck:date-rendering FAILED (${failures}) — formatDate for a calendar day (DATE column), dayOf/formatDateTime/formatTime for an instant (timestamptz), from lib/dates.`);
  process.exit(1);
}
console.log(`check:date-rendering: every timestamp goes through the date helper (${files} pages checked).`);
