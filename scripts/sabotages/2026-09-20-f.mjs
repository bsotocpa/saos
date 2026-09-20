/*
 * THE 2026-09-20 BATCH F (ruling R29, the refund door): one sabotage, run through
 * scripts/sabotage-run.mjs so the reconciliation table is read from tasks/sabotage/2026-09-20.log
 * rather than composed.
 *
 *   R29  the webhook's dedupe on the Stripe refund id defeated. The refund the Ops door created is
 *        keyed by Stripe's refund id; when charge.refunded arrives for that same refund, the
 *        INSERT ... ON CONFLICT (stripe_refund_id) is what turns a second delivery into an update of
 *        the row that already exists. Make the id the webhook inserts differ from the one the door
 *        recorded — by hanging the event id off it — and the conflict never happens: a SECOND refund
 *        row appears for one refund, a SECOND receipt is queued for the client, and the money line
 *        counts the same dollars twice (once as the person's action, once as money that moved outside
 *        the door). This is the 2026-09-09 double-count defect reintroduced one level deeper, where
 *        only the reconciliation test can see it.
 */
export const date = '2026-09-20';
const api = (spec) => ({ kind: 'api', spec });
const must = (t, a) => { if (!t.includes(a)) throw new Error('anchor missing: ' + a.slice(0, 60)); };

export const items = [
  {
    item: 'R29 refund door: the webhook dedupe on the Stripe refund id disabled',
    file: 'apps/api/src/modules/billing/refunds.ts',
    change:
      "the refund id the webhook inserts is suffixed with the Stripe event id, so ON CONFLICT (stripe_refund_id) never fires: charge.refunded for a refund the Ops door already made writes a SECOND invoice_refunds row and queues a SECOND client receipt",
    test: api('test/refund-control.spec.ts'),
    apply: (t) => {
      const a = '[inv.id, r.id, r.amountCents, r.reason, input.stripeEventId, input.actor?.id ?? null, input.actor?.label ?? null]';
      must(t, a);
      return t.replace(
        a,
        "[inv.id, input.stripeEventId ? `${r.id}:${input.stripeEventId}` : r.id, r.amountCents, r.reason, input.stripeEventId, input.actor?.id ?? null, input.actor?.label ?? null]"
      );
    },
    expectRed: /one receipt|refund row|reconciled|money line/i,
  },
];
