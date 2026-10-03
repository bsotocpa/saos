#!/usr/bin/env node
/*
 * A RECEIPT RUNS ONLY FROM THE COMMITTED HELPERS (Brian, 2026-10-03, R125).
 *
 * The scripts that start a receipt (detached, the display held awake) lived in a session's scratch folder
 * and then in a folder outside the repo: a new session would not have found them, and nothing said which
 * copy a receipt had run from. They are committed under scripts/receipt/, and this check holds the root
 * suite to them.
 *
 *   node scripts/check-receipt-runner.mjs             (npm run check:receipt-runner)
 *       the helpers are all there, tracked by git and identical to their committed copies; and the
 *       verdict below tests itself on synthetic launches.
 *   node scripts/check-receipt-runner.mjs --receipt   (second in the root `npm test`)
 *       all of that, and THIS run was started by the committed scripts/receipt/run-receipt.sh of this
 *       checkout: the runner names itself (SAOS_RECEIPT_RUNNER) and its own hash (SAOS_RECEIPT_RUNNER_SHA),
 *       and both must match the committed copy here. A plain `npm test`, a copy kept anywhere else, or an
 *       edited runner is refused in the first seconds, with the way to start a receipt.
 *
 * It guards against the wrong copy and the forgotten step, not against a person set on fooling it.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HELPERS = ['_lib.sh', 'run-receipt.sh', 'run-harness.sh', 'run-sabotage.sh', 'hold-awake.ps1'];
const RUNNER = 'scripts/receipt/run-receipt.sh';
const HOW = `Start a receipt with the committed runner of the checkout under test, detached: bash <checkout>/${RUNNER} <log> (scripts/receipt/_lib.sh says how).`;

const same = (a, b) => resolve(a).replace(/\\/g, '/').toLowerCase() === resolve(b).replace(/\\/g, '/').toLowerCase();

/** Was this run started by the committed runner of this checkout? `facts`: the checkout root and the committed runner's hash. */
export function verdict(env, facts) {
  const runner = env.SAOS_RECEIPT_RUNNER;
  if (!runner) return { ok: false, why: 'this run was not started by the receipt runner (a plain `npm test`)' };
  if (!same(runner, resolve(facts.root, RUNNER))) return { ok: false, why: `the runner that started this run (${runner}) is not this checkout's committed ${RUNNER}` };
  if (!env.SAOS_RECEIPT_RUNNER_SHA || env.SAOS_RECEIPT_RUNNER_SHA.toLowerCase() !== facts.runnerSha) return { ok: false, why: 'the runner that started this run is not byte for byte the committed copy' };
  return { ok: true, why: 'started by the committed runner' };
}

function selfTest() {
  const facts = { root: 'C:/x/checkout', runnerSha: 'a'.repeat(64) };
  const good = { SAOS_RECEIPT_RUNNER: 'C:/x/checkout/scripts/receipt/run-receipt.sh', SAOS_RECEIPT_RUNNER_SHA: 'a'.repeat(64) };
  const cases = [
    ['a plain npm test, no runner', {}, false],
    ['a copy of the runner kept outside the checkout', { ...good, SAOS_RECEIPT_RUNNER: 'C:/Users/someone/saos-shots/receipt-tools/run-receipt.sh' }, false],
    ["another checkout's runner", { ...good, SAOS_RECEIPT_RUNNER: 'C:/x/other/scripts/receipt/run-receipt.sh' }, false],
    ['a runner whose bytes differ from the committed copy', { ...good, SAOS_RECEIPT_RUNNER_SHA: 'b'.repeat(64) }, false],
    ['a runner that names no hash', { SAOS_RECEIPT_RUNNER: good.SAOS_RECEIPT_RUNNER }, false],
    ['the committed runner of this checkout', good, true],
    ['the committed runner, its path written the Windows way', { ...good, SAOS_RECEIPT_RUNNER: 'c:\\x\\checkout\\scripts\\receipt\\run-receipt.sh' }, true],
  ];
  const bad = cases.filter(([, env, want]) => verdict(env, facts).ok !== want);
  for (const [name, , want] of bad) console.error(`RED check-receipt-runner self-test: "${name}" was ${want ? 'refused' : 'accepted'}`);
  return bad.length === 0;
}

const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!selfTest()) process.exit(1);
  const problems = [];
  for (const h of HELPERS) {
    const rel = `scripts/receipt/${h}`;
    if (!existsSync(resolve(root, rel))) { problems.push(`${rel} is missing`); continue; }
    if (git(['ls-files', '--error-unmatch', rel]).status !== 0) { problems.push(`${rel} is not committed (git does not track it)`); continue; }
    if (git(['diff', '--quiet', 'HEAD', '--', rel]).status !== 0) problems.push(`${rel} differs from its committed copy`);
  }
  if (process.argv.includes('--receipt') && problems.length === 0) {
    const runnerSha = createHash('sha256').update(readFileSync(resolve(root, RUNNER))).digest('hex');
    const v = verdict(process.env, { root, runnerSha });
    if (!v.ok) problems.push(`${v.why}. ${HOW}`);
  }
  for (const p of problems) console.error(`RED ${p}`);
  if (problems.length) { console.error('check-receipt-runner: the root suite stops here; no receipt is written.'); process.exit(1); }
  console.log(process.argv.includes('--receipt')
    ? 'check-receipt-runner: this run was started by the committed scripts/receipt/run-receipt.sh of this checkout.'
    : `check-receipt-runner: the ${HELPERS.length} receipt helpers are committed and unchanged.`);
}
