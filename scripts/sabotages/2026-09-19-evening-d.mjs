/*
 * The 2026-09-19 EVENING batch, item D (BUILD 4): Path B, the 1040 on extension with a walk-in wet
 * signature. One sabotage, on the harness: a Path B control removed from the portal, which must
 * turn apps/e2e/tests/ops-path-b.spec.ts red at BOTH viewports. Run through
 * scripts/sabotage-run.mjs so the report table is read from tasks/sabotage/2026-09-19.log:
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-19-evening-d.mjs
 *
 * The control chosen is the §7216 consent's own answer button (B5). It is Path B's alone — no
 * other spec walks /consent — so a red here is this walk failing and nothing else, and it is the
 * one screen whose content must pertain solely to the consent, which is why losing its answer
 * control has to be a build failure rather than a cosmetic one.
 */
export const date = '2026-09-19';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'BUILD 4 Path B taps: the §7216 consent answer control removed from the portal',
    file: 'apps/portal/app/consent/page.tsx',
    change: 'the "Yes, you have my permission" button replaced by nothing; the client cannot answer the consent and B5 cannot be tapped',
    test: { kind: 'harness', spec: 'tests/ops-path-b.spec.ts' },
    apply: (t) => {
      const a = [
        '          <button',
        '            className="btn accent"',
        '            type="button"',
        '            disabled={busy}',
        "            style={{ flex: '1 1 200px' }}",
        '            onClick={() => void answer(true)}',
        '          >',
        "            {t('consent_yes')}",
        '          </button>',
      ].join('\n');
      must(t, a);
      return t.replace(a, '          {null}');
    },
    expectRed: /the 1040 on extension/,
  },
];
