#!/usr/bin/env node
/**
 * Build guard — EVERY AUTOMATION THAT CAN CREATE WORK MUST RESOLVE TO AN OWNER.
 *
 * Brian's rule, 2026-08-17: "an unassigned task with no alert is work that doesn't exist,
 * and we've now proven that twice." So:
 *
 *   A task's owner is resolved with a resolver that FALLS BACK.
 *
 * `ownerForRole()` falls back to the CEO and returns null only when the firm has nobody at
 * all. `firstActiveByRole()` returns null the moment the named role is unfilled — and
 * production holds exactly one staff account, so `tax_preparer`, `comms_billing`,
 * `va_entity` and `bookkeeper` are ALL unfilled today.
 *
 * WHY THIS FILE WAS REWRITTEN. The first version encoded the SHAPE finding #17 took rather
 * than the rule it taught. #17 was a task and its alert both sitting inside `if (rene)`, so
 * the guard failed when `createTask` appeared inside an `if (x)` fed by
 * `firstActiveByRole`. It passed cleanly for months while the identical defect sat in the tax
 * pipeline: `recordEfileResult` called `createTask` UNCONDITIONALLY — no wrapping `if`, guard
 * satisfied — with an owner from `firstActiveByRole('tax_preparer')`. The task was created
 * unassigned and the alert, gated on `if (owner)`, never fired. A statutory perfection clock
 * started and nobody was told.
 *
 * A guard that cannot fail on a fresh instance of the rule being broken is a regression test
 * wearing a guard's clothes. So this now checks the rule directly, in two parts:
 *
 *   RULE 1 — the owner passed to createTask() must not come from a no-fallback resolver.
 *   RULE 2 — createTask() must not sit inside an `if (owner)` (the original #17 shape,
 *            still worth catching: it skips the work entirely rather than merely orphaning it).
 *
 * WHAT IS DELIBERATELY ALLOWED:
 *   · `firstActiveByRole(db, 'ceo')` — the CEO IS the fallback; asking for it directly is the
 *     end of the chain, not a missing link.
 *   · `firstActiveByRole` for anything that is not a task owner — an alert recipient, a
 *     report column, a fan-out list. Only `assignedStaffId` is governed here.
 *   · gating `notifyOnce()` on a real person. A notification row with no staff_id belongs to
 *     nobody's queue, so that `if` is correct and must stay.
 *
 * Run via `npm run check:role-tasks` (wired into `npm test`).
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

/** Resolvers that can return null while the firm still has staff. */
const NO_FALLBACK = 'firstActiveByRole';
/** The resolver that falls back. */
const WITH_FALLBACK = 'ownerForRole';

const files = execSync('grep -rl "createTask(" apps/api/src --include=*.ts', { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter((f) => f && !f.includes('tasks/service.ts')); // where createTask is defined

const violations = [];

/**
 * The expression a call passes as `assignedStaffId`.
 *
 * Scans forward from the `createTask(` line to the end of that call's argument object, so a
 * multi-line call — which is all of them — is read whole. Bounded rather than brace-matched:
 * a task literal running past 40 lines is a different problem.
 */
function assigneeExpression(lines, callLine) {
  for (let j = callLine; j < Math.min(callLine + 40, lines.length); j++) {
    const m = /assignedStaffId:\s*(.+?),?\s*$/.exec(lines[j]);
    if (m) return { expr: m[1].replace(/,$/, '').trim(), line: j };
    // Stop at the end of the call rather than wandering into the next statement.
    if (j > callLine && /^\s*\}\s*\)/.test(lines[j])) return null;
  }
  return null;
}

/**
 * Trace an expression back to the resolver that produced it.
 *
 * Inline resolvers are read directly. A bare identifier is looked up as a `const` (or a
 * reassignment) earlier in the file — the pattern every call site here uses.
 */
function resolverFor(lines, expr, upToLine) {
  if (expr.includes(WITH_FALLBACK)) return { kind: 'fallback' };
  const inline = new RegExp(NO_FALLBACK + "\\(\\s*[^,]+,\\s*'([^']+)'").exec(expr);
  if (inline) return { kind: 'no_fallback', role: inline[1] };

  // A bare identifier, possibly with a `??` in front of it.
  const ident = /^([A-Za-z_$][\w$]*)$/.exec(expr) ?? /\?\?\s*([A-Za-z_$][\w$]*)\s*$/.exec(expr);
  const name = ident?.[1];
  if (!name) return { kind: 'other' };

  for (let j = upToLine; j >= 0; j--) {
    const decl = new RegExp('(?:const|let)\\s+' + name + '\\s*(?::[^=]+)?=\\s*(.+)$').exec(lines[j]);
    if (!decl) continue;
    const rhs = decl[1];
    if (rhs.includes(WITH_FALLBACK)) return { kind: 'fallback' };
    const m = new RegExp(NO_FALLBACK + "\\(\\s*[^,]+,\\s*'([^']+)'").exec(rhs);
    if (m) return { kind: 'no_fallback', role: m[1], declLine: j };
    /*
     * The declaration may resolve on a following line — `const x =\n  await f(...)`. One
     * lookahead covers every case in this codebase; more would start guessing.
     */
    const next = lines[j + 1] ?? '';
    if (next.includes(WITH_FALLBACK)) return { kind: 'fallback' };
    const m2 = new RegExp(NO_FALLBACK + "\\(\\s*[^,]+,\\s*'([^']+)'").exec(next);
    if (m2) return { kind: 'no_fallback', role: m2[1], declLine: j };
    return { kind: 'other' };
  }
  return { kind: 'other' };
}

/**
 * The file with every comment blanked, line numbers preserved.
 *
 * Written because the guard flagged its OWN fix: the comment explaining that createTask used
 * to sit inside `if (ceo)` contains the string "if (ceo)", and the scan matched the prose. A
 * guard that reads documentation as code will keep finding the sentence that describes the bug
 * it just fixed, which is a very good way to make people stop trusting it.
 */
function codeOnly(src) {
  const out = [];
  let inBlock = false;
  for (const raw of src.split('\n')) {
    let line = raw;
    if (inBlock) {
      const close = line.indexOf('*/');
      if (close === -1) {
        out.push('');
        continue;
      }
      line = ' '.repeat(close + 2) + line.slice(close + 2);
      inBlock = false;
    }
    // Block comments opening on this line (possibly closing on it too).
    for (;;) {
      const open = line.indexOf('/*');
      if (open === -1) break;
      const close = line.indexOf('*/', open + 2);
      if (close === -1) {
        line = line.slice(0, open);
        inBlock = true;
        break;
      }
      line = line.slice(0, open) + ' '.repeat(close + 2 - open) + line.slice(close + 2);
    }
    const slash = line.indexOf('//');
    if (slash !== -1) line = line.slice(0, slash);
    out.push(line);
  }
  return out;
}

for (const file of files) {
  const lines = codeOnly(readFileSync(file, 'utf8'));

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('createTask(')) continue;
    if (/^\s*(\/\/|\*)/.test(lines[i])) continue; // a mention in a comment

    // ── RULE 1: the assignee must come from a resolver that falls back ──
    const assignee = assigneeExpression(lines, i);
    if (assignee) {
      const resolved = resolverFor(lines, assignee.expr, assignee.line);
      // Asking for the CEO directly IS the fallback.
      if (resolved.kind === 'no_fallback' && resolved.role !== 'ceo') {
        violations.push({
          rule: 1,
          file,
          line: (resolved.declLine ?? assignee.line) + 1,
          role: resolved.role,
          expr: assignee.expr,
        });
      }
    }
  }

  /*
   * ── RULE 2: createTask must not be SKIPPED because the owner is missing ──
   *
   * Watches variables from EITHER resolver, not just the no-fallback one. `ownerForRole`
   * satisfies rule 1 and still returns null when the firm has nobody at all, so
   * `if (owner) { createTask(...) }` remains "no staff, no record of the work" — which is the
   * rule being broken, however good the resolver is. Rule 1 is about the owner being
   * resolvable; rule 2 is about the work existing either way.
   */
  for (let i = 0; i < lines.length; i++) {
    const assign = new RegExp(
      'const\\s+(\\w+)\\s*=\\s*(?:[\\w.]+\\s*\\?\\?\\s*)?\\(?\\s*await\\s+(' +
        NO_FALLBACK + '|' + WITH_FALLBACK + ")\\(\\s*[^,]+,\\s*'([^']+)'"
    ).exec(lines[i]);
    if (!assign) continue;
    const [, varName, , role] = assign;

    /*
     * The owner appearing ANYWHERE in an `if` condition, not only as its sole operand.
     *
     * The first version of this matched `if (owner)` exactly, and `dunning.ts` gated its call
     * task on `if (attempts >= MAX && rene)` — the identical defect wearing a compound
     * condition. That is the same mistake this whole file was rewritten to stop making:
     * matching the shape an incident happened to take instead of the rule.
     *
     * Scans the whole condition, so `&&`, `!== null` and `? :` forms are all caught. The
     * `\b` boundaries keep `rene` from matching `renewal`.
     */
    let ifLine = -1;
    const guard = new RegExp('if\\s*\\([^)]*\\b' + varName + '\\b');
    for (let j = i; j < Math.min(i + 12, lines.length); j++) {
      if (guard.test(lines[j])) {
        ifLine = j;
        break;
      }
    }
    if (ifLine === -1) continue;

    let depth = 0;
    let started = false;
    let endLine = ifLine;
    for (let j = ifLine; j < Math.min(ifLine + 80, lines.length); j++) {
      for (const ch of lines[j]) {
        if (ch === '{') {
          depth += 1;
          started = true;
        } else if (ch === '}') {
          depth -= 1;
        }
      }
      endLine = j;
      if (started && depth <= 0) break;
    }

    if (lines.slice(ifLine, endLine + 1).join('\n').includes('createTask(')) {
      violations.push({ rule: 2, file, line: i + 1, role, varName });
    }
  }
}

if (violations.length > 0) {
  const r1 = violations.filter((v) => v.rule === 1);
  const r2 = violations.filter((v) => v.rule === 2);
  console.error(`\n✗ ${violations.length} task owner(s) that can silently resolve to nobody:\n`);

  for (const v of r1) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(
      `      assignedStaffId comes from ${NO_FALLBACK}(…, '${v.role}'), which returns null the`
    );
    console.error(
      `      moment '${v.role}' is unfilled — and it is unfilled today. The task would be created`
    );
    console.error(`      with no owner, and any alert gated on it would not fire.`);
    console.error(`      Fix: ${WITH_FALLBACK}(app.db, '${v.role}')  — falls back to the CEO.\n`);
  }
  for (const v of r2) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(
      `      createTask() sits inside \`if (${v.varName})\`, and '${v.role}' may have no active staff,`
    );
    console.error(`      so the work is skipped entirely rather than merely left unowned.`);
    console.error(
      `      Fix: const ${v.varName} = await ${WITH_FALLBACK}(app.db, '${v.role}');  create the task`
    );
    console.error(`      unconditionally, and keep only notifyOnce() inside the if.\n`);
  }
  console.error(
    'THE RULE (Brian, 2026-08-17): every automation that can create work must resolve to an\n' +
      'owner, CEO fallback until staff exist. Proven twice — finding #17, and the perfection\n' +
      'clock that started with nobody watching it.\n'
  );
  process.exit(1);
}

console.log(
  `✓ Every task owner resolves through a resolver with a fallback (${files.length} files creating tasks).`
);
