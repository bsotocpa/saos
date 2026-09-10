/*
 * REFUNDS AND DISPUTES (2026-09-09).
 *
 * Brian refunded the first real card payment in the Stripe dashboard. SAOS kept the invoice
 * at Paid, and would have forever: it was subscribed to "paid" and "failed" and a refund was
 * neither. A status that cannot be contradicted by the world is not a status; it is a lie
 * with a timestamp.
 *
 * Three events, one shape each:
 *   charge.refunded         → refund rows (one per Stripe refund id), amounts reversed,
 *                             status refunded / partially_refunded, receipt to the client
 *                             through the outbox.
 *   charge.dispute.created  → status disputed, a task for the billing owner with the card
 *                             network's evidence deadline as its due date. No client send —
 *                             the client is the one disputing.
 *   charge.dispute.closed   → won: the charge stands; lost: funds are gone, treated exactly
 *                             as a refund.
 *
 * THE LATCH. Every event is claimed by its Stripe event id with one INSERT ... ON CONFLICT
 * DO NOTHING inside the same transaction as the work (#48: the claim is the statement, not
 * a read followed by a decision). Redelivery finds the row and performs nothing; a rolled-
 * back attempt leaves no row, so Stripe's retry gets a clean run.
 *
 * There is no general ledger in SAOS. "Reversal" here means the facts the system actually
 * holds money in: invoices.amount_refunded_cents (gross, cumulative, as Stripe reports it),
 * the engagement's payment_status, and deposit credit — which reads paid minus refunded, so
 * a refunded deposit can never be applied to the invoice that follows it.
 */

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { enqueueEffect } from '../../outbox.ts';
import { withTransaction } from '../../db.ts';
import { AppError } from '../../types.ts';
import { ownerForRole } from '../../staffing.ts';
import { closeTasksForSource, createTask } from '../tasks/service.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { isAutomationEnabled } from '../../automations.ts';
import { formatUsd } from './service.ts';
import type { DisputeClosedEvent, DisputeOpenedEvent, PaymentEvent, RefundEvent } from './stripe.ts';

export interface StripeOutcome {
  status:
    | 'duplicate'
    | 'ignored'
    | 'unmatched'
    | 'refunded'
    | 'partially_refunded'
    | 'disputed'
    | 'dispute_won'
    | 'dispute_lost';
  invoiceId?: string;
  invoiceNumber?: string;
  /** Refund rows written by THIS delivery (0 on a replay). */
  recorded?: number;
  taskId?: string;
}

interface InvoiceRow {
  id: string;
  invoice_number: string;
  status: string;
  total_cents: number;
  amount_paid_cents: number;
  amount_refunded_cents: number;
  contact_id: string;
  engagement_id: string | null;
  tax_engagement_id: string | null;
}

/**
 * Claim this event id. True = ours to perform; false = already performed (or in flight).
 * An event without an id cannot be latched and is performed as-is — the stub fixtures
 * always carry one, and Stripe always does.
 */
async function claimEvent(
  app: FastifyInstance,
  eventId: string,
  type: string,
  invoiceId: string | null
): Promise<boolean> {
  if (!eventId) return true;
  const { rows } = await app.db.query<{ event_id: string }>(
    `INSERT INTO stripe_events (event_id, type, invoice_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [eventId, type, invoiceId]
  );
  return rows.length === 1;
}

async function recordOutcome(app: FastifyInstance, eventId: string, outcome: StripeOutcome): Promise<void> {
  if (!eventId) return;
  await app.db.query(`UPDATE stripe_events SET outcome = $2::jsonb WHERE event_id = $1`, [
    eventId,
    JSON.stringify(outcome),
  ]);
}

/** The invoice a Stripe charge belongs to: matched on the payment intent settlement stored. */
async function invoiceForPaymentIntent(app: FastifyInstance, paymentIntentId: string | undefined): Promise<InvoiceRow | null> {
  if (!paymentIntentId) return null;
  const { rows } = await app.db.query<InvoiceRow>(
    `SELECT id, invoice_number, status::text AS status, total_cents, amount_paid_cents, amount_refunded_cents,
            contact_id, engagement_id, tax_engagement_id
       FROM invoices WHERE stripe_payment_intent_id = $1`,
    [paymentIntentId]
  );
  return rows[0] ?? null;
}

/**
 * Money moved for a payment SAOS has no invoice for. Not an error to swallow and not a
 * crash: a task for the billing owner naming the Stripe ids, and an audit line.
 */
async function raiseUnmatched(
  app: FastifyInstance,
  e: { eventId: string; type: string; chargeId: string; paymentIntentId?: string | undefined; amountCents: number }
): Promise<StripeOutcome> {
  const owner = await ownerForRole(app.db, 'comms_billing');
  const ids = `charge ${e.chargeId}${e.paymentIntentId ? `, payment intent ${e.paymentIntentId}` : ''}`;
  await createTask(app, {
    title: `Stripe ${e.type} for ${formatUsd(e.amountCents)} matches no invoice`,
    description:
      `Stripe reported a ${e.type} (event ${e.eventId}) on ${ids}, and no SAOS invoice carries that payment ` +
      'intent. Find the payment in Stripe → Payments, work out which client and invoice it belongs to, and ' +
      'record it by hand. Until then the books and Stripe disagree by this amount.',
    ...(owner ? { assignedStaffId: owner } : {}),
    priority: 1,
    source: 'automation',
    sourceType: 'stripe_unmatched',
    sourceId: e.eventId || e.chargeId,
  });
  await writeAudit(app.db, {
    actorType: 'system',
    actorLabel: 'stripe webhook',
    action: 'stripe.event_unmatched',
    objectType: 'stripe_event',
    objectId: e.eventId || e.chargeId,
    details: { type: e.type, charge: e.chargeId, payment_intent: e.paymentIntentId ?? null, amount_cents: e.amountCents },
  });
  return { status: 'unmatched' };
}

/**
 * A payment landed on a VOID invoice (2026-09-09). Void is terminal, so the invoice does not
 * flip; the money is real and a person must decide — refund it, or apply it by hand.
 */
export async function paymentOnVoidInvoice(
  app: FastifyInstance,
  p: { id: string; invoiceNumber: string; contactId: string; amountCents: number; checkoutSessionId?: string | undefined; paymentIntentId?: string | undefined }
): Promise<void> {
  const owner = await ownerForRole(app.db, 'comms_billing');
  await createTask(app, {
    title: `Payment of ${formatUsd(p.amountCents)} arrived on VOID invoice ${p.invoiceNumber}`,
    description:
      `Stripe reports a completed payment (${p.paymentIntentId ?? p.checkoutSessionId ?? 'no id'}) on ${p.invoiceNumber}, ` +
      'which was voided before it was paid. The invoice stays void. Decide: refund the client in Stripe, or apply the ' +
      'money to the replacement invoice by hand. Either way, tell them.',
    ...(owner ? { assignedStaffId: owner } : {}),
    contactId: p.contactId,
    priority: 1,
    source: 'automation',
    sourceType: 'stripe_unmatched',
    sourceId: p.paymentIntentId ?? p.checkoutSessionId ?? p.id,
  });
  await writeAudit(app.db, {
    actorType: 'system',
    actorLabel: 'stripe webhook',
    action: 'invoice.payment_on_void',
    objectType: 'invoice',
    objectId: p.id,
    contactId: p.contactId,
    details: { invoice_number: p.invoiceNumber, amount_cents: p.amountCents, payment_intent: p.paymentIntentId ?? null, session: p.checkoutSessionId ?? null },
  });
}

/** Reverse the engagement's payment mark to match what is actually still paid. */
async function reverseEngagementPayment(app: FastifyInstance, inv: InvoiceRow, full: boolean): Promise<void> {
  if (!inv.tax_engagement_id) return;
  await app.db.query(
    `UPDATE tax_engagements
        SET payment_status = $2::payment_status,
            payment_received_at = CASE WHEN $3 THEN NULL ELSE payment_received_at END
      WHERE id = $1`,
    [inv.tax_engagement_id, full ? 'invoiced' : 'partial', full]
  );
}

/** Apply a cumulative refunded amount to the invoice and return the status it now has. */
async function applyRefundedAmount(
  app: FastifyInstance,
  inv: InvoiceRow,
  amountRefundedCents: number
): Promise<'refunded' | 'partially_refunded'> {
  const capped = Math.min(amountRefundedCents, inv.amount_paid_cents);
  const full = capped >= inv.amount_paid_cents;
  const status = full ? 'refunded' : 'partially_refunded';
  await app.db.query(
    `UPDATE invoices SET amount_refunded_cents = $2, status = $3::invoice_status WHERE id = $1`,
    [inv.id, capped, status]
  );
  await reverseEngagementPayment(app, inv, full);
  return status;
}

async function invoiceById(app: FastifyInstance, id: string): Promise<InvoiceRow | null> {
  const { rows } = await app.db.query<InvoiceRow>(
    `SELECT id, invoice_number, status::text AS status, total_cents, amount_paid_cents, amount_refunded_cents,
            contact_id, engagement_id, tax_engagement_id
       FROM invoices WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * Record Stripe refunds on an invoice: one row per refund id (idempotent), the gross
 * cumulative amount, the status, the engagement reversal, and a receipt for each refund the
 * client has not been told about. THE one path — the webhook and re-sync both come here.
 */
export async function recordRefunds(
  app: FastifyInstance,
  input: {
    invoice: { id: string };
    refunds: Array<{ id: string; amountCents: number; reason: string | null }>;
    amountRefundedCents: number;
    stripeEventId: string | null;
  }
): Promise<{ status: 'refunded' | 'partially_refunded'; amountRefundedCents: number; recorded: number }> {
  const inv = await invoiceById(app, input.invoice.id);
  if (!inv) throw new AppError(404, 'not_found', 'Invoice not found.');
  let recorded = 0;
  for (const r of input.refunds) {
    const ins = await app.db.query<{ id: string }>(
      `INSERT INTO invoice_refunds (invoice_id, stripe_refund_id, amount_cents, reason, stripe_event_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (stripe_refund_id) DO NOTHING
       RETURNING id`,
      [inv.id, r.id, r.amountCents, r.reason, input.stripeEventId]
    );
    if (ins.rows[0]) {
      recorded += 1;
      // The receipt rides the outbox, keyed by the refund ROW: one refund is told about once.
      await enqueueEffect(app, {
        effect: 'invoice.refund_receipt',
        payload: { invoiceId: inv.id, refundId: r.id },
        contactId: inv.contact_id,
        objectType: 'invoice_refund',
        objectId: ins.rows[0].id,
      });
    }
  }
  // Stripe's cumulative figure is the truth; the rows are the itemisation of it.
  const status = await applyRefundedAmount(app, inv, input.amountRefundedCents);
  return { status, amountRefundedCents: Math.min(input.amountRefundedCents, inv.amount_paid_cents), recorded };
}

export async function applyRefund(app: FastifyInstance, e: RefundEvent): Promise<StripeOutcome> {
  return withTransaction(app.db, async () => {
    const inv = await invoiceForPaymentIntent(app, e.paymentIntentId);
    if (!(await claimEvent(app, e.eventId, 'charge.refunded', inv?.id ?? null))) return { status: 'duplicate' };
    if (!inv) {
      const out = await raiseUnmatched(app, { ...e, type: 'charge.refunded', amountCents: e.amountRefundedCents });
      await recordOutcome(app, e.eventId, out);
      return out;
    }

    const refunds = e.refunds.length > 0 ? e.refunds : await app.stripe.listRefunds(e.chargeId);
    // THE one recording path (shared with re-sync): rows by refund id, gross amount, status,
    // engagement reversal, and a receipt per newly recorded refund.
    const { status, recorded } = await recordRefunds(app, {
      invoice: { id: inv.id }, refunds, amountRefundedCents: e.amountRefundedCents, stripeEventId: e.eventId || null,
    });

    await writeAudit(app.db, {
      actorType: 'system',
      actorLabel: 'stripe webhook',
      action: 'invoice.refunded',
      objectType: 'invoice',
      objectId: inv.id,
      contactId: inv.contact_id,
      details: {
        invoice_number: inv.invoice_number,
        stripe_event_id: e.eventId,
        refund_ids: refunds.map((r) => r.id),
        amount_refunded_cents: Math.min(e.amountRefundedCents, inv.amount_paid_cents),
        status,
      },
    });


    const out: StripeOutcome = { status, invoiceId: inv.id, invoiceNumber: inv.invoice_number, recorded };
    await recordOutcome(app, e.eventId, out);
    return out;
  });
}

export async function openDispute(app: FastifyInstance, e: DisputeOpenedEvent): Promise<StripeOutcome> {
  return withTransaction(app.db, async () => {
    const inv = await invoiceForPaymentIntent(app, e.paymentIntentId);
    if (!(await claimEvent(app, e.eventId, 'charge.dispute.created', inv?.id ?? null))) return { status: 'duplicate' };
    if (!inv) {
      const out = await raiseUnmatched(app, { ...e, type: 'charge.dispute.created' });
      await recordOutcome(app, e.eventId, out);
      return out;
    }

    await app.db.query(
      `INSERT INTO invoice_disputes (invoice_id, stripe_dispute_id, amount_cents, reason, status, evidence_due_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (stripe_dispute_id) DO UPDATE
         SET status = EXCLUDED.status, evidence_due_by = EXCLUDED.evidence_due_by`,
      [inv.id, e.disputeId, e.amountCents, e.reason, e.status, e.evidenceDueBy]
    );
    await app.db.query(
      `UPDATE invoices SET status = 'disputed' WHERE id = $1 AND status IN ('paid', 'partially_refunded')`,
      [inv.id]
    );

    // The one task door. Due date is the card network's deadline, not ours to choose.
    const owner = await ownerForRole(app.db, 'comms_billing');
    const dueDate = e.evidenceDueBy ? e.evidenceDueBy.slice(0, 10) : undefined;
    const task = await createTask(app, {
      title: `Card dispute on ${inv.invoice_number} — ${formatUsd(e.amountCents)} — evidence due ${dueDate ?? 'date unknown'}`,
      description:
        `Stripe dispute ${e.disputeId}${e.reason ? ` (reason: ${e.reason})` : ''} on invoice ${inv.invoice_number}. ` +
        'Assemble the evidence in Stripe → Payments → Disputes and submit it before the deadline; the card network ' +
        'decides. SAOS sends the client nothing about this — they are the one disputing.',
      ...(owner ? { assignedStaffId: owner } : {}),
      contactId: inv.contact_id,
      ...(inv.engagement_id ? { engagementId: inv.engagement_id } : {}),
      ...(dueDate ? { dueDate } : {}),
      priority: 1,
      source: 'automation',
      sourceType: 'stripe_dispute',
      sourceId: e.disputeId,
    });
    await app.db.query(`UPDATE invoice_disputes SET task_id = $2 WHERE stripe_dispute_id = $1`, [e.disputeId, task.id]);

    await writeAudit(app.db, {
      actorType: 'system',
      actorLabel: 'stripe webhook',
      action: 'invoice.disputed',
      objectType: 'invoice',
      objectId: inv.id,
      contactId: inv.contact_id,
      details: {
        invoice_number: inv.invoice_number,
        stripe_event_id: e.eventId,
        dispute_id: e.disputeId,
        amount_cents: e.amountCents,
        reason: e.reason,
        evidence_due_by: e.evidenceDueBy,
        task_id: task.id,
      },
    });

    const out: StripeOutcome = { status: 'disputed', invoiceId: inv.id, invoiceNumber: inv.invoice_number, taskId: task.id };
    await recordOutcome(app, e.eventId, out);
    return out;
  });
}

export async function closeDispute(app: FastifyInstance, e: DisputeClosedEvent): Promise<StripeOutcome> {
  return withTransaction(app.db, async () => {
    // Prefer the dispute row we opened; fall back to the payment intent for a dispute that
    // was opened before SAOS listened for them.
    const known = await app.db.query<{ invoice_id: string }>(
      `SELECT invoice_id FROM invoice_disputes WHERE stripe_dispute_id = $1`,
      [e.disputeId]
    );
    const inv = known.rows[0]
      ? (await app.db.query<InvoiceRow>(
          `SELECT id, invoice_number, status::text AS status, total_cents, amount_paid_cents, amount_refunded_cents,
                  contact_id, engagement_id, tax_engagement_id FROM invoices WHERE id = $1`,
          [known.rows[0].invoice_id]
        )).rows[0] ?? null
      : await invoiceForPaymentIntent(app, e.paymentIntentId);
    if (!(await claimEvent(app, e.eventId, 'charge.dispute.closed', inv?.id ?? null))) return { status: 'duplicate' };
    if (!inv) {
      const out = await raiseUnmatched(app, { ...e, type: 'charge.dispute.closed' });
      await recordOutcome(app, e.eventId, out);
      return out;
    }

    const lost = e.status === 'lost';
    await app.db.query(
      `INSERT INTO invoice_disputes (invoice_id, stripe_dispute_id, amount_cents, reason, status, closed_at, outcome)
       VALUES ($1, $2, $3, NULL, $4, now(), $4)
       ON CONFLICT (stripe_dispute_id) DO UPDATE
         SET status = EXCLUDED.status, closed_at = now(), outcome = EXCLUDED.outcome`,
      [inv.id, e.disputeId, e.amountCents, e.status]
    );

    let status: StripeOutcome['status'];
    if (lost) {
      // The funds are gone exactly as if refunded. One row, keyed by the dispute so a
      // replay cannot take the money twice.
      await app.db.query(
        `INSERT INTO invoice_refunds (invoice_id, stripe_refund_id, amount_cents, reason, stripe_event_id)
         VALUES ($1, $2, $3, 'dispute_lost', $4)
         ON CONFLICT (stripe_refund_id) DO NOTHING`,
        [inv.id, `dispute:${e.disputeId}`, e.amountCents, e.eventId || null]
      );
      await applyRefundedAmount(app, inv, inv.amount_refunded_cents + e.amountCents);
      status = 'dispute_lost';
    } else {
      // Won (or closed without loss): the charge stands. Back to whatever the refunds say.
      await app.db.query(
        `UPDATE invoices
            SET status = CASE
                  WHEN amount_refunded_cents >= amount_paid_cents THEN 'refunded'::invoice_status
                  WHEN amount_refunded_cents > 0 THEN 'partially_refunded'::invoice_status
                  ELSE 'paid'::invoice_status END
          WHERE id = $1 AND status = 'disputed'`,
        [inv.id]
      );
      status = 'dispute_won';
    }

    // The dispute task is done because the dispute is — whichever way it went.
    await closeTasksForSource(app, 'stripe_dispute', e.disputeId, `Dispute ${e.status}.`);

    await writeAudit(app.db, {
      actorType: 'system',
      actorLabel: 'stripe webhook',
      action: 'invoice.dispute_closed',
      objectType: 'invoice',
      objectId: inv.id,
      contactId: inv.contact_id,
      details: { invoice_number: inv.invoice_number, stripe_event_id: e.eventId, dispute_id: e.disputeId, outcome: e.status, amount_cents: e.amountCents },
    });

    const out: StripeOutcome = { status, invoiceId: inv.id, invoiceNumber: inv.invoice_number };
    await recordOutcome(app, e.eventId, out);
    return out;
  });
}

/** Route a parsed event to its handler. `payment_completed` stays on markInvoicePaid's path. */
export async function handleStripeEvent(app: FastifyInstance, event: PaymentEvent): Promise<StripeOutcome> {
  switch (event.type) {
    case 'refund':
      return applyRefund(app, event);
    case 'dispute_opened':
      return openDispute(app, event);
    case 'dispute_closed':
      return closeDispute(app, event);
    default:
      return { status: 'ignored' };
  }
}

/**
 * The outbox handler for `invoice.refund_receipt`: tell the client the money went back.
 * Idempotent per refund via the audit trail — a receipt is sent once, however many times
 * the effect is asked for.
 */
export async function sendRefundReceipt(
  app: FastifyInstance,
  invoiceId: string,
  refundId: string
): Promise<{ sent: boolean; reason?: string }> {
  const { rows } = await app.db.query<{
    invoice_number: string; contact_id: string; first_name: string; email: string | null; language: 'en' | 'es';
    refund_cents: number | null; amount_refunded_cents: number;
  }>(
    `SELECT i.invoice_number, i.contact_id, c.first_name, c.email, c.language, i.amount_refunded_cents,
            (SELECT r.amount_cents FROM invoice_refunds r WHERE r.stripe_refund_id = $2 AND r.invoice_id = i.id) AS refund_cents
       FROM invoices i JOIN contacts c ON c.id = i.contact_id
      WHERE i.id = $1`,
    [invoiceId, refundId]
  );
  const inv = rows[0];
  if (!inv) return { sent: false, reason: 'invoice not found' };
  if (!inv.email) return { sent: false, reason: 'no_email' };

  const already = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = 'invoice.refund_receipt_sent' AND object_id = $1 AND details->>'refund_id' = $2 LIMIT 1`,
    [invoiceId, refundId]
  );
  if (already.rows.length > 0) return { sent: false, reason: 'already_sent' };

  const amount = inv.refund_cents ?? inv.amount_refunded_cents;
  // Item 9 (2026-09-09): fires from the webhook, not from a person — gated, hold recorded.
  if (!(await isAutomationEnabled(app, 'refund_receipt'))) {
    await writeAudit(app.db, {
      actorType: 'system', actorLabel: 'outbox',
      action: 'invoice.refund_receipt_suppressed', objectType: 'invoice', objectId: invoiceId, contactId: inv.contact_id,
      details: { invoice_number: inv.invoice_number, refund_id: refundId, amount_cents: amount, automation: 'refund_receipt' },
    });
    return { sent: false, reason: 'suppressed' };
  }
  await sendTemplatedEmail(app, {
    to: inv.email,
    templateKey: 'refund_processed',
    language: inv.language,
    contactId: inv.contact_id,
    vars: { first_name: inv.first_name, invoice_number: inv.invoice_number, amount: formatUsd(amount) },
  });
  await writeAudit(app.db, {
    actorType: 'system',
    actorLabel: 'outbox',
    action: 'invoice.refund_receipt_sent',
    objectType: 'invoice',
    objectId: invoiceId,
    contactId: inv.contact_id,
    details: { invoice_number: inv.invoice_number, refund_id: refundId, amount_cents: amount },
  });
  return { sent: true };
}
