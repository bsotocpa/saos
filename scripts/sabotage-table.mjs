#!/usr/bin/env node
/*
 * The sabotage reconciliation rows for a report (Brian, 2026-09-19, item 7), read from
 * tasks/sabotage/<date>.log as scripts/sabotage-run.mjs wrote it. An item re-run keeps its last
 * row (a smoke test of the runner, or a re-run after a port collision, must not print twice).
 *
 *   node scripts/sabotage-table.mjs 2026-09-19 > sab.log
 *   node scripts/report-table.mjs --name sabotage-reconciliation --from-log sab.log --sql "node scripts/sabotage-table.mjs 2026-09-19"
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const date = process.argv[2];
if (!date) { console.error('usage: sabotage-table.mjs <YYYY-MM-DD>'); process.exit(2); }
const lines = readFileSync(resolve(here, '..', 'tasks', 'sabotage', `${date}.log`), 'utf8').split(/\r?\n/).filter(Boolean);
const header = lines[0].split(' | ');
const last = new Map();
for (const l of lines.slice(1)) { const c = l.split(' | '); last.set(c[1], c); }
const keep = ['item', 'file', 'change', 'test', 'on the harness', 'red', 'restored green'].map((h) => header.indexOf(h));
process.stdout.write([keep.map((i) => header[i]), ...[...last.values()].map((c) => keep.map((i) => c[i] ?? ''))].map((r) => r.join(' | ')).join('\n') + '\n');
