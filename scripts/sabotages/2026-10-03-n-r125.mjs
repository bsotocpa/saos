/*
 * Batch 19 (Brian, 2026-10-03): R125, the receipt runs only from the committed helpers
 * (scripts/check-receipt-runner.mjs, npm run check:receipt-runner). Three items loosen the verdict one
 * way each, and the check's own synthetic launches must refuse it; the last edits a helper without
 * committing it, and the check must name the file.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-10-03-n-r125.mjs
 */
export const date = '2026-10-03';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };
const swap = (from, to) => (t) => { must(t, from); return t.replace(from, to); };
const check = { kind: 'guard', spec: 'check:receipt-runner' };
const file = 'scripts/check-receipt-runner.mjs';

export const items = [
  {
    item: 'R125: a plain npm test is taken for a receipt',
    file,
    change: 'a run that names no runner is accepted; the self-test must refuse the check',
    test: check,
    apply: swap("if (!runner) return { ok: false, why:", "if (!runner) return { ok: true, why:"),
    expectRed: /self-test: "a plain npm test, no runner" was accepted/,
  },
  {
    item: 'R125: a copy of the runner kept outside the checkout is accepted',
    file,
    change: "the runner's path is no longer held to this checkout's committed copy",
    test: check,
    apply: swap("if (!same(runner, resolve(facts.root, RUNNER))) return", "if (false) return"),
    expectRed: /self-test: "a copy of the runner kept outside the checkout" was accepted/,
  },
  {
    item: 'R125: an edited runner is accepted',
    file,
    change: "the runner's hash is no longer compared with the committed copy's",
    test: check,
    apply: swap("env.SAOS_RECEIPT_RUNNER_SHA.toLowerCase() !== facts.runnerSha)", "false)"),
    expectRed: /self-test: "a runner whose bytes differ from the committed copy" was accepted/,
  },
  {
    item: 'R125: a helper edited and not committed',
    file: 'scripts/receipt/hold-awake.ps1',
    change: 'one line added to the display hold in the working tree only; the check must name the file',
    test: check,
    apply: (t) => t + '# an uncommitted edit\n',
    expectRed: /scripts\/receipt\/hold-awake\.ps1 differs from its committed copy/,
  },
];
