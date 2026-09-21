/*
 * The 2026-09-20 batch, item I: edit after create and the Quotes card. One sabotage per ruling.
 *
 *   R38  the edit-door guard. Every entity Ops creates must be editable from Ops or carry an
 *        "immutable because …" entry in scripts/edit-doors.json. Take the quote's entry off (Ops
 *        creates quotes on /pipeline and has no update door for them) and check:edit-doors must
 *        print a RED line naming the quote and exit non-zero.
 *   R39  the Quotes card on the harness. Take the "Resend proposal email" control off the card and
 *        Q3 cannot be tapped at either viewport: the spec is red on the phone and on the desk.
 *
 * Run through scripts/sabotage-run.mjs so the report table is read from tasks/sabotage/2026-09-20.log,
 * holding the harness lock for the harness item:
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-20-i.mjs
 */
export const date = '2026-09-20';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R38 edit-door guard: the quote\'s "immutable because" entry removed from the registry',
    file: 'scripts/edit-doors.json',
    change: 'the quote entity keeps its create route and its create control (/pipeline) and loses its immutable reason; it now claims nothing about how a quote is edited, and Ops has no update door for it',
    test: { kind: 'guard', spec: 'check:edit-doors' },
    apply: (t) => {
      const a = '"createUi": "apps/internal/app/pipeline/page.tsx", "immutable": "edited by superseding:';
      must(t, a);
      const start = t.indexOf(a) + '"createUi": "apps/internal/app/pipeline/page.tsx"'.length;
      const end = t.indexOf('" }', start);
      if (end < 0) throw new Error('anchor missing: the end of the quote entry');
      return t.slice(0, start) + t.slice(end + 1);
    },
    expectRed: /^quote: Ops creates one/,
  },
  {
    item: 'R39 the Quotes card: the "Resend proposal email" control removed from the client page',
    file: 'apps/internal/app/clients/[id]/page.tsx',
    change: 'the Resend button on a sent quote\'s row replaced by nothing; Q3 has no control to tap at either viewport',
    test: { kind: 'harness', spec: 'tests/ops-quotes-card.spec.ts' },
    apply: (t) => {
      const open = [
        '                        <button',
        '                          type="button"',
        '                          className="btn ghost small"',
        '                          disabled={busy}',
        '                          onClick={async () => {',
        '                            const a = await ask({',
        "                              title: 'Resend the proposal email?',",
      ].join('\n');
      must(t, open);
      const start = t.indexOf(open);
      const close = '                          Resend proposal email\n                        </button>\n';
      const end = t.indexOf(close, start);
      if (end < 0) throw new Error('anchor missing: the Resend button close');
      return t.slice(0, start) + '                        {null}\n' + t.slice(end + close.length);
    },
    expectRed: /Quotes card/,
  },
];
