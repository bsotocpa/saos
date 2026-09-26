#!/usr/bin/env node
/*
 * NO TRELLO BUNDLE OR CLIENT EXPORT EVER SITS UNDER THE CHECKOUT (Brian, 2026-09-26, R56).
 *
 * The Trello import bundle and the client exports (Dubsado, Zoho, the ATX e-file export, the
 * Vaultwarden export) carry real client identifiers. For a day in 2026-09 a bundle copy sat under
 * the checkout, which at the time lived under a Dropbox root, so it synced. check-sync-root.mjs
 * now refuses the sync root; this check refuses the files themselves: it walks the whole checkout
 * and goes red on any file or folder shaped like a bundle or export member, wherever it sits.
 *
 * Skipped: node_modules and .git (never ours to scan), the harness run records under
 * apps/e2e/.artifacts, and the one committed SYNTHETIC fixture folder apps/api/test/fixtures/atx/
 * (every identifier there is invented; its README says so). The fixture folder is skipped by path,
 * not by name, so a real ATX export copied anywhere else still trips the E-Files pattern.
 *
 * Output: one `RED <path>: <shape>` line per finding and exit 1; `bundle-files: ok (<n> entries walked)` and exit 0.
 */
import { readdirSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = resolve(here, '..');

/** Folders never walked, as checkout-relative paths (forward slashes). */
export const SKIP_DIRS = [
  'node_modules',
  '.git',
  'apps/e2e/.artifacts',
  'apps/api/test/fixtures/atx', // the committed synthetic ATX export; see its README
];
const SKIP_NAMES = new Set(['node_modules', '.git']);

/** [shape, test(fileName)] — the bundle and export members by name. */
export const FILE_SHAPES = [
  ['a Trello-bundle tax file (0?_tax_*.csv)', (n) => /^0._tax_.*\.csv$/i.test(n)],
  ['the Trello-bundle service-fact ledger (04b_service_facts.csv)', (n) => /^04b_service_facts\.csv$/i.test(n)],
  ['the Trello-bundle review file (review.csv)', (n) => /^review\.csv$/i.test(n)],
  ['the Trello-bundle decisions file (decisions.json)', (n) => /^decisions\.json$/i.test(n)],
  ['a Trello match file (trello_match_*.csv)', (n) => /^trello_match_.*\.csv$/i.test(n)],
  ['the Trello enrichment file (enrichment_file03.csv)', (n) => /^enrichment_file03\.csv$/i.test(n)],
  ['a Dubsado export (dubsado_*.csv)', (n) => /^dubsado_.*\.csv$/i.test(n)],
  ['a Zoho attachments archive (Attachments_*.zip)', (n) => /^attachments_.*\.zip$/i.test(n)],
  ['a Zoho data archive (Data_*.zip)', (n) => /^data_.*\.zip$/i.test(n)],
  ['the Vaultwarden export (vaultwarden-import.json)', (n) => /^vaultwarden-import\.json$/i.test(n)],
  ['an ATX e-file export (E-Files*.csv)', (n) => /e-?files.*\.csv$/i.test(n)],
];
/** Two names that together mark a bundle folder. */
export const PAIR = ['counts.json', 'sanitization_check.json'];
export const DIR_SHAPES = [['a Zoho extraction folder (zoho-extracted/)', (n) => /^zoho-extracted$/i.test(n)]];

const rel = (p) => relative(CHECKOUT, p).split(sep).join('/');
const skippedByPath = (p) => SKIP_DIRS.map((d) => d.toLowerCase()).includes(rel(p).toLowerCase());

/** Every finding under a root: [relative path, shape]. */
export function findings(root = CHECKOUT) {
  const out = [];
  let walked = 0;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name.toLowerCase()));
    if (PAIR.every((n) => names.has(n))) out.push([rel(dir) || '.', 'a bundle folder (counts.json beside sanitization_check.json)']);
    for (const e of entries) {
      walked++;
      const full = resolve(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_NAMES.has(e.name) || skippedByPath(full)) continue;
        for (const [shape, test] of DIR_SHAPES) if (test(e.name)) out.push([rel(full), shape]);
        walk(full);
      } else if (e.isFile()) {
        for (const [shape, test] of FILE_SHAPES) if (test(e.name)) out.push([rel(full), shape]);
      }
    }
  };
  walk(root);
  return { found: out, walked };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { found, walked } = findings(CHECKOUT);
  if (found.length) {
    for (const [p, shape] of found) console.log(`RED ${p}: ${shape} sits under the checkout. Bundles and client exports live outside the repository (C:/Users/brian/saos-archive, R19); move it out and purge any copy a sync client took.`);
    process.exit(1);
  }
  console.log(`bundle-files: ok (${walked} entries walked; no Trello-bundle or client-export file under ${CHECKOUT})`);
}
