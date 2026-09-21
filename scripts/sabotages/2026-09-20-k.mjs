/*
 * The 2026-09-20 batch, item K: the Ops Refund control's switch. Production ships it OFF until the
 * adapter's real refund call is proven in Stripe test mode; while off, POST /invoices/:id/refund
 * must refuse 409 with the one sentence the row shows. Take the refusal out of the route and a
 * closed door still creates a refund at Stripe — which is exactly the money movement the switch
 * exists to prevent until the call is proven. One sabotage, api kind, so no harness lock is held.
 *
 * Run through scripts/sabotage-run.mjs so the report table is read from tasks/sabotage/2026-09-20.log:
 *
 *   node scripts/sabotage-run.mjs scripts/sabotages/2026-09-20-k.mjs
 */
export const date = '2026-09-20';
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'the refund switch: the off-state refusal removed from POST /invoices/:id/refund',
    file: 'apps/api/src/modules/billing/routes.ts',
    change: 'the `if (app.switches.opsRefundControl !== \'on\') throw 409` block replaced by nothing; with OPS_REFUND_CONTROL=off the door still asks Stripe for a refund and records it',
    test: { kind: 'api', spec: 'test/refund-control.spec.ts' },
    apply: (t) => {
      const a = [
        "    if (app.switches.opsRefundControl !== 'on') {",
        "      throw new AppError(409, 'refund_control_off', REFUND_CONTROL_OFF);",
        '    }',
      ].join('\n');
      must(t, a);
      return t.replace(a, '    // (sabotage) the switch is not consulted');
    },
    expectRed: /the switch off/,
  },
];
