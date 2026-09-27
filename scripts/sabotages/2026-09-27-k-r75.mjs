/*
 * The 2026-09-27 batch 7, item K: R75, the Hilo referral discount reaches tax-return and entity-services
 * lines only.
 *
 *   R75  referralDiscountCents counts a line only when its price line is one the rule reaches. The check
 *        is made always true, so the recurring line is discounted too: the builder (which mirrors the
 *        rule) shows half the tax-return line, the server applies half of both, and V1 in
 *        ops-hilo-discount.spec.ts ("the server applied what the builder showed") is red at both viewports.
 *
 * Hold the harness lock: node scripts/sabotage-run.mjs scripts/sabotages/2026-09-27-k-r75.mjs
 */
export const date = '2026-09-27';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R75 the Hilo referral discount reaches tax-return and entity-services lines only: the line check in referralDiscountCents made always true',
    file: 'apps/api/src/modules/pricing/referral-discount.ts',
    change: '`l.serviceLine !== null && rule.serviceLines.includes(l.serviceLine)` replaced by `true`: recurring accounting is discounted too, the server applies more than the builder shows',
    test: { kind: 'harness', spec: 'tests/ops-hilo-discount.spec.ts' },
    apply: (t) => {
      const a = 'l.serviceLine !== null && rule.serviceLines.includes(l.serviceLine)';
      must(t, a);
      return t.replace(a, 'true');
    },
    expectRed: /V1–V4/,
  },
];
