#!/usr/bin/env node
/**
 * Build guard — an SOP that explains a task's checklist must have a section per step, in order.
 *
 * Brian's instruction, 2026-08-17: "draft it against the six-step task checklist so the SOP and
 * the task literally share structure — the SOP explains each step the task already names,
 * nothing to drift."
 *
 * WHY A GUARD AND NOT ONE SHARED MODULE. Sharing the array would make drift impossible rather
 * than merely detected, which is better, and it is not available here: the steps live in
 * `apps/api/src/…` and the SOP body in `packages/db/seeds/data/sops.mjs`, and `@saos/db` is a
 * DEV dependency of apps/api. Importing across that edge would put a dev-only package on a
 * production code path to save a guard — the wrong trade. So the two artifacts stay where they
 * belong and this fails the build when they disagree.
 *
 * WHAT IT CHECKS, for each pairing below:
 *   1. every checklist step has a matching `### N. <step text>` heading in the SOP
 *   2. the headings are in the SAME ORDER as the steps
 *   3. the SOP has no numbered step headings the checklist does not name
 *
 * (3) matters as much as (1): a section for a step the task never shows is a step nobody will
 * do, which is how an SOP starts describing a procedure the system does not run.
 *
 * Run via `npm run check:sop-steps` (wired into `npm test`).
 */

import { readFileSync } from 'node:fs';

/**
 * Task checklists that have an explaining SOP.
 *
 * `stepsVar` is the `const` array in `source` that becomes the task's checklist. Add a row here
 * when a task's checklist gets an SOP; the guard then holds them together.
 */
const PAIRINGS = [
  {
    label: 'PLLC conversion',
    source: 'apps/api/src/modules/entity/service.ts',
    stepsVar: 'conversionSteps',
    sopSlug: 'laura-pllc-conversion',
  },
  {
    label: 'IL SOS restoration',
    source: 'apps/api/src/modules/entity/sos.ts',
    stepsVar: 'SOS_RESTORE_STEPS',
    sopSlug: 'laura-sos-restore',
  },
  {
    // The MANUAL lookup (2026-09-06). ILSOS refused automated querying in writing, so the
    // procedure is a person in a browser and the SOP has to actually walk it.
    label: 'IL SOS verification (manual)',
    source: 'apps/api/src/modules/entity/sos.ts',
    stepsVar: 'SOS_VERIFY_STEPS',
    sopSlug: 'laura-sos-verify',
  },
  {
    label: 'Annual report filing',
    source: 'apps/api/src/modules/entity/service.ts',
    stepsVar: 'annualReportSteps',
    sopSlug: 'laura-annual-report',
  },
];

const SOPS = 'packages/db/seeds/data/sops.mjs';

/** The string literals of a `const NAME = [ … ];` array, in order. */
function stepsFrom(source, varName) {
  const src = readFileSync(source, 'utf8');
  const start = src.indexOf(`const ${varName} = [`);
  if (start === -1) throw new Error(`${source}: no 'const ${varName} = [' — the guard needs updating alongside the code.`);
  const end = src.indexOf('];', start);
  if (end === -1) throw new Error(`${source}: '${varName}' array is not closed.`);
  const body = src.slice(start, end);
  return [...body.matchAll(/'((?:[^'\\]|\\.)*)'/g)]
    .map((m) => m[1].replace(/\\'/g, "'"))
    .filter((s) => s.length > 0);
}

/**
 * The markdown body of one `sop('slug', …, \`body\`)` entry.
 *
 * ESCAPED BACKTICKS ARE SKIPPED. The first version took the next backtick as the end of the
 * body, and the PLLC SOP cross-references another SOP slug in code ticks — so the body was cut
 * at step 2 and the guard reported four missing sections that were sitting right there.
 *
 * Worth recording because of how it failed: a truncating parser reports MISSING content, which
 * reads exactly like the drift this guard exists to catch. Had the headings happened to sit
 * before the escape, it would have passed while checking a third of the file.
 */
function sopBody(slug) {
  const src = readFileSync(SOPS, 'utf8');
  const marker = `sop('${slug}'`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`${SOPS}: no SOP with slug '${slug}'.`);
  const open = src.indexOf('`', start);
  if (open === -1) throw new Error(`${SOPS}: '${slug}' has no template-literal body.`);

  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === '\\') {
      i += 1; // an escaped character, backtick or otherwise
      continue;
    }
    if (src[i] === '`') return src.slice(open + 1, i);
  }
  throw new Error(`${SOPS}: '${slug}' body is not closed.`);
}

const problems = [];

/*
 * ── An SOP must be filed under a role that EXISTS ──
 *
 * `laura-annual-report` shipped with `role_key: 'entity_admin'`, which is not one of the ten
 * roles. The SOP list filters by role (sops/service.ts builds a `role_key = $n` clause), so
 * Laura — whose role is `va_entity` — could never surface her own annual-report procedure. A
 * written SOP nobody can find is the same as an unwritten one, and it fails silently: nothing
 * errors, the page simply never appears.
 *
 * `null` is allowed and deliberate: the two booking SOPs are not role-specific.
 */
const ROLES = 'packages/db/seeds/data/roles.mjs';
const roleKeys = new Set(
  [...readFileSync(ROLES, 'utf8').matchAll(/^\s*key: '([a-z_]+)',/gm)].map((m) => m[1])
);
if (roleKeys.size === 0) {
  problems.push(`${ROLES}: parsed ZERO role keys — the guard is not reading what it thinks it is.`);
}

const sopsSrc = readFileSync(SOPS, 'utf8');
for (const m of sopsSrc.matchAll(/sop\('([a-z0-9-]+)',\s*'[^']*',\s*(null|'([a-z_]+)')/g)) {
  const [, slug, rawRole, role] = m;
  if (rawRole === 'null') continue; // not role-specific, on purpose
  if (!roleKeys.has(role)) {
    problems.push(
      `SOP '${slug}' is filed under role '${role}', which is not a role in ${ROLES}.\n` +
        `      Roles: ${[...roleKeys].join(', ')}\n` +
        `      The SOP list filters by role, so nobody can find this page. Use a real role, or null` +
        ` if it belongs to no one role.`
    );
  }
}

for (const p of PAIRINGS) {
  const steps = stepsFrom(p.source, p.stepsVar);
  const body = sopBody(p.sopSlug);

  // `### 3. Advisory session scheduled with client` → { n: 3, text: '…' }
  const headings = [...body.matchAll(/^### (\d+)\.\s*(.+?)\s*$/gm)].map((m) => ({
    n: Number(m[1]),
    text: m[2],
  }));

  if (steps.length === 0) {
    problems.push(`${p.label}: parsed ZERO steps from ${p.stepsVar} in ${p.source} — the guard is not reading what it thinks it is.`);
    continue;
  }

  for (const [i, step] of steps.entries()) {
    const want = `### ${i + 1}. ${step}`;
    const h = headings[i];
    if (!h) {
      problems.push(`${p.label}: step ${i + 1} has no section in '${p.sopSlug}'.\n      Add:  ${want}`);
      continue;
    }
    if (h.n !== i + 1 || h.text !== step) {
      problems.push(
        `${p.label}: step ${i + 1} and its SOP section disagree.\n` +
          `      task: ${step}\n` +
          `      SOP:  ### ${h.n}. ${h.text}\n` +
          `      The heading must be the checklist item verbatim: ${want}`
      );
    }
  }

  for (const extra of headings.slice(steps.length)) {
    problems.push(
      `${p.label}: '${p.sopSlug}' has a section for a step the task does not name.\n` +
        `      ### ${extra.n}. ${extra.text}\n` +
        `      A step nobody is shown is a step nobody does — remove it, or add it to ${p.stepsVar}.`
    );
  }
}

if (problems.length > 0) {
  console.error(`\n✗ ${problems.length} place(s) where an SOP and its task checklist have drifted:\n`);
  for (const m of problems) console.error(`  ${m}\n`);
  console.error(
    'The SOP explains each step the task NAMES, so the two must stay in lockstep. Editing one\n' +
      'without the other leaves a procedure describing work the queue does not ask for.\n'
  );
  process.exit(1);
}

const total = PAIRINGS.reduce((n, p) => n + stepsFrom(p.source, p.stepsVar).length, 0);
console.log(
  `✓ Every SOP section matches its task checklist step, in order ` +
    `(${PAIRINGS.length} pairing(s), ${total} steps).`
);
