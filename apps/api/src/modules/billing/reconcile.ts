// FINDING #24 — ask Stripe, rather than waiting to be told.
//
// On 2026-08-13 Brian paid a deposit with a test card. Stripe recorded the session
// as complete and paid. SAOS never found out, because the webhook endpoint had vanished
// from Stripe and every event carried pending_webhooks=0. The invoice sat "Open" while
// the money had genuinely moved.
//
// A webhook is a notification, not a source of truth. The source of truth is the
// checkout session, and it can be asked at any time. So there are two backstops:
//
//   reconcileInvoice()      — the client comes back from Stripe with ?paid=1 and we ASK,
//                             immediately, instead of showing them an unpaid invoice
//                             and hoping a webhook lands.
//   runPaymentReconcileJob()— a sweep for sessions that were started and never settled,
//                             which catches the client who closed the tab.
//
// Both funnel into markInvoicePaid — the same function the webhook calls. Two settlement
// paths would eventually disagree about what "paid" means, and a receipt would send
// twice or not at all.

import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types.ts';
import { writeAudit } from '../../audit.ts';
import { markInvoicePaid } from './service.ts';

export interface ReconcileResult {
  status: 'paid' | 'not_paid_yet' | 'no_session' | 'already_paid';
  invoiceNumber: string;
  /** True when THIS call is what settled it — i.e. the webhook never arrived. */
  settledByReconcile: boolean;
}

/**
 * Ask Stripe whether this invoice's checkout session is paid, and settle it if so.
 *
 * Deliberately safe to call repeatedly and from the client's own browser: it reads a
 * session id that is already stored on the invoice, and it can only ever move an
 * invoice to paid when STRIPE says paid. A client cannot mark their own invoice paid by
 * calling it.
 */
export async function reconcileInvoice(
  app: FastifyInstance,
  invoiceId: string,
  opts: { contactId?: string | undefined } = {}
): Promise<ReconcileResult> {
  const { rows } = await app.db.query<{
    id: string; invoice_number: string; status: string; contact_id: string;
    stripe_checkout_session_id: string | null;
  }>(
    `SELECT id, invoice_number, status::text AS status, contact_id, stripe_checkout_session_id
       FROM invoices WHERE id = $1`,
    [invoiceId]
  );
  const inv = rows[0];
  // Scoped exactly like every other client-facing read: someone else's invoice does not
  // exist to you.
  if (!inv || (opts.contactId !== undefined && inv.contact_id !== opts.contactId)) {
    throw new AppError(404, 'not_found', 'Invoice not found.');
  }
  if (inv.status === 'paid') {
    return { status: 'already_paid', invoiceNumber: inv.invoice_number, settledByReconcile: false };
  }
  if (!inv.stripe_checkout_session_id) {
    return { status: 'no_session', invoiceNumber: inv.invoice_number, settledByReconcile: false };
  }

  const session = await app.stripe.retrieveCheckoutSession(inv.stripe_checkout_session_id);

  if (session.paymentStatus !== 'paid') {
    // Worth recording even when nothing happens: "the client came back but Stripe said
    // unpaid" is the trace you want when someone insists they paid.
    await writeAudit(app.db, {
      actorType: 'system',
      actorLabel: 'payment reconcile',
      action: 'invoice.reconcile_checked',
      objectType: 'invoice',
      objectId: inv.id,
      contactId: inv.contact_id,
      details: { payment_status: session.paymentStatus, session_status: session.status },
    });
    return { status: 'not_paid_yet', invoiceNumber: inv.invoice_number, settledByReconcile: false };
  }

  const result = await markInvoicePaid(app, inv.id, {
    checkoutSessionId: inv.stripe_checkout_session_id,
    ...(session.paymentIntentId ? { paymentIntentId: session.paymentIntentId } : {}),
  });

  if (!result.alreadyPaid) {
    // This is the interesting one: money had moved and the webhook had not told us.
    await writeAudit(app.db, {
      actorType: 'system',
      actorLabel: 'payment reconcile',
      action: 'invoice.settled_by_reconcile',
      objectType: 'invoice',
      objectId: inv.id,
      contactId: inv.contact_id,
      details: { session: inv.stripe_checkout_session_id, note: 'paid at Stripe but no webhook had settled it' },
    });
    app.log.warn(
      { invoice: inv.invoice_number, session: inv.stripe_checkout_session_id },
      'invoice settled by reconcile — the webhook did not arrive'
    );
  }

  return {
    status: 'paid',
    invoiceNumber: inv.invoice_number,
    settledByReconcile: !result.alreadyPaid,
  };
}

export interface ReconcileSweep {
  checked: number;
  settled: number;
  stillUnpaid: number;
  errors: number;
}

/**
 * Sweep invoices whose checkout was started but never settled.
 *
 * Catches the client who paid and closed the tab, so nobody has to notice. Bounded and
 * time-gated: only sessions older than the grace window, because a webhook usually
 * arrives within seconds and reconciling a payment that is already in flight is wasted
 * work, not a bug.
 */
export async function runPaymentReconcileJob(
  app: FastifyInstance,
  opts: { graceMinutes?: number; limit?: number } = {}
): Promise<ReconcileSweep> {
  const grace = opts.graceMinutes ?? 10;
  const limit = opts.limit ?? 50;
  const out: ReconcileSweep = { checked: 0, settled: 0, stillUnpaid: 0, errors: 0 };

  const { rows } = await app.db.query<{ id: string }>(
    `SELECT id FROM invoices
      WHERE stripe_checkout_session_id IS NOT NULL
        AND status <> 'paid'
        AND updated_at < now() - ($1 || ' minutes')::interval
      ORDER BY updated_at
      LIMIT $2`,
    [String(grace), limit]
  );

  for (const r of rows) {
    out.checked += 1;
    try {
      const res = await reconcileInvoice(app, r.id);
      if (res.settledByReconcile) out.settled += 1;
      else if (res.status !== 'paid' && res.status !== 'already_paid') out.stillUnpaid += 1;
    } catch (err) {
      // One unreachable session must not stop the sweep for everyone else.
      out.errors += 1;
      app.log.error({ err, invoiceId: r.id }, 'payment reconcile failed for one invoice');
    }
  }
  return out;
}
