#!/usr/bin/env node
/*
 * EVERY CLASS THE MARKUP USES MUST EXIST IN THAT APP'S STYLESHEET.
 *
 * Written after Brian's 2026-08-16 real-device walkthrough (#36, #37, #43), because two
 * of those findings were the same defect pointing in opposite directions:
 *
 *   · the PORTAL rendered `.chip` / `.chipbar` — defined only in the INTERNAL app. Every
 *     multi-select question was therefore a row of identical default buttons where
 *     selecting one changed nothing on screen. It looked like a dead tap. Eleven
 *     questions across the intake and the onboarding modules, both languages.
 *
 *   · the INTERNAL app rendered `.list` / `.grow` — defined only in the PORTAL. So the
 *     ops client record's rows were not flex, had no `min-width: 0`, and could not
 *     contain a long unbreakable token.
 *
 * The two apps share markup idioms and have separate, partially-overlapping stylesheets,
 * so copying a pattern between them renders unstyled and SILENTLY. Nothing failed; it
 * just looked wrong, and only on a device.
 *
 * This is deliberately not a browser check. A browser check can only find what the
 * browser it runs in gets wrong — that is precisely how the original 390px verification
 * passed while iPhone Safari failed. A missing rule is missing in every engine, so this
 * finds it at build time, in CI, with no device and no rendering at all.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

const APPS = [
  { name: 'portal', dir: 'apps/portal/app', css: 'apps/portal/app/globals.css' },
  { name: 'internal', dir: 'apps/internal/app', css: 'apps/internal/app/globals.css' },
];

/*
 * Classes that legitimately have no rule of their own. Kept short and justified —
 * a long allowlist would turn this check back into a formality.
 */
const ALLOWED = new Set([
  // Element-scoped state, styled via a parent selector (.chip.active, .btn.ghost…).
  'active', 'ok', 'warn', 'danger', 'accent', 'ghost', 'done', 'span', 'dense', 'num',
  'block', 'error', 'info', 'x', 'sub', 'dot', 'grabber',
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Class names a stylesheet defines, including inside media queries. */
function definedClasses(cssPath) {
  const css = readFileSync(join(ROOT, cssPath), 'utf8');
  const found = new Set();
  for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) found.add(m[1]);
  return found;
}

/**
 * Class names the markup uses. Handles the three shapes in this codebase:
 * className="a b", className={`a ${x ? 'b' : ''}`}, and className={cond ? 'a' : 'b'}.
 * Interpolations are skipped rather than guessed — a false alarm would train people to
 * ignore this check, which is worse than missing one class.
 */
function usedClasses(file) {
  const src = readFileSync(file, 'utf8');
  const out = new Map();
  const attr = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{([^}]*)\})/g;
  for (const m of src.matchAll(attr)) {
    let raw = m[1] ?? m[2] ?? '';
    /*
     * A bare `{…}` expression is nearly always a ternary, and only the branches are
     * class names — `tab === 'kb' ? 'active' : ''` has 'kb' as a COMPARISON operand, not
     * a class. Taking every quoted string flagged .kb, .money and .registry, none of
     * which exist. So: only strings that follow a `?` or a `:`.
     */
    if (m[3] !== undefined) {
      raw = [...m[3].matchAll(/[?:]\s*'([^']*)'/g)].map((x) => x[1]).join(' ');
    }
    /*
     * Drop `${…}` wholesale. What it evaluates to is a runtime value — a status, a
     * severity, a variable — and guessing at it produces noise like `.activeViewId`,
     * which is exactly the kind of false alarm that teaches people to ignore a check.
     * The literal classes around the interpolation are still checked, and a dynamic
     * status class is styled by its parent selector anyway (.badge.paid, .row.urgent).
     */
    raw = raw.replace(/\$\{[^}]*\}/g, ' ');
    for (const cls of raw.split(/[\s'"]+/)) {
      if (!cls || cls.includes('.') || cls.includes('(')) continue;
      if (!/^-?[_a-zA-Z][\w-]*$/.test(cls)) continue;
      if (!out.has(cls)) out.set(cls, relative(ROOT, file));
    }
  }
  return out;
}

let failed = false;
for (const app of APPS) {
  const defined = definedClasses(app.css);
  const missing = new Map();
  for (const file of walk(join(ROOT, app.dir))) {
    for (const [cls, where] of usedClasses(file)) {
      if (defined.has(cls) || ALLOWED.has(cls)) continue;
      if (!missing.has(cls)) missing.set(cls, where);
    }
  }
  if (missing.size > 0) {
    failed = true;
    console.error(`\n✖ ${app.name}: markup uses classes ${app.css} does not define.`);
    console.error('  Unstyled markup fails silently — it renders, it just looks wrong.\n');
    for (const [cls, where] of [...missing].sort()) {
      console.error(`  .${cls}  —  first used in ${where}`);
    }
  }
}

if (failed) {
  console.error('\n  Define the rule, or delete the class. Do not add it to ALLOWED unless');
  console.error('  it is genuinely state styled by a parent selector.\n');
  process.exit(1);
}
console.log('check:css-classes: every class the markup uses is defined in its app stylesheet.');
