#!/usr/bin/env node
/*
 * THE PUSH REFUSES WITHOUT A GREEN ROOT-SUITE RUN ON THIS EXACT TREE (Brian, 2026-09-12).
 *
 * Twice in one week code reached the box after "ran only the spec": a native confirm dialog the
 * build guard refuses, and a stale grant assertion. Both self-reported, both caught late, and the
 * norm did not hold on its own. So the norm is a receipt:
 *
 *   record   runs LAST in the root `npm test` (package.json). It hashes the working tree, every
 *            tracked and untracked non-ignored file, the way git would commit it, and writes
 *            .green-runs/<tree>.json. Nothing else writes there. A workspace run, a single spec,
 *            a guard on its own: none of them reach this line.
 *   require  runs FIRST in scripts/deploy.sh and in the pre-push hook. It refuses unless (a) the
 *            working tree is exactly HEAD's tree, because deploy ships HEAD, not the working
 *            tree (lessons.md, 2026-09-08), and (b) a receipt exists for that tree.
 *   install-hooks  points git at .githooks (npm prepare).
 *
 * The receipt is keyed to the tree hash, so editing one byte after the run needs another run,
 * and a run on a different machine or branch proves nothing here. There is no expiry: the same
 * bytes are the same bytes.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPTS = join(ROOT, '.green-runs');

function git(args, env = {}) {
  return execFileSync('git', args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' }).trim();
}

/** The tree hash of the WORKING TREE: tracked and untracked, ignored excluded, as a commit would see it. */
function workingTreeHash() {
  const tmpIndex = join(ROOT, '.git', `green-run-index-${process.pid}`);
  try {
    const env = { GIT_INDEX_FILE: tmpIndex };
    git(['read-tree', 'HEAD'], env);
    git(['add', '-A'], env);
    return git(['write-tree'], env);
  } finally {
    if (existsSync(tmpIndex)) unlinkSync(tmpIndex);
  }
}

function headTreeHash() {
  return git(['rev-parse', 'HEAD^{tree}']);
}

const mode = process.argv[2];

if (mode === 'record') {
  const tree = workingTreeHash();
  mkdirSync(RECEIPTS, { recursive: true });
  const receipt = { tree, head: git(['rev-parse', 'HEAD']), recordedAt: new Date().toISOString(), by: 'root npm test' };
  writeFileSync(join(RECEIPTS, `${tree}.json`), JSON.stringify(receipt, null, 2));
  console.log(`green-run: recorded a green root-suite run for tree ${tree.slice(0, 12)}`);
  process.exit(0);
}

if (mode === 'require') {
  const working = workingTreeHash();
  const head = headTreeHash();
  if (working !== head) {
    console.error(
      `green-run: REFUSED. The working tree (${working.slice(0, 12)}) is not HEAD's tree (${head.slice(0, 12)}). ` +
        `Deploy ships HEAD; commit or stash everything, then run the root \`npm test\` on that commit.`
    );
    process.exit(1);
  }
  const file = join(RECEIPTS, `${head}.json`);
  if (!existsSync(file)) {
    console.error(
      `green-run: REFUSED. No green root-suite run is recorded for tree ${head.slice(0, 12)}. ` +
        `Run \`npm test\` from the repo root on this exact commit; a workspace run or a single spec does not count.`
    );
    process.exit(1);
  }
  const receipt = JSON.parse(readFileSync(file, 'utf8'));
  console.log(`green-run: ok — root suite green on this tree at ${receipt.recordedAt}`);
  process.exit(0);
}

if (mode === 'install-hooks') {
  try {
    git(['config', 'core.hooksPath', '.githooks']);
    console.log('green-run: git hooks installed (.githooks)');
  } catch (err) {
    console.log(`green-run: could not install hooks (${err.message.split('\n')[0]}); deploy.sh still refuses.`);
  }
  process.exit(0);
}

console.error('usage: node scripts/green-run.mjs record | require | install-hooks');
process.exit(2);
