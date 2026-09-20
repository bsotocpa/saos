/*
 * THE 2026-09-19 EVENING BATCH C (BUILD 1 and BUILD 2): the new screen this track added a walk to
 * is the portal's Pay control, so that is what gets broken. Run through scripts/sabotage-run.mjs so
 * the report table is read from tasks/sabotage/2026-09-19.log rather than composed.
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-19-evening-c.mjs
 *
 * The sabotage is the exact defect Brian reported by hand once already (finding #22, "the button is
 * dead"): the request goes out, the session is minted, and nothing navigates. Everything else on the
 * page still works — the invoice list renders, the badges are right, the button is enabled and its
 * label changes — which is why only a spec that follows the navigation can catch it. Red at both
 * viewports; A10's tap in the dry run rides on the same control.
 */
export const date = '2026-09-19';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'BUILD 2 the Pay control: the checkout navigation swallowed',
    file: 'apps/portal/app/invoices/page.tsx',
    change: 'the assignment to window.location.href dropped, so Pay now mints a Checkout session and goes nowhere',
    test: { kind: 'harness', spec: 'tests/portal-checkout.spec.ts' },
    apply: (t) => {
      const a = '      window.location.href = res.url;';
      must(t, a);
      return t.replace(a, '      void res.url;');
    },
    expectRed: /two checkouts, one payment/,
  },
];
