import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { AppError } from '../../types.ts';
import { todayChicago } from '../tax/deadlines.ts';
import { createInvoice, markInvoicePaid, runInvoiceOverdueJob } from './service.ts';
import { runDunningJob } from './dunning.ts';

const CreateInvoiceBody = z.object({
  contactId: z.uuid(),
  engagementId: z.uuid().optional(),
  taxEngagementId: z.uuid().optional(),
  dueDate: z.iso.date().optional(),
  send: z.boolean().optional(),
  lines: z
    .array(
      z.object({
        code: z.string().optional(),
        description: z.string().optional(),
        qty: z.number().positive().optional(),
        unitCents: z.number().int().optional(),
      })
    )
    .min(1),
});

export function registerBillingRoutes(app: FastifyInstance): void {
  const stripe = app.stripe;
  const billing = { preHandler: [app.authenticate, requirePermission('billing.manage')] };

  // ── Staff (Rene's queue) ──────────────────────────────────────────────────
  app.post('/invoices', billing, async (request, reply) => {
    const b = CreateInvoiceBody.parse(request.body);
    const result = await createInvoice(
      app,
      { type: 'staff', id: request.staff!.id, label: request.staff!.email },
      b
    );
    return reply.code(201).send(result);
  });

  app.get('/invoices', billing, async (request) => {
    const q = z.object({ status: z.string().optional(), contactId: z.uuid().optional() }).parse(request.query);
    const clauses: string[] = ['true'];
    const params: unknown[] = [];
    if (q.status) { params.push(q.status); clauses.push(`i.status = $${params.length}::invoice_status`); }
    if (q.contactId) { params.push(q.contactId); clauses.push(`i.contact_id = $${params.length}`); }
    const { rows } = await app.db.query(
      `SELECT i.id, i.invoice_number, i.status, i.total_cents, i.amount_paid_cents, i.sent_at, i.paid_at,
              i.qb_exported_at, c.id AS contact_id, c.first_name, c.last_name
       FROM invoices i JOIN contacts c ON c.id = i.contact_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY i.created_at DESC LIMIT 200`,
      params
    );
    return { invoices: rows };
  });

  // ── Client portal (Invoices & Payments — Pay Now) ─────────────────────────
  app.get('/portal/invoices', { preHandler: [app.authenticateClient] }, async (request) => {
    const client = request.client!;
    const { rows } = await app.db.query(
      `SELECT i.id, i.invoice_number, i.status, i.total_cents, i.amount_paid_cents,
              i.sent_at, i.paid_at, i.due_date,
              COALESCE(json_agg(json_build_object(
                'description', li.description, 'qty', li.qty, 'totalCents', li.total_cents
              ) ORDER BY li.sort_order) FILTER (WHERE li.id IS NOT NULL), '[]') AS lines
       FROM invoices i
       LEFT JOIN invoice_line_items li ON li.invoice_id = i.id
       WHERE i.contact_id = $1 AND i.status <> 'void'
       GROUP BY i.id
       ORDER BY i.created_at DESC`,
      [client.contactId]
    );
    return { invoices: rows };
  });

  /**
   * FINDING #24 — the client comes back from Stripe and we ASK, instead of waiting.
   *
   * Called by the portal when Stripe returns the client with ?paid=1. It cannot mark
   * anything paid on its own say-so: it reads the session id already stored on the
   * invoice and settles only when STRIPE reports paid. Safe to call repeatedly.
   *
   * This exists because on 2026-08-13 a real payment succeeded and the invoice stayed
   * Open — the webhook endpoint had vanished from Stripe and nothing else ever asked.
   */
  app.post<{ Params: { id: string } }>(
    '/portal/invoices/:id/reconcile',
    { preHandler: [app.authenticateClient] },
    async (request) => {
      const client = request.client!;
      const id = z.uuid().parse(request.params.id);
      const { reconcileInvoice } = await import('./reconcile.ts');
      return reconcileInvoice(app, id, { contactId: client.contactId });
    }
  );

  /** Staff/cron sweep for checkouts that were started and never settled. */
  app.post('/jobs/payment-reconcile', { preHandler: [app.authenticate, requirePermission('jobs.run')] }, async (request) => {
    const q = z
      .object({ graceMinutes: z.coerce.number().int().min(0).max(1440).optional() })
      .parse(request.query ?? {});
    const { runPaymentReconcileJob } = await import('./reconcile.ts');
    return runPaymentReconcileJob(app, q.graceMinutes !== undefined ? { graceMinutes: q.graceMinutes } : {});
  });

  app.post<{ Params: { id: string } }>(
    '/portal/invoices/:id/checkout',
    { preHandler: [app.authenticateClient] },
    async (request) => {
      const client = request.client!;
      const id = z.uuid().parse(request.params.id);
      const { rows } = await app.db.query<{
        id: string; invoice_number: string; status: string; total_cents: number;
      }>(
        `SELECT id, invoice_number, status, total_cents FROM invoices
         WHERE id = $1 AND contact_id = $2`,
        [id, client.contactId] // row-level: the session contact, never a body id
      );
      const inv = rows[0];
      if (!inv) throw new AppError(404, 'not_found', 'Invoice not found.');
      if (inv.status === 'paid') throw new AppError(409, 'already_paid', 'This invoice is already paid.');
      if (app.config.NODE_ENV === 'production' && stripe.mode === 'stub') {
        throw new AppError(503, 'stripe_not_configured', 'Payments are not configured (STRIPE_MODE=stub in production).');
      }

      const session = await stripe.createCheckoutSession({
        invoiceId: inv.id,
        invoiceNumber: inv.invoice_number,
        amountCents: inv.total_cents,
        description: `Soto Accounting — Invoice ${inv.invoice_number}`,
        customerEmail: client.email,
        successUrl: `${app.config.PORTAL_BASE_URL}/invoices?paid=1`,
        cancelUrl: `${app.config.PORTAL_BASE_URL}/invoices`,
      });
      await app.db.query(`UPDATE invoices SET stripe_checkout_session_id = $2 WHERE id = $1`, [
        inv.id,
        session.sessionId,
      ]);
      return { url: session.url };
    }
  );

  // ── Stripe webhook — needs the RAW body for signature verification, so it
  //    lives in an encapsulated scope with a buffer content-type parser.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    scope.post('/webhooks/stripe', async (request, reply) => {
      const event = stripe.parseWebhookEvent(
        request.headers,
        request.body as Buffer,
        app.config.WEBHOOK_SECRET
      );
      if (event.type !== 'payment_completed' || !event.invoiceId) {
        return { status: 'ignored' };
      }
      const result = await markInvoicePaid(app, event.invoiceId, {
        checkoutSessionId: event.checkoutSessionId,
        paymentIntentId: event.paymentIntentId,
      });
      return reply.send({ status: 'ok', alreadyPaid: result.alreadyPaid });
    });
  });

  // v4.3 flow 4: the dunning ladder + late-fee assessment.
  app.post('/jobs/ar-dunning', { preHandler: [app.authenticate, requirePermission('jobs.run')] }, async (request) => {
    const q = z.object({ asOf: z.iso.date().optional() }).parse(request.query);
    return runDunningJob(app, q.asOf ?? todayChicago());
  });

  app.post('/jobs/invoice-overdue', { preHandler: [app.authenticate, requirePermission('jobs.run')] }, async (request) => {
    const q = z.object({ asOf: z.iso.date().optional() }).parse(request.query);
    return runInvoiceOverdueJob(app, q.asOf ?? todayChicago());
  });
}
