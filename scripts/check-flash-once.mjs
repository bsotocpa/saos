#!/usr/bin/env node
// BUILD GUARD: a post-action notice renders ONCE per component (2026-09-09, Brian's ruling).
//
// The Ops client page rendered the same "actionMsg" in four cards — the notice partial had
// been pasted into each section. Brian voided an invoice from his phone and read "SA-2026-0002
// is void" four times. The rule: one page-level flash slot, above the first card, consumed
// once. This guard reads every Ops and portal page and fails the build if any state variable
// is rendered as a notice (className="alert …") more than once inside one component.
//
// Static on purpose: the front-ends have no render harness, and the defect is visible in the
// source — the same variable interpolated into more than one alert. Counted per top-level
// function, not per file, because a file may hold two components with their own notices.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const roots = [resolve(here, '..', 'apps', 'internal', 'app'), resolve(here, '..', 'apps', 'portal', 'app')];

function* tsxFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* tsxFiles(p);
    else if (p.endsWith('.tsx')) yield p;
  }
}

// `{name ? <p className="alert ok">{name}</p> : null}` — the variable inside the alert.
const RENDER = /className=["']alert(?: [a-z]+)?["'][^>]*>\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/g;
// A top-level function/component boundary at column 0.
const COMPONENT = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+\w+|^(?:export\s+)?const\s+\w+\s*=\s*(?:async\s*)?\(/m;

function segments(text) {
  const out = [];
  let start = 0;
  const re = new RegExp(COMPONENT.source, 'gm');
  let m;
  while ((m = re.exec(text))) {
    if (m.index > start) out.push(text.slice(start, m.index));
    start = m.index;
  }
  out.push(text.slice(start));
  return out;
}

let failures = 0;
let files = 0;
for (const root of roots) {
  for (const file of tsxFiles(root)) {
    files++;
    const text = readFileSync(file, 'utf8');
    for (const seg of segments(text)) {
      const counts = new Map();
      for (const m of seg.matchAll(RENDER)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
      for (const [name, n] of counts) {
        if (n > 1) {
          failures++;
          console.error(`  ✖ ${relative(resolve(here, '..'), file)}: "${name}" is rendered as a notice ${n} times in one component — one flash slot, rendered once.`);
        }
      }
    }
  }
}

if (failures > 0) {
  console.error(`\ncheck:flash-once FAILED (${failures}) — a notice must render once per component.`);
  process.exit(1);
}
console.log(`check:flash-once: every post-action notice renders once (${files} pages checked).`);
