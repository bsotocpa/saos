#!/usr/bin/env node
/*
 * EVERY CLIENT-FACING SEND IS EITHER GATED OR REGISTERED.
 *
 * CLAUDE.md: "A client-facing send without a registered toggle + gate check is a build failure."
 * That sentence had no enforcement until now, which is how `sos_fix_steps` — the adverse
 * good-standing email — shipped with no `isAutomationEnabled()` check and no automations row, and
 * sat in the tree for weeks past seven other guards. None of them was looking for this class.
 *
 * It never reached a client, but only because the code path that triggers it never once
 * completed. Two defects cancelling out is not a control.
 *
 * ── WHAT THIS CHECKS ──
 *
 * For every call to a client-send primitive (`sendTemplatedEmail`, `sendSms`) in the API source:
 * the enclosing function must either call `isAutomationEnabled(...)`, or be listed in
 * `modules/comms/client-sends.ts` with a written reason.
 *
 * ── WHY "ENCLOSING FUNCTION" AND NOT SOMETHING TIGHTER ──
 *
 * A tighter rule — the gate must be the immediately-enclosing `if` — would be more precise and
 * also wrong often enough to be routed around: real code computes `const armed = await
 * isAutomationEnabled(...)` early and branches later, or gates a loop rather than each send. A
 * guard people learn to work around is worse than none. Function scope is the unit a reviewer
 * actually reads: a gate anywhere in it means somebody thought about arming, and a function with
 * no mention of it means nobody did.
 *
 * The registry holds the "nobody did, deliberately" cases with the reason attached — the same
 * discipline as `sop: null` in the task-type registry.
 *
 * Run via `npm run check:client-sends` (wired into `npm test`).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'apps', 'api', 'src');
const REGISTRY = join(SRC, 'modules', 'comms', 'client-sends.ts');

/** The primitives that put a message in front of a CLIENT. Staff alerts are not these. */
const SEND_CALLS = /\b(sendTemplatedEmail|sendSms)\s*\(/;
/** Their own definitions are not call sites. */
const DEFINITION = /export\s+async\s+function\s+(sendTemplatedEmail|sendSms)\b/;
const GATE = /isAutomationEnabled\s*\(/;

const FN_DECL = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/;
/*
 * A const that is actually a FUNCTION. The lookahead for `=>` or `function` is the whole point:
 * without it, `const text = (es ? b.sms_es : b.sms_en) ?? '';` matched as a function declaration
 * and the broadcast SMS send was attributed to a function called `text` — a key that names
 * nothing, would not survive a rename, and told a reader to go looking for something that does
 * not exist.
 */
const CONST_FN =
  /(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*(?::[^=]*?)?=\s*(?:async\s+)?(?:\([^)]*\)\s*(?::[^=]*?)?=>|[A-Za-z0-9_]+\s*=>|function\b)/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.ts$/.test(entry)) yield full;
  }
}

/**
 * Blank out comments and string contents, keeping line structure.
 *
 * A single left-to-right scan rather than a stack of regexes. Regexes cross-pair: a backtick
 * inside a single-quoted string starts a "template literal" that swallows real code until the
 * next backtick, and the damage is silent. This codebase writes SQL in multi-line template
 * literals on nearly every page, so that mattered.
 *
 * Blanking is load-bearing rather than cosmetic — the brace counter below must not count a brace
 * that lives inside a query string or a `${...}` interpolation.
 */
function codeOnly(text) {
  let out = '';
  let i = 0;
  const keep = (ch) => (ch === '\n' ? '\n' : ' ');
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i++) out += keep(text[i]);
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') out += keep(text[i++]);
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ' ';
      i++;
      while (i < text.length) {
        if (text[i] === '\\') {
          out += keep(text[i]);
          if (i + 1 < text.length) out += keep(text[i + 1]);
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          out += ' ';
          i++;
          break;
        }
        out += keep(text[i++]);
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Which named function owns each line, by a forward scan with a stack.
 *
 * The INNERMOST named function wins. Route files register handlers as anonymous arrows inside one
 * exported `registerXRoutes`, so a send in a handler attributes to that registrar — which is the
 * unit the registry keys on, and is honest about how much a reviewer has to read to see whether
 * arming was considered.
 *
 * A backward brace-walk was tried first and got this wrong for every route file, reporting
 * "(top level)" for seven real send sites. A guard that cannot say WHERE the problem is does not
 * get acted on, so this was worth doing properly.
 */
function ownersByLine(lines) {
  const owner = new Array(lines.length).fill(null);
  const stack = [];
  let depth = 0;
  /*
   * A NAME WAITING FOR ITS BRACE. Every important function in this codebase has a multi-line
   * signature —
   *
   *     export async function issueMagicLink(
   *       app: FastifyInstance,
   *       …
   *     ): Promise<void> {
   *
   * — so requiring the name and the `{` on one line missed six real send sites and called them
   * "(top level)". The name is remembered until a brace opens, and forgotten if one does not
   * arrive within a signature's worth of lines.
   */
  let pending = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = FN_DECL.exec(line) || CONST_FN.exec(line);
    if (m) pending = { name: m[1], line: i };

    const depthBefore = depth;
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        while (stack.length > 0 && stack[stack.length - 1].depth > depth) stack.pop();
      }
    }

    if (depth > depthBefore && pending && i - pending.line <= 20) {
      stack.push({ name: pending.name, depth: depthBefore + 1, start: i });
      pending = null;
    } else if (depth > depthBefore) {
      pending = null; // a block that is not a function body
    }
    /*
     * The line records its innermost function AND that function's start line, so the gate check
     * can read the WHOLE body rather than a contiguous run of identically-owned lines. Those two
     * are not the same thing: a nested arrow between the gate and the send breaks the run, which
     * is precisely what happened with `runDocumentChaseJob` — it checks
     * `isAutomationEnabled(app, 'document_chase')` twenty-six lines above its send, and the guard
     * called it ungated because a callback sat in between.
     */
    const top = stack.length > 0 ? stack[stack.length - 1] : null;
    owner[i] = top ? { name: top.name, start: top.start } : null;
  }
  return owner;
}

/** The whole body of the function owning `index`, from its opening line to where it closes. */
function bodyOfOwner(lines, owners, index) {
  const own = owners[index];
  if (!own) return lines.join('\n');
  let end = index;
  while (end < lines.length - 1 && owners[end + 1] && owners[end + 1].start === own.start) end++;
  return lines.slice(own.start, end + 1).join('\n');
}

/** Registered keys, read from the registry source so this needs no TypeScript loader. */
const registrySource = readFileSync(REGISTRY, 'utf8');
const registered = new Set([...registrySource.matchAll(/^\s{2}'([^']+)':\s*\{/gm)].map((m) => m[1]));
if (registered.size === 0) {
  console.error('✖ Could not parse UNGATED_CLIENT_SENDS — the checker needs updating alongside the registry.');
  process.exit(1);
}

/* A registered entry with no reason is a parked decision, which is the thing this prevents. */
const entryBlocks = [...registrySource.matchAll(/^\s{2}'([^']+)':\s*\{([\s\S]*?)^\s{2}\},/gm)];
const missingReason = entryBlocks.filter(([, , body]) => !/reason:\s*\S/.test(body)).map(([, k]) => k);

const violations = [];
const seen = new Set();

for (const file of walk(SRC)) {
  if (file === REGISTRY) continue;
  const rel = relative(SRC, file).split('\\').join('/');
  const raw = readFileSync(file, 'utf8');
  const rawLines = raw.split(/\r?\n/);
  const lines = codeOnly(raw).split(/\r?\n/);
  const owners = ownersByLine(lines);

  for (let i = 0; i < lines.length; i++) {
    if (!SEND_CALLS.test(lines[i]) || DEFINITION.test(lines[i])) continue;

    const key = `${rel}:${owners[i]?.name ?? '(top level)'}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (!GATE.test(bodyOfOwner(lines, owners, i)) && !registered.has(key)) {
      violations.push({ key, line: i + 1, text: (rawLines[i] ?? '').trim().slice(0, 100) });
    }
  }
}

const stale = [...registered].filter((k) => !seen.has(k));

if (missingReason.length > 0) {
  console.error('✖ Registered client sends with no reason:\n');
  for (const k of missingReason) console.error(`  ${k}`);
  console.error('\n  A registry entry without a reason is a decision nobody made.');
  process.exit(1);
}

if (violations.length > 0) {
  console.error('✖ Client-facing sends that are neither gated nor registered.\n');
  console.error('  CLAUDE.md: "A client-facing send without a registered toggle + gate check is a');
  console.error('  build failure." Either wrap it in isAutomationEnabled(...) and register the');
  console.error('  automation, or add it to apps/api/src/modules/comms/client-sends.ts with the');
  console.error('  reason it is not an automation — a client asked for it, or a person pressed send.\n');
  for (const v of violations) {
    console.error(`  ${v.key}   (line ${v.line})`);
    console.error(`    ${v.text}`);
  }
  process.exit(1);
}

if (stale.length > 0) {
  console.log(`⚠ ${stale.length} registered ungated send(s) no longer found in the code:`);
  for (const k of stale) console.log(`    ${k}`);
  console.log('  Stale, not dangerous — remove them when convenient.');
}

console.log(
  `✓ Every client-facing send is gated or registered with a reason ` +
    `(${seen.size} send site(s), ${registered.size} registered ungated).`
);
