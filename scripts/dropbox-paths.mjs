#!/usr/bin/env node
/*
 * WHICH PATHS DROPBOX SYNCS (Brian, 2026-09-20, report item 6). Dropbox's own info.json names its
 * root folder(s); anything under a root syncs unless Dropbox marks it ignored (the com.dropbox.ignored
 * stream on Windows) or selective sync leaves it off the disk entirely. This prints one row per path
 * that matters to SAOS: whether it is under a Dropbox root, whether it is marked ignored, and what it
 * holds. Rows: path | under a Dropbox root | ignored marker | holds
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const info = resolve(process.env.LOCALAPPDATA ?? '', 'Dropbox', 'info.json');
const roots = existsSync(info) ? Object.values(JSON.parse(readFileSync(info, 'utf8'))).map((r) => resolve(r.path)) : [];
const under = (p) => roots.some((r) => resolve(p).toLowerCase().startsWith(r.toLowerCase()));
// The named NTFS streams on a path: Dropbox writes com.dropbox.ignored on a folder it must skip, and
// com.dropbox.attrs on every file it has synced. Asking for one stream by name lies on a directory
// (PowerShell answers for any name), so the whole list is read and searched.
const streams = (p) => {
  if (!existsSync(p)) return null;
  try { return execSync(`powershell -NoProfile -Command "@(Get-Item -LiteralPath '${p}' -Stream * -ErrorAction SilentlyContinue | ForEach-Object { $_.Stream }) -join ','"`, { encoding: 'utf8' }).trim(); } catch { return ''; }
};
const ignored = (p) => { const s = streams(p); return s === null ? 'absent' : s.includes('com.dropbox.ignored') ? 'ignored' : 'no'; };
const sample = resolve(repo, 'package.json');
const synced = (streams(sample) ?? '').includes('com.dropbox.attrs') ? 'package.json carries com.dropbox.attrs: Dropbox has synced this tree' : 'no com.dropbox.attrs on package.json';
const rows = [['path', 'under a Dropbox root', 'ignored marker', 'holds'],
  [repo, under(repo) ? 'yes' : 'no', ignored(repo), `the repository checkout: source, tasks/, tasks/reports (counts only), tasks/receipts (synthetic run logs), apps/e2e/.artifacts (synthetic screenshots and fixtures); ${synced}`],
  [resolve(repo, 'imports'), under(resolve(repo, 'imports')) ? 'yes' : 'no', ignored(resolve(repo, 'imports')), existsSync(resolve(repo, 'imports')) ? 'PRESENT' : 'removed 2026-09-20; held the Trello bundle (client names) from 2026-09-19 until the move'],
  [resolve(process.env.USERPROFILE ?? '', 'saos-imports', 'trello_import'), under(resolve(process.env.USERPROFILE ?? '', 'saos-imports')) ? 'yes' : 'no', ignored(resolve(process.env.USERPROFILE ?? '', 'saos-imports', 'trello_import')), 'the Trello bundle now (client names); outside every Dropbox root'],
  [resolve(process.env.USERPROFILE ?? '', 'Downloads', 'trello_import_bundle.zip'), under(resolve(process.env.USERPROFILE ?? '', 'Downloads')) ? 'yes' : 'no', ignored(resolve(process.env.USERPROFILE ?? '', 'Downloads', 'trello_import_bundle.zip')), 'the zip Brian downloaded (client names)'],
  [resolve(process.env.LOCALAPPDATA ?? '', 'Temp', 'claude'), under(resolve(process.env.LOCALAPPDATA ?? '', 'Temp', 'claude')) ? 'yes' : 'no', 'n/a', 'the session scratchpad: run logs and the harness run record (synthetic)'],
  ['/opt/saos on the box (pg_dump copies saos_preflight, saos_trello_copy)', 'no', 'n/a', 'the only place a pg_dump copy of production ever lived; both dropped'],
];
process.stdout.write(rows.map((r) => r.join(' | ')).join('\n') + '\n');
