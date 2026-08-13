#!/usr/bin/env node
/**
 * Build guard — a task must never be skipped because its intended owner does not exist.
 *
 * FINDING #17. Brian accepted a quote and nothing happened. The quote logic was fine:
 * the notification AND the task were both inside `if (rene)`, and `comms_billing` is a
 * role nobody holds yet. The engagement row was created, every visible consequence was
 * skipped, and from every screen he could see, acceptance vanished into the void.
 *
 * An audit found 21 sites with that shape, 13 of which skipped an actual task. Eight
 * were for roles nobody holds — three of them on the rehearsal path.
 *
 * So the rule, enforced here rather than remembered:
 *
 *   Resolve assignees with ownerForRole() — it falls back to the CEO and returns null
 *   only when the firm has nobody at all. Then create the task UNCONDITIONALLY and
 *   pass the (nullable) owner as assignedStaffId. An unassigned task in the queue is
 *   visible; a skipped task is not. Gate only notifyOnce() on having a real person.
 *
 * This check fails when createTask() appears inside an `if (x)` whose x came from
 * firstActiveByRole() — the resolver with no fallback. Using ownerForRole() is the
 * signal that the author thought about who owns the work when the role is empty.
 *
 * Run via `npm run check:role-tasks` (wired into `npm test`).
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const files = execSync('grep -rl firstActiveByRole apps/api/src --include=*.ts', { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter((f) => f && !f.includes('staffing.ts'));

const violations = [];

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const assign = /const\s+(\w+)\s*=\s*await\s+firstActiveByRole\(\s*[^,]+,\s*'([^']+)'/.exec(lines[i]);
    if (!assign) continue;
    const [, varName, role] = assign;

    let ifLine = -1;
    const guard = new RegExp('if\\s*\\(\\s*' + varName + '\\s*\\)');
    for (let j = i; j < Math.min(i + 6, lines.length); j++) {
      if (guard.test(lines[j])) {
        ifLine = j;
        break;
      }
    }
    if (ifLine === -1) continue;

    // Walk braces from the `if` to the end of its block.
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
      violations.push({ file, line: i + 1, role, varName });
    }
  }
}

if (violations.length > 0) {
  console.error(
    `\n✗ ${violations.length} task creation(s) gated on a role that may not be filled:\n`
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(
      `      createTask() sits inside \`if (${v.varName})\`, and '${v.role}' may have no active staff.`
    );
    console.error(
      `      Fix: const ${v.varName} = await ownerForRole(app.db, '${v.role}');  then create the`
    );
    console.error(
      `      task unconditionally with assignedStaffId: ${v.varName}, and keep only notifyOnce()`
    );
    console.error(`      inside the if.\n`);
  }
  console.error(
    'This is finding #17: an unfilled role must never cancel the work. An unassigned\n' +
      'task in the queue is visible; a skipped task is not.\n'
  );
  process.exit(1);
}

console.log(
  `✓ No task creation is gated on an unfilled role (${files.length} files with role routing).`
);
