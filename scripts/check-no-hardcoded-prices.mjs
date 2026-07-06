#!/usr/bin/env node
// CLAUDE.md hard rule: "No hardcoded prices, anywhere. Every dollar amount
// comes from the versioned price_book table. A price appearing as a literal
// in application code is a build failure."
//
// This guard scans application source for dollar/cents literals and fails the
// build when it finds one. The ONLY places money values may appear are:
//   - packages/db/ (price_book migrations + seeds — the source of truth)
//   - test files (synthetic fixtures)
// Run via `npm run check:prices` (wired into `npm test`).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Directories containing application code (price literals forbidden).
const SCAN_DIRS = ['apps', 'packages'];

// Anything under these path fragments is exempt.
const EXEMPT = [
  `packages${sep}db${sep}`, // migrations + seeds hold the real prices
  `${sep}test${sep}`,
  `${sep}tests${sep}`,
  '.test.',
  '.spec.',
  `${sep}node_modules${sep}`,
  `${sep}dist${sep}`,
  `${sep}.next${sep}`,
];

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

// Patterns that indicate a hardcoded price:
//  1. A dollar sign directly followed by an amount ("$150", "$ 1,000").
//     The lookbehind excludes template-literal interpolation "${...}".
//  2. A *_cents / *Cents variable assigned a numeric literal.
const PATTERNS = [
  { re: /\$\s?\d[\d,]*(\.\d+)?(?![{\w])/g, why: 'dollar literal' },
  { re: /[cC]ents\s*[:=]\s*\d/g, why: 'cents literal assignment' },
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
      yield* walk(full);
    } else if (SOURCE_EXT.test(entry)) {
      yield full;
    }
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
    const rel = relative(ROOT, file);
    if (EXEMPT.some((frag) => (sep + rel + sep).includes(frag))) continue;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const { re, why } of PATTERNS) {
        re.lastIndex = 0;
        if (re.test(line)) violations.push(`${rel}:${i + 1} (${why}): ${line.trim()}`);
      }
    });
  }
}

if (violations.length > 0) {
  console.error('✖ Hardcoded price literals found in application code.');
  console.error('  All prices must come from the price_book tables (see CLAUDE.md).\n');
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log('✓ No hardcoded prices in application code.');
