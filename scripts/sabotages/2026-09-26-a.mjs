/*
 * The 2026-09-26 batch, item A: R43, the acknowledgment parser rebuilt against the real ATX export.
 * One sabotage, on the ruling's headline: "the twelve UNKNOWN rows produce nothing". The 2026-09-20
 * parser raised one task per row it could not apply — five hundred of them on a firm-wide export.
 * Put that behaviour back (an unmatched row raises a task through createTask) and the fixture spec is
 * red: it expects zero tasks from the thirty-two rows that belong to nobody SAOS tracks, and reads
 * the two SYNTHETIC SCORP LLC rows completing their return with nothing else raised.
 *
 * Run through scripts/sabotage-run.mjs so the report table is read from tasks/sabotage/2026-09-26.log:
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-26-a.mjs
 */
export const date = '2026-09-26';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R43 unmatched rows produce nothing: the 2026-09-20 task-per-unmatched-row behaviour put back',
    file: 'apps/api/src/modules/tax/efile-ack.ts',
    change: 'the "if (disposition === unmatched) unmatched++" line replaced by a createTask for every unmatched row (the old parser\'s shape); the fixture spec expects zero tasks from the thirty-two firm-wide rows',
    test: { kind: 'api', spec: 'test/efile-ack-atx.spec.ts' },
    apply: (t) => {
      const a = "    if (disposition === 'unmatched') unmatched++;\n";
      must(t, a);
      return t.replace(a, [
        "    if (disposition === 'unmatched') {",
        "      const t = await createTask(app, { title: `E-file acknowledgment could not be applied: row ${row.rowIndex}`, description: `ATX export row ${row.rowIndex}: ${row.statusRaw}. Nothing was sent.`, priority: 1, source: 'automation', sourceType: 'efile_ack_review', sourceId: `${reportId}:${row.rowIndex}` });",
        "      taskId = t.id; disposition = 'task'; tasks++;",
        '    }',
        '',
      ].join('\n'));
    },
    expectRed: /the fixture: the two SYNTHETIC SCORP LLC rows/,
  },
];
