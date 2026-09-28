/*
 * The 2026-09-28 batch 9, step 4: R80, R81 and R84, one sabotage each, on the harness.
 *
 *   R80  every client-search chip carries its type. The type dropped from the chip: H1 (Deliver
 *        Return) in ops-business-search.spec.ts is red.
 *   R81  the builders' catalog reads the display name (with the form number). Back to the book's own
 *        name: "1040" no longer finds "Form 1040 — …", and path B's B2b is red.
 *   R84  a filed return reads its answers on Home, never a deadline. isFiled answers false: the
 *        completed 1120S reads "Completed · Deadline …" again, and A5b in portal-returns.spec.ts is red.
 *
 * Hold the harness lock: node scripts/sabotage-run.mjs scripts/sabotages/2026-09-28-c-step4.mjs
 */
export const date = '2026-09-28';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R80 every client-search chip shows a type: the type dropped from the chip',
    file: 'apps/internal/components/client-chip.tsx',
    change: 'the `<span className="chip-type" …>` removed from ClientChipBody: the chip reads the name alone again',
    test: { kind: 'harness', spec: 'tests/ops-business-search.spec.ts' },
    apply: (t) => {
      const a = '<span className="chip-type" data-type={type}>{CLIENT_CHIP_TYPE_LABEL[type]}</span>';
      must(t, a);
      return t.replace(a, '{null}');
    },
    expectRed: /H1/,
  },
  {
    item: 'R81 the builders\' catalog reads the display name with the form number: back to the book\'s name',
    file: 'apps/api/src/modules/pricing/quote-routes.ts',
    change: '`COALESCE(display_name_en, name_en) AS name_en` replaced by `name_en`: "1040" finds no "Form 1040 — …" row',
    test: { kind: 'harness', spec: 'tests/ops-path-b.spec.ts' },
    apply: (t) => {
      const a = 'COALESCE(display_name_en, name_en) AS name_en, COALESCE(display_name_es, name_es) AS name_es, amount_cents,';
      must(t, a);
      return t.replace(a, 'name_en, name_es, amount_cents,');
    },
    expectRed: /1040 on extension/,
  },
  {
    item: 'R84 a filed return reads its answers on Home, never a deadline: isFiled answers false',
    file: 'apps/portal/lib/return-status.ts',
    change: "`return stage === 'filed' || stage === 'completed';` replaced by `return false;`: the completed return reads its stage and deadline again",
    // The dry run first: portal-returns reads the 1120S it completes.
    test: { kind: 'harness', spec: 'tests/ops-scorp-dry-run.spec.ts tests/portal-returns.spec.ts' },
    apply: (t) => {
      const a = "return stage === 'filed' || stage === 'completed';";
      must(t, a);
      return t.replace(a, 'return false && Boolean(stage);');
    },
    expectRed: /delivered 1120S/,
  },
];
