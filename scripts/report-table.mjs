#!/usr/bin/env node
/*
 * REPORT TABLES ARE FILES (Brian, 2026-09-14, ruling 1).
 *
 * A table of production rows in a report is never typed from memory: this script runs the query
 * on the box, writes the rows to tasks/reports/<date>-<name>.md with the query beside them, and
 * the report reproduces that file verbatim or links it. scripts/check-report-draft.mjs refuses a
 * report draft whose table rows are not in one of these files.
 *
 *   node scripts/report-table.mjs --name primary-flags-cleared --sql "SELECT ..." [--date 2026-09-12] [--note "..."]
 *   node scripts/report-table.mjs --name duplicate-scan --from-log path.log --sql "the command that produced it"
 *
 * --sql runs against production through the same SSH key deploy.sh uses (read-only: the script
 * refuses anything that is not a single SELECT/WITH). --from-log takes a text file whose lines
 * are the rows, separated by " | " (a script's own output), for tables a script printed rather
 * than a query returned.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const name = args.get('name');
const sql = args.get('sql');
const fromLog = args.get('from-log');
const date = args.get('date') ?? new Date().toISOString().slice(0, 10);
const note = args.get('note') ?? '';
if (!name || !sql) { console.error('usage: --name <slug> --sql "<SELECT ...>" [--from-log <file>] [--date YYYY-MM-DD] [--note "..."]'); process.exit(2); }
if (!/^[a-z0-9-]+$/.test(name)) { console.error('name: lowercase words and dashes'); process.exit(2); }

export function toMarkdownTable(header, rows) {
  const esc = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  return [`| ${header.map(esc).join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');
}

let header; let rows;
if (fromLog) {
  const lines = readFileSync(resolve(fromLog), 'utf8').split(/\r?\n/).filter((l) => l.trim());
  header = lines[0].split(' | ').map((s) => s.trim());
  rows = lines.slice(1).map((l) => l.split(' | ').map((s) => s.trim()));
} else {
  if (!/^\s*(select|with)\b/i.test(sql) || /;\s*\S/.test(sql)) { console.error('refusing: one SELECT (or WITH) statement only; this script reads'); process.exit(2); }
  const ip = readFileSync(resolve(root, '.env.production'), 'utf8').match(/^SERVER_IPV4=(.+)$/m)?.[1]?.trim();
  if (!ip) { console.error('no SERVER_IPV4 in .env.production'); process.exit(2); }
  const key = resolve(process.env.HOME ?? process.env.USERPROFILE ?? '', '.ssh', 'saos_hetzner_ed25519');
  const out = execFileSync('ssh', ['-i', key, '-o', 'BatchMode=yes', `root@${ip}`, 'docker exec -i saos-postgres-1 psql -U saos -d saos --csv -v ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const parsed = parseCsv(out.trim());
  header = parsed[0];
  rows = parsed.slice(1);
}

function parseCsv(text) {
  const out = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); out.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row); }
  return out;
}

const file = resolve(root, 'tasks', 'reports', `${date}-${name}.md`);
mkdirSync(dirname(file), { recursive: true });
const body = [
  `# ${name} (${date})`,
  '',
  `Generated ${new Date().toISOString()} by scripts/report-table.mjs from ${fromLog ? `the log ${fromLog.replace(/\\/g, '/').split('/').pop()}` : 'production'}; ${rows.length} row(s).`,
  note ? `\n${note}\n` : '',
  '```sql',
  sql.trim(),
  '```',
  '',
  toMarkdownTable(header, rows),
  '',
].join('\n');
writeFileSync(file, body);
console.log(`${file.replace(root + '\\', '').replace(root + '/', '')}: ${rows.length} row(s)`);
