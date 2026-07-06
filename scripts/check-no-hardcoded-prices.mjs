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

// Patterns that indicate a hardcoded price. Deliberately NOT matched: SQL
// positional parameters ($1 … $99), which look exactly like small dollar
// amounts. Consequence: a bare two-digit price string like "$75" slips this
// net — the cents-assignment pattern below is the primary enforcement for
// amounts entering logic; the dollar patterns catch display strings.
const PATTERNS = [
  // $1,000 / $12,345.67 — thousands-formatted amounts
  { re: /\$\s?\d{1,3}(,\d{3})+(\.\d+)?/g, why: 'dollar literal' },
  // $75.00 — cents-formatted amounts
  { re: /\$\s?\d+\.\d{2}(?!\d)/g, why: 'dollar literal' },
  // $150 and larger — 3+ digit amounts (SQL params stop at $99)
  { re: /\$\s?\d{3,}(?![\d{\w])/g, why: 'dollar literal' },
  // amount_cents = 15000 / amountCents: 15000 — numeric price assignments.
  // Exactly 0 is permitted: it's an accumulator initializer / "free" marker,
  // never a price.
  { re: /[cC]ents\s*[:=]\s*(?!0\b)\d/g, why: 'cents literal assignment' },
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
