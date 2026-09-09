#!/usr/bin/env node
// BUILD GUARD: no raw timestamp reaches a screen (2026-09-09, Brian's ruling).
//
// "ended 2026-08-16T00:00:00.000Z" rendered on the Ops client page. One date helper per app
// now (apps/internal/lib/dates.ts in Chicago time, apps/portal/lib/dates.ts in the client's
// locale) and every page goes through it. This guard reads every page and fails the build on:
//
//   1. a timestamp field interpolated raw: {x.created_at} / `${x.ended_on}` — the exact defect;
//   2. a timestamp field truncated by hand: x.created_at.slice(0, 10);
//   3. Date formatting done inline: new Date(...).toLocaleDateString / toLocaleString /
//      toLocaleTimeString — the ad-hoc formatting the helper replaces.
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

function* tsxFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* tsxFiles(p);
    else if (p.endsWith('.tsx')) yield p;
  }
}

const RULES = [
  { name: 'raw timestamp interpolated', re: /(\{|\$\{)\s*[A-Za-z_$][\w$.?!]*\.(?:[a-z_]+_(?:at|on)|[a-z]+At)\s*\}/g },
  { name: 'timestamp truncated by hand', re: /\.(?:[a-z_]+_(?:at|on)|[a-z]+At)\??\.slice\(0,\s*10\)/g },
  { name: 'inline Date formatting', re: /new Date\([^)]*\)\.toLocale(?:Date|Time)?String\(/g },
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

if (failures > 0) {
  console.error(`\ncheck:date-rendering FAILED (${failures}) — use formatDate/formatDateTime/formatTime from lib/dates.`);
  process.exit(1);
}
console.log(`check:date-rendering: every timestamp goes through the date helper (${files} pages checked).`);
