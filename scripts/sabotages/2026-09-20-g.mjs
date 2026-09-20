/*
 * The 2026-09-20 batch, item G: the two rulings that put the RECORD on the screen and the missing
 * Ops step in the manifest. Two sabotages, both on the harness, both in the client page — because
 * both rulings are about something the client page must print or offer:
 *
 *   R25  a recorded paper mailing prints on the completed return's row, per declared jurisdiction,
 *        with its method and its tracking number. Take the line off the row and Path B is red:
 *        nothing else in Ops carries a paper lane's mailing once the return completes.
 *   R27  the Ops packet step, which Path A had never annotated. Take the "Create engagement packet"
 *        button off the page and Path A cannot start the packet at all, at either viewport.
 *
 * Run through scripts/sabotage-run.mjs so the report table is read from tasks/sabotage/2026-09-20.log:
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-20-g.mjs
 */
export const date = '2026-09-20';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R25 the mailing on the record: the per-jurisdiction line removed from the client page return row',
    file: 'apps/internal/app/clients/[id]/page.tsx',
    change: 'the jurisdiction-line block on the return row replaced by nothing; a completed paper filing\'s mailing, method and tracking number are readable nowhere in Ops',
    test: { kind: 'harness', spec: 'tests/ops-path-b.spec.ts' },
    apply: (t) => {
      const a = [
        '              {(jurisdictions[t.id] ?? []).length > 0 ? (',
        "                <ul className=\"list\" style={{ flex: '1 1 100%' }}>",
        '                  {(jurisdictions[t.id] ?? []).map((j) => (',
        '                    <li key={j.jurisdiction} data-testid={`jurisdiction-line-${j.jurisdiction}`}>',
        '                      <span className="badge">{jurisdictionLabel(j.jurisdiction)}</span>{\' \'}',
        '                      <span className="grow muted small">{jurisdictionLine(j)}</span>',
        '                    </li>',
        '                  ))}',
        '                </ul>',
        '              ) : null}',
      ].join('\n');
      must(t, a);
      return t.replace(a, '              {null}');
    },
    expectRed: /the 1040 on extension/,
  },
  {
    item: 'R27 the Ops packet step: the "Create engagement packet" button removed from the client page',
    file: 'apps/internal/app/clients/[id]/page.tsx',
    change: 'the Create engagement packet button replaced by nothing; A3b cannot be tapped and the S corp client has no packet to sign',
    test: { kind: 'harness', spec: 'tests/ops-scorp-dry-run.spec.ts' },
    apply: (t) => {
      const open = [
        '              <button',
        '                className="btn accent"',
        '                type="button"',
        '                disabled={busy || preview.codes.length === 0}',
      ].join('\n');
      must(t, open);
      const start = t.indexOf(open);
      const close = '              </button>\n';
      const end = t.indexOf(close, start);
      if (end < 0) throw new Error('anchor missing: the button close');
      return t.slice(0, start) + '              {null}\n' + t.slice(end + close.length);
    },
    expectRed: /signed 8879-CORP/,
  },
];
