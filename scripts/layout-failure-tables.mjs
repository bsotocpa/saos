#!/usr/bin/env node
/*
 * R106 (Brian, 2026-09-30): the layout audit's failures as report tables, written by a script.
 *
 *   node scripts/layout-failure-tables.mjs <before|after>
 *
 * Reads apps/e2e/.artifacts/layout-failures.jsonl (one line per failure: page, viewport, browser, check,
 * element, detail) and writes two logs beside it, then the two tables through scripts/report-table.mjs:
 *   r106-layout-<when>-summary  one row per page and check, the count in each of the six projects;
 *   r106-layout-<when>-full     every failure: page, viewport, browser, check, element, detail.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const when = process.argv[2];
if (when !== 'before' && when !== 'after') { console.error('usage: layout-failure-tables.mjs <before|after>'); process.exit(2); }
const src = resolve(root, 'apps', 'e2e', '.artifacts', 'layout-failures.jsonl');
let rows = [];
try { rows = readFileSync(src, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { rows = []; }
const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
const PROJECTS = ['chromium-375', 'chromium-768', 'chromium-1440', 'webkit-375', 'webkit-768', 'webkit-1440'];

const groups = new Map();
for (const r of rows) {
  const k = `${r.key}\u0000${r.check}`;
  if (!groups.has(k)) groups.set(k, { key: r.key, check: r.check, n: Object.fromEntries(PROJECTS.map((p) => [p, 0])) });
  groups.get(k).n[`${r.browser}-${r.viewport}`]++;
}
const order = { 'audit-gap': -1, overflow: 0, 'word-broken': 1, clipped: 2, 'tap-target': 3 };
const summary = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key) || order[a.check] - order[b.check]);
const sumLog = resolve(root, 'apps', 'e2e', '.artifacts', `layout-${when}-summary.log`);
writeFileSync(sumLog, ['page | check | ' + PROJECTS.join(' | ') + ' | total',
  ...summary.map((g) => [g.key, g.check, ...PROJECTS.map((p) => g.n[p]), PROJECTS.reduce((s, p) => s + g.n[p], 0)].map(cell).join(' | '))].join('\n') + '\n');
const fullLog = resolve(root, 'apps', 'e2e', '.artifacts', `layout-${when}-full.log`);
writeFileSync(fullLog, ['page | viewport | browser | check | element | detail',
  ...rows.map((r) => [r.page, r.viewport, r.browser, r.check, r.element, r.detail].map(cell).join(' | '))].join('\n') + '\n');

const sql = 'the R106 layout audit (apps/e2e/tests/layout-audit.spec.ts, LAYOUT_AUDIT=report): every Ops and portal page at 375, 768 and 1440 in Chromium and WebKit through apps/e2e/tests/layout-check.ts; the failures in apps/e2e/.artifacts/layout-failures.jsonl';
for (const [name, log] of [[`r106-layout-${when}-summary`, sumLog], [`r106-layout-${when}-full`, fullLog]]) {
  const r = spawnSync(process.execPath, [resolve(root, 'scripts', 'report-table.mjs'), '--name', name, '--from-log', log, '--sql', sql], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
console.log(`${rows.length} failures; ${summary.length} page-and-check rows.`);
