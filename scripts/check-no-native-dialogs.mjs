#!/usr/bin/env node
// BUILD GUARD: zero native dialogs in Ops and the portal (item 12, 2026-09-09, Brian's ruling).
//
// Safari offers "Suppress dialogs" after a page has shown a few. From then on every
// window.prompt / window.confirm / window.alert returns null or false instantly and silently,
// and every money action that asked first — void, withdraw, hold, transfer/refund — dies
// without a word. The withdraw reason was a window.prompt. So: none, anywhere, ever. The one
// in-app modal (apps/internal/components/ask.tsx, apps/portal/components/ask.tsx) asks instead,
// and this guard fails the build on any new native dialog.
//
// Matches: window.prompt( / window.confirm( / window.alert( / globalThis.*( and the bare
// prompt( / confirm( / alert( calls, outside comments and string contents. A local function
// that happens to be named confirm is refused too — the name belongs to the browser.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const roots = [
  resolve(here, '..', 'apps', 'internal', 'app'),
  resolve(here, '..', 'apps', 'internal', 'components'),
  resolve(here, '..', 'apps', 'internal', 'lib'),
  resolve(here, '..', 'apps', 'portal', 'app'),
  resolve(here, '..', 'apps', 'portal', 'components'),
  resolve(here, '..', 'apps', 'portal', 'lib'),
];

function* files(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|tsx)$/.test(p)) yield p;
  }
}

// Blank comments and string contents, keeping line structure, so prose never counts.
function codeOnly(text) {
  let out = '';
  let i = 0;
  const keep = (ch) => (ch === '\n' ? '\n' : ' ');
  while (i < text.length) {
    const ch = text[i], nx = text[i + 1];
    if (ch === '/' && nx === '*') { const e = text.indexOf('*/', i + 2); const stop = e === -1 ? text.length : e + 2; for (; i < stop; i++) out += keep(text[i]); continue; }
    if (ch === '/' && nx === '/') { while (i < text.length && text[i] !== '\n') { out += ' '; i++; } continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch; out += ' '; i++;
      while (i < text.length) {
        if (text[i] === '\\') { out += keep(text[i]); if (i + 1 < text.length) out += keep(text[i + 1]); i += 2; continue; }
        if (q === '`' && text[i] === '$' && text[i + 1] === '{') { let d = 1; i += 2; out += '  '; while (i < text.length && d > 0) { if (text[i] === '{') d++; else if (text[i] === '}') d--; out += d > 0 ? text[i] : ' '; i++; } continue; }
        if (text[i] === q) { out += ' '; i++; break; }
        out += keep(text[i]); i++;
      }
      continue;
    }
    out += ch; i++;
  }
  return out;
}

const RULES = [
  { name: 'native dialog', re: /\b(?:window|globalThis)\.(prompt|confirm|alert)\s*\(/g },
  { name: 'native dialog (bare)', re: /(?<![\w$.])(prompt|confirm|alert)\s*\(/g },
];

let failures = 0;
let checked = 0;
for (const root of roots) {
  for (const file of files(root)) {
    checked++;
    const raw = readFileSync(file, 'utf8');
    const text = codeOnly(raw);
    const lines = raw.split('\n');
    for (const rule of RULES) {
      for (const m of text.matchAll(rule.re)) {
        const line = text.slice(0, m.index).split('\n').length;
        failures++;
        console.error(`  ✖ ${relative(resolve(here, '..'), file)}:${line}: ${rule.name} — ${(lines[line - 1] ?? '').trim().slice(0, 100)}`);
      }
    }
  }
}

if (failures > 0) {
  console.error(`\ncheck:no-native-dialogs FAILED (${failures}) — use useAsk() from components/ask.tsx; the browser's dialogs can be suppressed and then every action that asks first dies silently.`);
  process.exit(1);
}
console.log(`check:no-native-dialogs: zero native dialogs in Ops and the portal (${checked} files checked).`);
