import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { AppError } from '../../types.ts';
import { writeAudit } from '../../audit.ts';
import { payLinkFor } from './pay-link.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { todayChicago } from '../tax/deadlines.ts';
import { createInvoice, formatUsd, markInvoicePaid, runInvoiceOverdueJob } from './service.ts';
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
      { type: 'staff', id: request.staff!.id, label: request.staff!.fullName },
      b
    );
    return reply.code(201).send(result);
  });

  /*
   * SEND A CLIENT THEIR INVOICE AGAIN — the "reminder / take payment" of finding #33.
   *
   * Brian's ruling on what staff "taking payment" may mean: send the client their pay
   * link, never a staff-entered card, and settle through the same markInvoicePaid path
   * as #24 — one settlement path, no exceptions. So this endpoint sends an EMAIL and
   * touches no money. There is deliberately no staff-side checkout: the Stripe session is
   * created by /portal/invoices/:id/checkout under the CLIENT's own session, which is
   * what makes the payment theirs and keeps card data away from us entirely.
   *
   * NOT gated by isAutomationEnabled. That gate exists so no client receives an
   * AUTOMATED message before Brian arms it — ar_dunning suppresses the automatic chase
   * while still flipping invoices overdue. A person clicking this button about a named
   * client is the decision the gate is standing in for, and the same is already true of
   * sending an engagement packet. The audit row records who decided.
   */
  /**
   * ITEM 14 (2026-09-09, Brian's phone-walk ruling): ONE link per invoice — the tokenized pay
   * link — sent to the client by email or by text when a person presses the control on the
   * invoice card. The card no longer prints a portal URL "to be read out"; nobody reads a
   * 40-character token aloud. Audited as invoice.pay_link_sent with the channel, so it shows
   * on the invoice's send log. A human pressed Send, so this is a registered ungated send.
   */
  app.post<{ Params: { id: string } }>('/invoices/:id/pay-link/send', billing, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = z.object({ channel: z.enum(['email', 'sms']) }).parse(request.body);
    const actor = request.staff!;
    const { rows } = await app.db.query<{
      id: string; invoice_number: string; status: string; total_cents: number;
      contact_id: string; email: string | null; phone: string | null; first_name: string; language: 'en' | 'es';
    }>(
      `SELECT i.id, i.invoice_number, i.status::text AS status, i.total_cents,
              c.id AS contact_id, c.email, c.phone, c.first_name, c.language
         FROM invoices i JOIN contacts c ON c.id = i.contact_id
        WHERE i.id = $1`,
      [id]
    );
    const inv = rows[0];
    if (!inv) throw new AppError(404, 'not_found', 'Invoice not found.');
    if (inv.status !== 'sent' && inv.status !== 'overdue') {
      throw new AppError(409, 'not_payable', `${inv.invoice_number} is ${inv.status}; only an open invoice has a pay link to send.`);
    }
    const payLink = await payLinkFor(app, inv.id);
    if (b.channel === 'email') {
      if (!inv.email) throw new AppError(400, 'no_email', 'This client has no email address, so there is nowhere to send it.');
      await sendTemplatedEmail(app, {
        to: inv.email, templateKey: 'invoice_sent', language: inv.language, contactId: inv.contact_id,
        vars: { first_name: inv.first_name, invoice_number: inv.invoice_number, amount: formatUsd(inv.total_cents), portal_link: payLink },
      });
    } else {
      const { sendSms } = await import('../comms/send-sms.ts');
      const r = await sendSms(app, {
        contactId: inv.contact_id, templateKey: 'invoice_pay_link_sms', language: inv.language,
        vars: { first_name: inv.first_name, invoice_number: inv.invoice_number, amount: formatUsd(inv.total_cents), pay_link: payLink },
      });
      if (!r.sent) {
        const why: Record<string, string> = {
          no_sms_consent: 'This client has not opted in to texts (TCPA). Email the link instead.',
          no_phone: 'This client has no phone number on file.',
          twilio_not_configured: 'Texting is not configured on this box yet. Email the link instead.',
          template_missing: 'The pay-link text template is missing from Admin → Templates.',
          template_placeholder_blocked: 'The pay-link text template is still a PLACEHOLDER and cannot be sent.',
        };
        throw new AppError(409, `sms_${r.reason ?? 'failed'}`, why[r.reason ?? ''] ?? `The text could not be sent (${r.reason}).`);
      }
    }
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
      action: 'invoice.pay_link_sent', objectType: 'invoice', objectId: inv.id, contactId: inv.contact_id,
      details: { invoice_number: inv.invoice_number, channel: b.channel, to: b.channel === 'email' ? inv.email : 'phone on file' },
    });
    return { sent: true, channel: b.channel, to: b.channel === 'email' ? inv.email : 'the phone on file' };
  });

  app.post<{ Params: { id: string } }>('/invoices/:id/remind', billing, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const actor = request.staff!;
    const { rows } = await app.db.query<{
      id: string; invoice_number: string; status: string; total_cents: number;
      contact_id: string; email: string | null; first_name: string; language: 'en' | 'es';
    }>(
      `SELECT i.id, i.invoice_number, i.status, i.total_cents,
              c.id AS contact_id, c.email, c.first_name, c.language
         FROM invoices i JOIN contacts c ON c.id = i.contact_id
        WHERE i.id = $1`,
      [id]
    );
    const inv = rows[0];
    if (!inv) throw new AppError(404, 'not_found', 'Invoice not found.');
    if (inv.status === 'paid') {
      throw new AppError(409, 'already_paid', 'This invoice is paid — there is nothing to chase.');
    }
    if (!inv.email) {
      throw new AppError(400, 'no_email', 'This client has no email address, so there is nowhere to send it.');
    }

    await sendTemplatedEmail(app, {
      to: inv.email,
      templateKey: 'invoice_reminder',
      language: inv.language,
      contactId: inv.contact_id,
      vars: {
        first_name: inv.first_name,
        invoice_number: inv.invoice_number,
        amount: formatUsd(inv.total_cents),
        // The SAME deep link the dunning job and invoice_sent use. A reminder that names
        // an invoice and then points at the portal home makes the client hunt for it.
        portal_link: await (await import('./pay-link.ts')).payLinkFor(app, inv.id),
      },
    });

    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
      action: 'invoice.reminder_sent', objectType: 'invoice', objectId: inv.id,
      contactId: inv.contact_id, ip: request.ip,
      details: { invoice_number: inv.invoice_number, manual: true },
    });
    return { status: 'sent', to: inv.email };
  });

  /**
   * VOID (2026-09-09, Brian's ruling). Reason required; actor recorded; only a sent or
   * overdue invoice — and the DATABASE enforces that, not this handler (migration 0081).
   * A paid invoice is refunded, never voided. The number is retained.
   */
  app.post<{ Params: { id: string } }>('/invoices/:id/void', billing, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const body = z
      .object({ reason: z.string().trim().min(5, 'Say why in at least a few words — this is the record.').max(1000) })
      .parse(request.body);
    const { voidInvoice } = await import('./void.ts');
    return voidInvoice(app, id, body, request.staff!);
  });

  app.get('/invoices', billing, async (request) => {
    const q = z.object({ status: z.string().optional(), contactId: z.uuid().optional() }).parse(request.query);
    const clauses: string[] = ['true'];
    const params: unknown[] = [];
    if (q.status) { params.push(q.status); clauses.push(`i.status = $${params.length}::invoice_status`); }
    if (q.contactId) { params.push(q.contactId); clauses.push(`i.contact_id = $${params.length}`); }
    const { rows } = await app.db.query(
      // The card reads the SAME status column the portal reads, plus what a void or a refund
      // must say inline: reason, actor and date; amount and date (2026-09-09).
      `SELECT i.id, i.invoice_number, i.status, i.total_cents, i.amount_paid_cents, i.sent_at, i.paid_at,
              i.qb_exported_at, c.id AS contact_id, c.first_name, c.last_name,
              i.amount_refunded_cents, i.void_reason, i.voided_at, vs.full_name AS voided_by,
              (SELECT max(r.created_at) FROM invoice_refunds r WHERE r.invoice_id = i.id) AS refunded_at
       FROM invoices i JOIN contacts c ON c.id = i.contact_id
       LEFT JOIN staff vs ON vs.id = i.voided_by_staff_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY i.created_at DESC LIMIT 200`,
      params
    );
    // Every client-facing notice about each invoice, in its real state (2026-09-09).
    const { noticesForInvoices } = await import('./notices.ts');
    const notices = await noticesForInvoices(app, rows.map((r) => r.id as string));
    return { invoices: rows.map((r) => ({ ...r, notices: notices[r.id as string] ?? [] })) };
  });

  /**
   * Re-sync from Stripe (2026-09-09): pull the charge's refunds onto the invoice through the
   * webhook's own recording path. The deliberate correction the nightly drift task asks for.
   */
  app.post<{ Params: { id: string } }>('/invoices/:id/resync-stripe', billing, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const { resyncRefundsFromStripe } = await import('./drift.ts');
    return resyncRefundsFromStripe(app, id, { type: 'staff', id: request.staff!.id, label: request.staff!.fullName });
  });

  /** The send log for one invoice — what the "send log" control under an invoice opens. */
  app.get<{ Params: { id: string } }>('/invoices/:id/sends', billing, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const { sendLogForInvoice } = await import('./notices.ts');
    return { rows: await sendLogForInvoice(app, id) };
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
       -- Void invoices are listed (2026-09-09): the client was emailed that SA-2026-0002 was
       -- cancelled, and the portal agrees with the email — labelled Cancelled, sorted last,
       -- no pay action. Hiding it would leave the client with a message about a thing that
       -- is not there.
       WHERE i.contact_id = $1
       GROUP BY i.id
       ORDER BY (i.status = 'void') ASC, i.created_at DESC`,
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
      // E (2026-09-09): a cancelled, refunded or disputed invoice has no checkout.
      // Decision 5 (evening): neither does a DRAFT — nothing was issued. The filing and
      // acceptance paths issue (sent) in their own transaction, so a client never meets a draft.
      if (inv.status === 'draft') {
        throw new AppError(409, 'not_payable', 'This invoice has not been issued yet; there is nothing to pay.');
      }
      if (inv.status === 'void' || inv.status === 'refunded' || inv.status === 'partially_refunded' || inv.status === 'disputed') {
        throw new AppError(409, 'not_payable', `This invoice is ${inv.status === 'void' ? 'cancelled' : inv.status.replace('_', ' ')}; there is nothing to pay.`);
      }
      if (app.config.NODE_ENV === 'production' && stripe.mode === 'stub') {
        throw new AppError(503, 'stripe_not_configured', 'Payments are not configured (STRIPE_MODE=stub in production).');
      }

      const session = await stripe.createCheckoutSession({
        invoiceId: inv.id,
        invoiceNumber: inv.invoice_number,
        amountCents: inv.total_cents,
        description: `Soto Accounting — Invoice ${inv.invoice_number}`,
        customerEmail: client.email,
        // The return names THIS invoice, so the portal confirms the one that was just paid
        // instead of guessing across every open invoice (2026-09-09: the guess hit a stale
        // test-mode session, 404'd, and told a client whose invoice was already Paid that
        // there was no confirmation yet).
        successUrl: `${app.config.PORTAL_BASE_URL}/invoices?paid=1&invoice=${inv.id}`,
        cancelUrl: `${app.config.PORTAL_BASE_URL}/invoices`,
      });
      await app.db.query(`UPDATE invoices SET stripe_checkout_session_id = $2 WHERE id = $1`, [
        inv.id,
        session.sessionId,
      ]);
      return { url: session.url };
    }
  );

  // ── The pay link (2026-09-09): PUBLIC by design. The token is the credential, scoped to
  //    one invoice; the page learns the number and the amount and nothing else, and a dead
  //    token learns nothing at all. Stripe Checkout is the authentication.
  app.get<{ Params: { token: string } }>('/public/pay/:token', async (request) => {
    const token = z.string().min(20).max(200).parse(request.params.token);
    const { invoiceByPayToken } = await import('./pay-link.ts');
    return (await invoiceByPayToken(app, token)).view;
  });

  app.post<{ Params: { token: string } }>('/public/pay/:token/checkout', async (request) => {
    const token = z.string().min(20).max(200).parse(request.params.token);
    const { invoiceByPayToken } = await import('./pay-link.ts');
    const { view, invoice } = await invoiceByPayToken(app, token);
    if (view.state !== 'payable' || !invoice) {
      throw new AppError(409, 'not_payable', 'This invoice is no longer payable.');
    }
    if (app.config.NODE_ENV === 'production' && stripe.mode === 'stub') {
      throw new AppError(503, 'stripe_not_configured', 'Payments are not configured (STRIPE_MODE=stub in production).');
    }
    const session = await stripe.createCheckoutSession({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      amountCents: invoice.total_cents,
      description: `Soto Accounting — Invoice ${invoice.invoice_number}`,
      customerEmail: invoice.email ?? '',
      // Back to the SAME token page: it confirms this one invoice, no login involved.
      successUrl: `${app.config.PORTAL_BASE_URL}/pay/${token}?paid=1`,
      cancelUrl: `${app.config.PORTAL_BASE_URL}/pay/${token}`,
    });
    await app.db.query(`UPDATE invoices SET stripe_checkout_session_id = $2 WHERE id = $1`, [invoice.id, session.sessionId]);
    return { url: session.url };
  });

  app.post<{ Params: { token: string } }>('/public/pay/:token/reconcile', async (request) => {
    const token = z.string().min(20).max(200).parse(request.params.token);
    const { invoiceByPayToken } = await import('./pay-link.ts');
    const { view, invoice } = await invoiceByPayToken(app, token);
    if (view.state === 'unavailable') throw new AppError(404, 'not_found', 'Invoice not found.');
    if (view.state === 'paid') return { status: 'already_paid' };
    const { reconcileInvoice } = await import('./reconcile.ts');
    return reconcileInvoice(app, invoice!.id);
  });

  // ── Stripe webhook — needs the RAW body for signature verification, so it
  //    lives in an encapsulated scope with a buffer content-type parser.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    scope.post('/webhooks/stripe', async (request, reply) => {
      let event;
      try {
        event = stripe.parseWebhookEvent(request.headers, request.body as Buffer, app.config.WEBHOOK_SECRET);
      } catch (err) {
        /*
         * ITEM 10 (2026-09-09): a signature failure names its worlds. livemode is what the
         * payload CLAIMS (read, never trusted); configured_mode and endpoint_id are ours. The
         * audit row is the durable record; the warn line is for the box.
         */
        const details = (err as { webhook?: import('./stripe.ts').SignatureFailure }).webhook;
        if (details) {
          request.log.warn({ stripe_webhook: details }, 'stripe webhook signature failed');
          await writeAudit(app.db, {
            actorType: 'system', actorLabel: 'stripe webhook',
            action: 'webhook.signature_failed', objectType: 'webhook_endpoint', objectId: details.endpointId ?? 'unconfigured',
            details: {
              livemode: details.livemode, event_id: details.eventId, event_type: details.eventType,
              configured_mode: details.configuredMode, endpoint_id: details.endpointId, reason: details.reason,
            },
          });
        }
        throw err;
      }
      /*
       * 2026-09-09. Until tonight this handler knew one event. Brian refunded the first
       * real payment in the Stripe dashboard and the invoice stayed Paid — nothing here
       * could ever have noticed. Refunds and disputes now have handlers of their own
       * (billing/refunds.ts), each latched on the Stripe event id so redelivery is a
       * no-op. payment_completed keeps its path: markInvoicePaid is already idempotent.
       */
      if (event.type === 'payment_completed') {
        if (!event.invoiceId) return { status: 'ignored' };
        const result = await markInvoicePaid(app, event.invoiceId, {
          checkoutSessionId: event.checkoutSessionId,
          paymentIntentId: event.paymentIntentId,
        });
        return reply.send({
          status: 'ok',
          alreadyPaid: result.alreadyPaid,
          // A payment on a VOID invoice is acknowledged (200, so Stripe stops retrying) and
          // named, so the delivery log says what happened to the money.
          ...(result.refused ? { refused: result.refused } : {}),
        });
      }
      if (event.type === 'ignored') {
        return { status: 'ignored', type: event.stripeType ?? null };
      }
      const { handleStripeEvent } = await import('./refunds.ts');
      const outcome = await handleStripeEvent(app, event);
      // The outcome IS the status (refunded, disputed, duplicate, …) — no wrapper to bury it under.
      return reply.send(outcome);
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
