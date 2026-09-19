#!/usr/bin/env node
/*
 * OPEN RULINGS, ONE ROW PER RULING (Brian, 2026-09-19, report item 8).
 *
 * Reads the OPEN RULINGS section of tasks/todo.md: every checkbox line is a ruling; section
 * headers are not rows. ID is R-<n> in file order; date is the first YYYY-MM-DD on the line;
 * text is the first sentence; state from the checkbox; outcome is the SHIPPED/DONE/ANSWERED/ON
 * THE BOX clause when there is one. For scripts/report-table.mjs --from-log.
 *
 *   node scripts/open-rulings.mjs > tasks/reports/open-rulings.log
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const t = readFileSync(resolve(here, '..', 'tasks', 'todo.md'), 'utf8');
const start = t.indexOf('## OPEN RULINGS');
const rest = t.slice(start);
const end = rest.search(/\n(?:## |FIRST\b)/);
const sec = end > 0 ? rest.slice(0, end) : rest;
const lines = sec.split('\n').filter((l) => /^- \[[ x]\]/.test(l));
const rows = [['id', 'date', 'text', 'state', 'outcome']];
const clean = (s) => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
lines.forEach((l, i) => {
  const open = l.startsWith('- [ ]');
  const body = clean(l.replace(/^- \[[ x]\] /, ''));
  const date = /(\d{4}-\d{2}-\d{2})/.exec(body)?.[1] ?? '';
  const m = /(SHIPPED|DONE|ANSWERED|RUN ON THE BOX|ON THE BOX|MERGED on the box|BUILT|CONFIRMED)\b[^]*$/.exec(body);
  const text = (m ? body.slice(0, m.index) : body).split(/(?<=[a-z\)0-9"\.])[.:] (?=[A-Z])/)[0].slice(0, 140);
  rows.push([`R-${String(i + 1).padStart(2, '0')}`, date, text, open ? 'OPEN' : 'closed', m ? m[0].slice(0, 140) : (open ? '' : 'closed')]);
});
process.stdout.write(rows.map((r) => r.join(' | ')).join('\n') + '\n');
