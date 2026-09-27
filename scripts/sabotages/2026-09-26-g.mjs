/*
 * The 2026-09-26 batch, item G: R63 (the guard half) and R48 (the portal's completed line), one guard
 * broken per ruling.
 *
 *   R63  no full identifier persists from an ATX export. Take the maskIdentifiers(...) call off the
 *        raw_text parameter of the efile_ack_reports INSERT (efile-ack.ts, the ingest) so the upload
 *        text is written whole; the root-chain check `npm run check:ack-identifiers` must go RED naming
 *        raw_text before any receipt run could pass.
 *   R48  the completed line reads per jurisdiction. Replace the per-jurisdiction lines on GET
 *        /portal/returns with an empty list — the portal would fall back to the old one-word
 *        "Accepted." — and the portal-returns-next API spec's completed-lines test is red.
 *
 * Run through scripts/sabotage-run.mjs so the report table is read from tasks/sabotage/2026-09-26.log:
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-26-g.mjs
 */
export const date = '2026-09-26';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 70)); };

export const items = [
  {
    item: 'R63 the mask removed: efile_ack_reports.raw_text written from the upload text whole',
    file: 'apps/api/src/modules/tax/efile-ack.ts',
    change: '`[input.filename, sha256, maskIdentifiers(input.text), actor.id, parsed.rows.length]` replaced by `[input.filename, sha256, input.text, actor.id, parsed.rows.length]`: the ATX export would be stored with every SSN and EIN whole, as on 2026-09-20',
    test: { kind: 'guard', spec: 'check:ack-identifiers' },
    apply: (t) => {
      const a = '    [input.filename, sha256, maskIdentifiers(input.text), actor.id, parsed.rows.length]\n';
      must(t, a);
      return t.replace(a, '    [input.filename, sha256, input.text, actor.id, parsed.rows.length]\n');
    },
    expectRed: /efile_ack_reports\.raw_text is written whole/,
  },
  {
    item: 'R48 the old completed line: the per-jurisdiction lines on GET /portal/returns replaced by none',
    file: 'apps/api/src/modules/portal/routes.ts',
    change: '`completed_lines: completedLinesFor(r),` replaced by `completed_lines: [],` — a completed return would read the one-word "Accepted." again instead of "Accepted by the IRS on <date>. Mailed to Illinois on <date>."',
    test: { kind: 'api', spec: 'test/portal-returns-next.spec.ts' },
    apply: (t) => {
      const a = '        completed_lines: completedLinesFor(r),\n';
      must(t, a);
      return t.replace(a, '        completed_lines: [],\n');
    },
    expectRed: /one line per jurisdiction/,
  },
];
