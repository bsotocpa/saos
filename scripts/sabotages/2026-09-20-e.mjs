#!/usr/bin/env node
/*
 * THE 2026-09-20 BATCH E (ruling R16, item b): ONE sabotage, on the control that is the whole
 * ruling — the import-mode check inside `enqueueEffect`.
 *
 * WHY THIS ONE AND NOT THE ATTESTATION. R16 has two halves. The attestation half (item c) fails
 * LOUDLY if it breaks: setImportedStage writes one column, and a spec that reads the gate columns
 * back sees a stamp the moment one appears. The import-mode half fails SILENTLY — a broken check
 * enqueues a real, pending, performable row, and nothing in the import's own output says so. The
 * count in the rehearsal report would read zero at the moment it was taken and the drain would send
 * the email a minute later. That is the failure mode worth a manifest entry.
 *
 * THE SABOTAGE: the `importLabel !== null` branch made unreachable, so an enqueue under
 * runInImportContext writes its row exactly as if no import were running. Everything else stays —
 * the context still exists, isImportContext() still answers, the label is still required. Only the
 * refusal is gone, which is precisely the shape a careless refactor would leave behind.
 *
 * EXPECTED RED: the enqueue-under-the-context test, the four-frames-down test, and the every-effect
 * test all fail, because all three assert an outbox row count that did not move.
 *
 * Brian runs this: node scripts/sabotage-run.mjs scripts/sabotages/2026-09-20-e.mjs
 */
export const date = '2026-09-20';
const api = (spec) => ({ kind: 'api', spec });
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R16 import mode: the refusal in enqueueEffect made unreachable',
    file: 'apps/api/src/outbox.ts',
    change:
      'the import-context branch in enqueueEffect never taken, so a client-facing effect enqueued during an import is written as a real pending row and the drain will send it',
    test: api('test/import-mode.spec.ts'),
    apply: (t) => {
      const a = '  if (importLabel !== null) {';
      must(t, a);
      return t.replace(a, '  if (false && importLabel !== null) {');
    },
    expectRed: /import context|refused|effect/i,
  },
];
