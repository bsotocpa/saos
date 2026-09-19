#!/usr/bin/env node
/*
 * BUILD GUARD, THE RATCHET ON FORM ERRORS (Brian, 2026-09-19, defect 2 and report item 9).
 *
 * The rule: a form error renders inline at the control that caused it, with the server's words,
 * and the field keeps its text; the page-top flash is for navigation results only. The old
 * pattern was ask() resolving, then api() failing after the modal had closed, and the helper's
 * fallback string "request failed" reaching a page-top alert. This refuses the shapes that
 * reintroduce it:
 *
 *   1. an `await ask({...})` whose options carry no `run:` while an `api(` call follows in the
 *      same handler (the next 12 lines): the modal closed before the refusal could land;
 *   2. the literal fallback 'request failed' / 'Request failed' anywhere but the two api helpers;
 *   3. a state set inside a catch (not a page load) and rendered as an alert above the page's
 *      first card, section or form: the page top, where a form error must not go.
 *
 * Comment lines and the modal component itself are not scanned. With --inventory it prints every
 * api( call site (file:line, handler, evidence) for scripts/report-table.mjs --from-log.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const roots = ['apps/internal/app', 'apps/internal/components', 'apps/portal/app', 'apps/portal/components'].map((r) => resolve(root, r));
const inventory = process.argv.includes('--inventory');
const files = [];
function walk(d) { for (const e of readdirSync(d, { withFileTypes: true })) { const p = resolve(d, e.name); if (e.isDirectory()) walk(p); else if (/\.tsx?$/.test(e.name)) files.push(p); } }
roots.forEach(walk);

const problems = [];
const rows = [['file:line', 'handler', 'evidence']];
for (const f of files) {
  const rel = relative(root, f).replace(/\\/g, '/');
  const text = readFileSync(f, 'utf8');
  const lines = text.split('\n');
  const hasFieldError = text.includes('field-error');
  const isModal = /components\/ask\.tsx$/.test(rel);
  lines.forEach((line, i) => {
    if (isModal || /^\s*(\/\/|\*|\/\*)/.test(line)) return;
    // 1. ask() without run, api() right after.
    if (/await ask\(\{/.test(line)) {
      const block = lines.slice(i, i + 12).join('\n');
      const close = block.indexOf('});');
      const opts = close > 0 ? block.slice(0, close + 3) : block;
      if (!/\brun:/.test(opts) && /\bapi(<[^>]*>)?\(/.test(block.slice(opts.length))) problems.push(`${rel}:${i + 1}: ask() without run, then api() after the modal closed`);
    }
    // 2. the fallback string outside the helpers.
    if (/['"]request failed['"]/i.test(line) && !/lib\/api\.ts$/.test(rel)) problems.push(`${rel}:${i + 1}: the helper fallback string reappeared`);
    // 3. a state set in a catch (not a page load) and rendered as an alert ABOVE the page's first
    //    card or section: the page top, where a form error must not go.
    if (/\bcatch\b/.test(line)) {
      const setter = /set([A-Z]\w*)\(/.exec(lines.slice(i, i + 4).join('\n'));
      // The enclosing function: an async arrow/useCallback declaration, a function declaration, or a useEffect.
      const owner = [...lines.slice(Math.max(0, i - 80), i).join('\n').matchAll(/const\s+([A-Za-z_]\w*)\s*=\s*(?:useCallback\(\s*)?async\b|(?:async\s+)?function\s+([A-Za-z_]\w*)|(useEffect)\(/g)].map((m) => m[1] ?? m[2] ?? m[3]).pop() ?? '';
      if (setter && !/^load|^fetch|^refresh|^useEffect$|^bootstrap/i.test(owner)) {
        const v = setter[1][0].toLowerCase() + setter[1].slice(1);
        const render = lines.findIndex((l) => new RegExp('\\{' + v + '\\s*(\\?|&&)\\s*<(p|div)[^>]*className="alert (error|warn|danger)"').test(l));
        const firstCard = lines.findIndex((l) => /className="card|<section\b|<form\b/.test(l));
        if (render >= 0 && firstCard >= 0 && render < firstCard) problems.push(`${rel}:${render + 1}: '${v}' is set by a refusal in ${owner || 'a handler'} and rendered above the page's first card`);
      }
    }
    // Inventory.
    if (inventory && /\bapi(<[^>]*>)?\(\s*[`'"\/]/.test(line)) {
      const before = lines.slice(Math.max(0, i - 40), i).join('\n');
      const handler = [...before.matchAll(/(?:const|async function|function)\s+([A-Za-z_]\w*)\s*(?:=|\()/g)].map((m) => m[1]).pop() ?? (/(onClick|onSubmit|onChange|useEffect)/.exec(before)?.[1] ?? '');
      const near = lines.slice(Math.max(0, i - 12), i + 2).join('\n');
      const window = lines.slice(Math.max(0, i - 25), i + 25).join('\n');
      const evidence = /\brun:/.test(near) ? 'run (the modal keeps the refusal beside its field)' : /field-error|errAt\(/.test(window) ? 'inline (field-error beside the control)' : /useEffect|\bload\b|Loading/.test(window) ? 'load (page-level; a navigation result)' : 'unclassified';
      rows.push([`${rel}:${i + 1}`, handler.replace(/\|/g, '/'), evidence]);
    }
  });
}
if (inventory) { process.stdout.write(rows.map((r) => r.join(' | ')).join('\n') + '\n'); process.exit(0); }
if (problems.length) { for (const p of problems) console.error('RED  ' + p); console.error(`check:inline-errors FAILED (${problems.length})`); process.exit(1); }
console.log(`check:inline-errors: every modal action runs its work inside the modal, no helper fallback string outside lib/api.ts, no page-top-only refusal (${files.length} files checked).`);
