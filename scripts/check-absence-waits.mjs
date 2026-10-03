#!/usr/bin/env node
/*
 * AN ABSENCE IS READ ONLY AFTER THE PAGE HAS SHOWN IT LOADED (Brian, 2026-10-02, R119).
 *
 * A walk that asserts something is ABSENT ("no Reopen control", a count of 0, text that is not there)
 * passes on a page that has not loaded its data yet: the control is absent because nothing is drawn.
 * Receipt run 63 showed the red twin of this (a fixed wait, then a read of loaded content); this is the
 * green one, which hides. So every walk under apps/e2e/tests is read statement by statement:
 *
 *   a window OPENS at   a fixed wait (waitForTimeout) or a navigation (page.goto, page.reload);
 *   it CLOSES at        a positive wait: a web-first `await expect(…)` with a positive matcher, an
 *                       `await expect.poll(…)`, waitForSelector / waitForURL / waitForResponse /
 *                       waitForFunction, or an awaited action on an element (click, fill, check,
 *                       selectOption, setInputFiles, press), which Playwright performs only on an element
 *                       that is there;
 *   it FAILS at         an absence assertion while open: `.not.<matcher>`, toHaveCount(0), toBeHidden(),
 *                       toBe(0), toEqual([]).
 *
 * The rule Brian ruled is the fixed wait's: a fixed wait followed by an absence with no positive wait
 * between them fails, always. A navigation followed by an absence with no positive wait between them is
 * the same mistake and fails too (the sweep fixed every one). A line may carry
 *   // absence-ok: <why>
 * on the absence itself when the absence IS the positive fact (a page that must show nothing at all,
 * proved some other way on the line); the check prints every such waiver.
 *
 *   node scripts/check-absence-waits.mjs           the check (npm run check:absence-waits, root suite)
 *   node scripts/check-absence-waits.mjs --list    every failure, one per line, and the count
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(root, 'apps', 'e2e', 'tests');

/**
 * The walk as events: each statement (split on ';' where no paren or bracket is open since the innermost
 * brace), and each block's start and end ('{', '}'), so a window can be scoped to the block it opened in.
 */
export function events(src) {
  const out = [];
  const parens = [0]; // open parens/brackets, per brace level
  let start = 0, line = 1, startLine = 1, quote = null, tplBraces = [];
  const kinds = []; // per '{': 'block' or 'obj'
  const push = (end) => {
    const raw = src.slice(start, end);
    const text = raw.trim();
    if (text) out.push({ type: 'stmt', text, line: startLine + (raw.match(/^\s*/)[0].split('\n').length - 1) });
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') line++;
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (quote === '`' && c === '$' && src[i + 1] === '{') { tplBraces.push(parens.length); parens.push(0); i++; quote = null; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; line++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); line += src.slice(i, e).split('\n').length - 1; i = e + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    // A regex literal (/Invoices \(/): skipped whole, so the parentheses inside it are not code.
    if (c === '/') {
      const prev = src.slice(Math.max(0, i - 8), i).replace(/\s+$/, '');
      if (prev === '' || /[(,=:[!&|?{};]$/.test(prev) || /\breturn$/.test(prev)) {
        let j = i + 1, cls = false;
        for (; j < src.length && src[j] !== '\n'; j++) {
          if (src[j] === '\\') { j++; continue; }
          if (src[j] === '[') cls = true;
          else if (src[j] === ']') cls = false;
          else if (src[j] === '/' && !cls) break;
        }
        if (src[j] === '/') { i = j; continue; }
      }
    }
    const top = parens.length - 1;
    if (c === '(' || c === '[') parens[top]++;
    else if (c === ')' || c === ']') parens[top]--;
    else if (c === '{') {
      // A block follows ')' (if, for, a function's parameters), '=>' or else / try / finally / do; any
      // other '{' is an object literal and counts like a parenthesis (it never splits a statement).
      const before = src.slice(Math.max(0, i - 12), i).replace(/\s+$/, '');
      const block = /[)>]$/.test(before) || /\b(else|try|finally|do)$/.test(before);
      if (!block) { parens[top]++; kinds.push('obj'); continue; }
      kinds.push('block');
      if (parens[top] === 0) { push(i); }
      parens.push(0);
      out.push({ type: 'open', line });
      start = i + 1; startLine = line;
    } else if (c === '}') {
      if (tplBraces.length && tplBraces[tplBraces.length - 1] === parens.length - 1) { tplBraces.pop(); parens.pop(); quote = '`'; continue; }
      if (kinds.pop() === 'obj') { parens[top]--; continue; }
      push(i);
      parens.pop();
      if (!parens.length) parens.push(0);
      out.push({ type: 'close', line });
      start = i + 1; startLine = line;
    } else if (c === ';' && parens[top] === 0) {
      push(i);
      start = i + 1; startLine = line;
    }
  }
  push(src.length);
  return out;
}

const OPEN_WAIT = /\bwaitForTimeout\s*\(/;
const OPEN_NAV = /\bpage\.(goto|reload)\s*\(/;
const ABSENCE = /\.not\.\w+\s*\(|\.toHaveCount\(\s*0\s*\)|\.toBeHidden\s*\(|\.toBe\(\s*0\s*\)|\.toEqual\(\s*\[\s*\]\s*\)/;
// An awaited action on an element is a positive wait too: Playwright acts only once the element is
// there, visible and enabled (a click on a data-drawn row proves the page drew it).
const POSITIVE_WAIT = /\bawait\s+expect\.poll\s*\(|\bwaitFor(Selector|URL|Response|Function)\s*\(|\bawait\s+(?!page\.(goto|reload|evaluate|waitForTimeout|mouse|keyboard)\b)[\w.$]+(\([^;]*\))?\.(click|dblclick|fill|check|uncheck|selectOption|setInputFiles|press)\s*\(/;
const WEB_FIRST = /\bawait\s+expect\s*\(/;

export function scan(file, src) {
  const found = [];
  const waivers = [];
  const stack = [null]; // the open window per block: null, or { kind, line }
  for (const ev of events(src)) {
    if (ev.type === 'open') { stack.push(stack[stack.length - 1]); continue; }
    if (ev.type === 'close') { if (stack.length > 1) stack.pop(); continue; }
    const t = ev.text;
    const open = stack[stack.length - 1];
    const isExpect = /\bexpect\s*\(/.test(t) || /\bexpect\.poll\s*\(/.test(t);
    const absence = isExpect && ABSENCE.test(t);
    if (absence && open) {
      const line = src.split('\n').slice(ev.line - 1, ev.line + t.split('\n').length).join('\n');
      const waiver = line.match(/\/\/\s*absence-ok:\s*(.+)$/m);
      if (waiver) waivers.push({ file, line: ev.line, why: waiver[1].trim() });
      else found.push({ file, line: ev.line, opener: open.kind, openedAt: open.line, text: t.replace(/\s+/g, ' ').slice(0, 110) });
    }
    let next = open;
    if (!absence && (POSITIVE_WAIT.test(t) || (WEB_FIRST.test(t) && isExpect))) next = null;
    if (OPEN_WAIT.test(t)) next = { kind: 'fixed wait', line: ev.line };
    else if (OPEN_NAV.test(t)) next = { kind: 'navigation', line: ev.line };
    stack[stack.length - 1] = next;
  }
  return { found, waivers };
}

/*
 * THE CHECK TESTS ITSELF FIRST. With every walk clean, a check that had gone blind would read green;
 * these synthetic walks keep it honest: each must yield exactly the number of failures named.
 */
const SELF = [
  { why: 'a fixed wait, then an absence', want: 1, src: "test('x', async ({ page }) => {\n  await page.goto('/a');\n  await expect(page.getByRole('heading', { name: 'A' })).toBeVisible();\n  await page.waitForTimeout(800);\n  await expect(page.getByTestId('b')).toHaveCount(0);\n});" },
  { why: 'a navigation, then an absence', want: 1, src: "test('x', async ({ page }) => {\n  await page.goto(`/a/${id}`);\n  await expect(page.getByTestId('b'), 'gone').toHaveCount(0);\n});" },
  { why: 'a positive anchor first', want: 0, src: "test('x', async ({ page }) => {\n  await page.goto('/a');\n  await expect(page.getByTestId(`row-${id}`)).toBeVisible();\n  await expect(page.getByTestId('b')).toHaveCount(0);\n});" },
  { why: 'an object literal and a regex are not code', want: 0, src: "test('x', async ({ page }) => {\n  await page.goto('/a');\n  await expect(page.getByRole('heading', { name: /Invoices \\(/ })).toBeVisible();\n  await expect(page.locator('a', { hasText: /x/ })).not.toBeVisible();\n});" },
  { why: "a helper's navigation stays in the helper", want: 0, src: "async function go(page) {\n  await page.goto('/a');\n}\ntest('x', async ({ page }) => {\n  await expect(page.getByTestId('b')).toHaveCount(0);\n});" },
];
function selfTest() {
  const bad = SELF.filter((c) => scan('self', c.src).found.length !== c.want);
  for (const c of bad) console.error(`RED check-absence-waits self-test: "${c.why}" gave ${scan('self', c.src).found.length} failure(s), not ${c.want}`);
  return bad.length === 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!selfTest()) process.exit(1);
  const all = [];
  const waived = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.spec.ts')).sort()) {
    const { found, waivers } = scan(f, readFileSync(resolve(dir, f), 'utf8'));
    all.push(...found);
    waived.push(...waivers);
  }
  for (const w of waived) console.log(`waived ${w.file}:${w.line} — ${w.why}`);
  if (process.argv.includes('--list')) {
    for (const f of all) console.log(`${f.file}:${f.line} after a ${f.opener} at ${f.openedAt}: ${f.text}`);
    const byKind = all.reduce((m, f) => ({ ...m, [f.opener]: (m[f.opener] ?? 0) + 1 }), {});
    console.log(`${all.length} absence assertion(s) with no positive wait since a fixed wait or a navigation: ${JSON.stringify(byKind)}; in ${new Set(all.map((f) => f.file)).size} walk file(s)`);
    process.exit(0);
  }
  for (const f of all) console.error(`RED ${f.file}:${f.line}: an absence after a ${f.opener} (line ${f.openedAt}) with no positive wait between them: ${f.text}`);
  if (all.length) process.exit(1);
  console.log(`check-absence-waits: every absence in ${readdirSync(dir).filter((n) => n.endsWith('.spec.ts')).length} walk files follows a positive wait${waived.length ? ` (${waived.length} waived, listed above)` : ''}.`);
}
