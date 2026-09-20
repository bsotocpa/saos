#!/usr/bin/env node
/*
 * WHAT A FRESH CHECKOUT NEEDS BESIDES THE TRACKED TREE (Brian, 2026-09-20, R19). Reads git's own
 * list of ignored and untracked paths in this checkout and prints, by name only and never a value,
 * where each lives, whether that path is under the Dropbox root, what it holds, and whether it
 * belongs on the rotation list (a secret that sat under the Dropbox root). Rows:
 *   path | needed by the new checkout | lives now | under the Dropbox root | holds | rotation list
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const info = resolve(process.env.LOCALAPPDATA ?? '', 'Dropbox', 'info.json');
const roots = existsSync(info) ? Object.values(JSON.parse(readFileSync(info, 'utf8'))).map((r) => resolve(r.path).toLowerCase()) : [];
const under = (p) => roots.some((r) => resolve(p).toLowerCase().startsWith(r));
const ignored = execSync('git status --ignored --porcelain', { cwd: repo, encoding: 'utf8' }).split(/\r?\n/).filter((l) => /^!! /.test(l)).map((l) => l.slice(3).replace(/^"|"$/g, ''));
const envNames = (f) => { try { return readFileSync(resolve(repo, f), 'utf8').split(/\r?\n/).map((l) => /^([A-Z0-9_]+)=/.exec(l)?.[1]).filter(Boolean); } catch { return []; } };
const secretish = (n) => /PASS|SECRET|KEY|TOKEN|PASSWORD|SID|RESTIC|B2_/.test(n);
const known = {
  '.env': ['yes: the dev API, harness and migrations read it', 'dev database, MinIO, app encryption key, webhook secret (dev values)'],
  '.env.production': ['yes: deploy.sh ships it to the box', 'every production secret: database, MinIO, app encryption key, Stripe live key and webhook secret, SMTP, Twilio, Zoom, Cal.com, Vaultwarden admin token, restic and B2, Hetzner API token'],
  '.claude/settings.local.json': ['optional: per-user permission allow-list for Claude Code', 'tool permissions, no secrets'],
  '.green-runs/': ['yes, or the next receipt run recreates it', 'receipt hashes of green root-suite runs, no secrets'],
  'apps/e2e/.artifacts/': ['no: every harness run rebuilds it', 'synthetic fixtures (synthetic TOTP secret and passwords), screenshots, the run record'],
  'backups/': ['no', 'empty or local backup staging; must stay outside any synced folder (backup.sh refuses a path inside the repo)'],
  'imports/': ['no: removed 2026-09-20', 'held the Trello bundle (client names) 2026-09-19 to 2026-09-20'],
};
const rows = [['path', 'needed by the new checkout', 'lives now', 'under the Dropbox root', 'holds', 'rotation list']];
for (const p of ignored) {
  if (/node_modules|\.next\/|^dist\/|tsbuildinfo|coverage/.test(p)) continue;
  const abs = resolve(repo, p);
  const [needed, holds] = known[p] ?? [p.startsWith('migration-data/') ? 'no: legacy import inputs, finished' : 'unknown', p.startsWith('migration-data/') ? (p.includes('vaultwarden') ? 'a Vaultwarden export (12 login items, encrypted: false; deleted 2026-09-20 under R19)' : 'legacy client data (Dubsado, Zoho, grant tracker, legal text)') : ''];
  let rotation = 'no';
  if (p === '.env' || p === '.env.production') rotation = `yes: ${envNames(p).filter(secretish).join(', ')}`;
  if (p.includes('vaultwarden-import.json')) rotation = 'yes: every credential inside it (6 of 12 items carried a password)';
  if (p === 'apps/e2e/.artifacts/') rotation = 'no (synthetic)';
  rows.push([p, needed, abs, under(abs) ? 'yes' : 'no', holds, rotation]);
}
process.stdout.write(rows.map((r) => r.map((c) => String(c).replace(/\|/g, '/')).join(' | ')).join('\n') + '\n');
