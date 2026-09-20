#!/usr/bin/env node
/*
 * THE CHECKOUT NEVER SITS UNDER A CLOUD-SYNC ROOT (Brian, 2026-09-20, R19 build item 1).
 *
 * The repository lived at C:\Users\brian\Dropbox\AI AGENT\saos for its whole life, inside the
 * Dropbox root, so every ignored file in it synced: the env files with every production secret,
 * a legacy Vaultwarden export, the client exports under migration-data/, and for a day the Trello
 * bundle. Nobody noticed because nothing checked. This does: it runs first in the root `npm test`
 * and first in scripts/deploy.sh, and refuses when the checkout path sits under a Dropbox, OneDrive
 * or Google Drive root on this machine.
 *
 * Roots are read from the sync clients' own records, never guessed from folder names alone:
 *   Dropbox       %LOCALAPPDATA%\Dropbox\info.json  (one path per account)
 *   OneDrive      the OneDrive, OneDriveConsumer and OneDriveCommercial environment variables
 *   Google Drive  %LOCALAPPDATA%\Google\DriveFS (the client's config dir names the mount roots)
 * plus a path segment named exactly "Dropbox", "OneDrive", "Google Drive" or "My Drive" on the way
 * to the checkout, for a machine whose client is not installed but whose folder is still synced
 * elsewhere.
 *
 * Output: one `RED <reason>` line per finding and exit 1; `sync-root: ok (<path>)` and exit 0.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// The path under test. The sabotage manifest points this at a folder under the Dropbox root.
const CHECKOUT = resolve(here, '..');

const norm = (p) => resolve(p).replace(/[\\/]+$/, '').toLowerCase();
const isUnder = (p, root) => { const a = norm(p); const r = norm(root); return a === r || a.startsWith(r + sep.toLowerCase()); };

/** [name, root] for every sync root this machine knows about. */
export function syncRoots(env = process.env) {
  const roots = [];
  const info = resolve(env.LOCALAPPDATA ?? '', 'Dropbox', 'info.json');
  if (env.LOCALAPPDATA && existsSync(info)) {
    try { for (const acct of Object.values(JSON.parse(readFileSync(info, 'utf8')))) if (acct?.path) roots.push(['Dropbox', acct.path]); } catch { /* unreadable: the segment rule below still applies */ }
  }
  for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) if (env[key]) roots.push(['OneDrive', env[key]]);
  const drivefs = resolve(env.LOCALAPPDATA ?? '', 'Google', 'DriveFS');
  if (env.LOCALAPPDATA && existsSync(drivefs)) {
    // DriveFS keeps one folder per account; each names its mount point in root_preference_sqlite.db,
    // which needs sqlite to read. The mount itself is a drive letter or a folder whose top level is
    // "My Drive", so the segment rule catches it; the presence of the client is recorded here.
    try { for (const d of readdirSync(drivefs)) if (/^\d+$/.test(d)) roots.push(['Google Drive (client installed; roots by segment)', '']); } catch { /* ignore */ }
  }
  return roots;
}

/** Every finding for a path: a known root it sits under, or a sync-named segment on the way to it. */
export function findings(checkout, env = process.env) {
  const out = [];
  for (const [name, root] of syncRoots(env)) if (root && isUnder(checkout, root)) out.push(`${checkout} sits under the ${name} root ${root}`);
  const segs = norm(checkout).split(sep.toLowerCase()).filter(Boolean);
  for (const s of segs) if (['dropbox', 'onedrive', 'google drive', 'my drive'].includes(s)) out.push(`${checkout} has a path segment named "${s}", a cloud-sync folder`);
  return [...new Set(out)];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = findings(CHECKOUT);
  if (found.length) {
    for (const f of found) console.log(`RED ${f}: a checkout under a sync root ships its env files and every ignored export to that service. Clone outside it (R19: C:\\Users\\brian\\saos) and work from there.`);
    process.exit(1);
  }
  console.log(`sync-root: ok (${CHECKOUT} is under no Dropbox, OneDrive or Google Drive root)`);
}
