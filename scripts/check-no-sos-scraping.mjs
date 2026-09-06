#!/usr/bin/env node
/*
 * NO AUTOMATED SECRETARY-OF-STATE QUERYING. EVER.
 *
 * Brian's ruling, 2026-09-06, after the Illinois Secretary of State answered our allowlisting
 * request: automated querying of their search violates their Terms of Use, and they do not
 * whitelist. The full exchange is in docs/ENTITY_ILSOS_AUTOMATION.md.
 *
 * "Retire the automated ILSOS fetch permanently — not disabled, removed from every code path."
 *
 * WHY A GUARD AND NOT A COMMENT. The scraper that came out was not reckless-looking code. It had
 * a timeout, an adapter interface, a stub for tests and a careful comment about best-effort
 * parsing. It ran in production for a month without succeeding once, and nobody noticed, because
 * nothing said it should not exist. In two years somebody will want a formation date, will find
 * an unused `SosChecker` shape in the git history, and will rebuild it in an afternoon meaning
 * well. This fails their build the moment they do, with the reason attached.
 *
 * The rule is about AUTOMATED QUERYING, not about the words. A person opening the site in a
 * browser is the sanctioned procedure and always was — see the `laura-sos-verify` SOP. So this
 * looks for code that would MAKE a request, not for mentions of the agencies: docs, comments and
 * SOP prose naming ilsos.gov are the point, and are left alone.
 *
 * Run via `npm run check:no-sos-scraping` (wired into `npm test`).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCAN_DIRS = ['apps', 'packages', 'scripts'];
const SOURCE_EXT = /\.(ts|tsx|mjs|cjs|js)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'coverage', '.git']);

/** This file names the hosts in order to forbid them; it must not fail itself. */
const SELF = 'scripts/check-no-sos-scraping.mjs';

/*
 * Secretary-of-State and business-registry hosts. Illinois and Florida are the two we actually
 * tried; the rest are here because the next person's state will not be Illinois, and a guard that
 * only knows about the incident is the failure mode this whole session kept finding.
 */
const REGISTRY_HOSTS = [
  'ilsos.gov',
  'sunbiz.org',
  'dos.myflorida.com',
  'sos.state',      // sos.state.xx.us, a common pattern
  'sosbiz',         // e.g. sosbiz.colorado.gov
  'coloradosos.gov',
  'sos.wa.gov',
  'sos.texas.gov',
  'sos.iowa.gov',
  'azcc.gov',
  'wdfi.org',       // Wisconsin DFI
  'in.gov/sos',
  'sosonline',
];

/**
 * Does this line look like it would make a network request?
 *
 * Deliberately narrow. A URL in a comment or a string used as documentation is fine; a URL handed
 * to something that fetches is not. Both `fetch(` on the same line and a bare registry URL in a
 * file that also fetches are treated as suspect, because the two-line form
 * (`const url = '...'` / `await fetch(url)`) is exactly how this gets rewritten.
 */
function isCodeLine(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('*') || trimmed.startsWith('//')) return false;
  return true;
}

const REQUEST_CALLS = /\b(fetch|axios|got|request|undici|https?\.get|https?\.request|curl)\s*[.(]/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (SOURCE_EXT.test(entry)) yield full;
  }
}

const violations = [];
for (const dir of SCAN_DIRS) {
  let base;
  try {
    base = statSync(join(ROOT, dir));
  } catch {
    continue;
  }
  if (!base.isDirectory()) continue;

  for (const file of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, file).split('\\').join('/');
    if (rel === SELF) continue;

    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    const codeLines = lines.map((l, i) => ({ n: i + 1, text: isCodeLine(l) ? l : '' }));
    const fileFetches = codeLines.some((l) => REQUEST_CALLS.test(l.text));

    for (const { n, text } of codeLines) {
      const host = REGISTRY_HOSTS.find((h) => text.includes(h));
      if (!host) continue;
      // A registry URL in real code, in a file that can make requests, is the thing.
      if (REQUEST_CALLS.test(text) || fileFetches) {
        violations.push({ rel, n, host, line: text.trim().slice(0, 120) });
      }
    }
  }
}

if (violations.length > 0) {
  console.error('✖ Automated Secretary-of-State querying found.\n');
  console.error('  The Illinois Secretary of State told us IN WRITING that automated querying of');
  console.error('  their search violates their Terms of Use, and that they do not whitelist.');
  console.error('  Brian retired it permanently on 2026-09-06 — removed, not disabled.\n');
  for (const v of violations) {
    console.error(`  ${v.rel}:${v.n}  (${v.host})`);
    console.error(`    ${v.line}`);
  }
  console.error('\n  The sanctioned procedure is a person in a browser: see the `laura-sos-verify`');
  console.error('  SOP and docs/ENTITY_ILSOS_AUTOMATION.md for the whole exchange. If a licensed');
  console.error('  bulk-data feed is ever contracted, this guard is updated deliberately — with a');
  console.error('  contract to point at, not because a build failed.');
  process.exit(1);
}

console.log('✓ No automated Secretary-of-State querying (registry lookups are a manual procedure).');
