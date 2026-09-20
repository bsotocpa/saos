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
 *
 * THE DOOR (R29, 2026-09-20). Everything above was SAOS listening. `refundInvoice` below is SAOS
 * ACTING: a person with billing.manage refunds a paid invoice from Ops, the refund is created at
 * Stripe, and the row it writes carries the person. When Stripe's own charge.refunded arrives for
 * that refund id, `applyRefund` finds the row, updates it, and audits a RECONCILIATION rather than
 * a second refund — so the money is counted once, against the person who moved it.
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
import { noticesForInvoices, type NoticeState } from './notices.ts';
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
  /** Refund rows this delivery found already on the record and updated in place (R29). */
  reconciled?: number;
  /**
   * True when every refund in this event was created by a member of staff through the Ops door, so
   * the webhook only confirmed what SAOS already knew: no second row, no second receipt, and no
   * second money action on the CEO's line.
   */
  reconciledToTheDoor?: boolean;
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
    /**
     * Set ONLY by the Ops refund door (R29): the staff member who created the refund. A refund that
     * arrived from Stripe — the webhook, the dashboard, a re-sync — has no actor, and that absence
     * is the fact the money line reads as "outside the door".
     */
    actor?: { id: string; label: string } | undefined;
  }
): Promise<{ status: 'refunded' | 'partially_refunded'; amountRefundedCents: number; recorded: number; reconciled: number }> {
  const inv = await invoiceById(app, input.invoice.id);
  if (!inv) throw new AppError(404, 'not_found', 'Invoice not found.');
  let recorded = 0;
  let reconciled = 0;
  for (const r of input.refunds) {
    const ins = await app.db.query<{ id: string }>(
      `INSERT INTO invoice_refunds (invoice_id, stripe_refund_id, amount_cents, reason, stripe_event_id,
                                    refunded_by_staff_id, refunded_by_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (stripe_refund_id) DO NOTHING
       RETURNING id`,
      [inv.id, r.id, r.amountCents, r.reason, input.stripeEventId, input.actor?.id ?? null, input.actor?.label ?? null]
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
    } else {
      /*
       * THE RECONCILIATION (R29, 2026-09-20). This refund id is already on the record — the door
       * created it and Stripe's charge.refunded has now caught up, or the event was redelivered.
       * The row is UPDATED in place: it learns the Stripe event that confirmed it, and its amount
       * becomes Stripe's (Stripe is the authority on how much moved). Not a second row, and
       * deliberately no second receipt: the client is told about a refund once, by the row.
       */
      const upd = await app.db.query<{ id: string }>(
        `UPDATE invoice_refunds
            SET amount_cents = $4,
                -- stripe_event_id NAMES THE EVENT THAT RECORDED THIS ROW, and only the door's own
                -- rows may learn it late. A row a person put here by re-syncing from Stripe keeps
                -- NULL for good: money-digest's matching rule reads "this row does not carry this
                -- event's id" as "a person recorded it before the event arrived", which is what makes
                -- the webhook's own row fold into the initiator's instead of being counted again.
                -- Back-filling it there would quietly move that refund to "outside the door".
                stripe_event_id = CASE WHEN refunded_by_staff_id IS NOT NULL
                                       THEN COALESCE(stripe_event_id, $3) ELSE stripe_event_id END
          WHERE invoice_id = $1 AND stripe_refund_id = $2
          RETURNING id`,
        [inv.id, r.id, input.stripeEventId, r.amountCents]
      );
      if (upd.rows[0]) reconciled += 1;
    }
  }
  // Stripe's cumulative figure is the truth; the rows are the itemisation of it.
  const status = await applyRefundedAmount(app, inv, input.amountRefundedCents);
  return { status, amountRefundedCents: Math.min(input.amountRefundedCents, inv.amount_paid_cents), recorded, reconciled };
}

/**
 * THE OPS REFUND DOOR (Brian, ruling R29, 2026-09-20).
 *
 * Until tonight the only way money went back was the Stripe dashboard, with SAOS finding out later
 * from a webhook or a nightly drift check. A firm whose refunds happen outside its own system has no
 * refund policy — it has a habit. This is the door: a paid (or partly refunded) invoice, an amount
 * no larger than what is still refundable, a standalone reason that stands on its own for the next
 * reader, and the refund created AT STRIPE before SAOS writes anything down.
 *
 * ORDER MATTERS, AND IT IS THE SAME ORDER AS THE VOID'S SESSION EXPIRY. Everything that can refuse
 * refuses first, with words. Then the outward call — which cannot be rolled back — is made. Only
 * then, in ONE transaction: the refund row with the Stripe id AND the person, the invoice's amounts
 * and status, the audit line as a money action, and the client's receipt behind its automation gate.
 * If that transaction failed after Stripe moved the money, the nightly drift check finds the
 * disagreement the next morning and "Re-sync from Stripe" records it: the failure mode is a day of
 * lag on the record, never money that moved with nothing to find it.
 *
 * The receipt is NOT sent here and is not exempt from anything: it is the same
 * `invoice.refund_receipt` effect the webhook queues, gated by `refund_receipt`, suppressed and
 * counted while Brian has that automation off.
 */
export async function refundInvoice(
  app: FastifyInstance,
  invoiceId: string,
  input: { amountCents: number; reason: string },
  actor: { id: string; fullName: string }
): Promise<{
  invoiceId: string;
  invoiceNumber: string;
  status: 'refunded' | 'partially_refunded';
  stripeRefundId: string;
  amountCents: number;
  amountRefundedCents: number;
  refundableCents: number;
  reason: string;
  refundedBy: string;
  notice: NoticeState | null;
}> {
  const reason = input.reason.trim();
  const inv = await invoiceById(app, invoiceId);
  if (!inv) throw new AppError(404, 'not_found', 'Invoice not found.');

  // Every refusal, in words, before a cent moves anywhere.
  if (inv.status === 'disputed') {
    throw new AppError(409, 'not_refundable', `${inv.invoice_number} is under a card dispute. The dispute decides where this money goes; refunding it now would return it twice.`);
  }
  // Said before the wider refusal, because "SR-2026-0002 is refunded; only a paid invoice can be
  // refunded" is a sentence that argues with itself.
  if (inv.status === 'refunded') {
    throw new AppError(409, 'nothing_refundable', `${inv.invoice_number} has already been refunded in full.`);
  }
  if (inv.status !== 'paid' && inv.status !== 'partially_refunded') {
    throw new AppError(409, 'not_refundable', `${inv.invoice_number} is ${inv.status.replace('_', ' ')}; only a paid invoice can be refunded.`);
  }
  const refundable = inv.amount_paid_cents - inv.amount_refunded_cents;
  if (refundable <= 0) {
    throw new AppError(409, 'nothing_refundable', `${inv.invoice_number} has already been refunded in full.`);
  }
  if (input.amountCents > refundable) {
    throw new AppError(409, 'amount_too_large', `The most that can still be refunded on ${inv.invoice_number} is ${formatUsd(refundable)}.`);
  }
  const { rows: payment } = await app.db.query<{ pi: string | null }>(
    `SELECT stripe_payment_intent_id AS pi FROM invoices WHERE id = $1`,
    [inv.id]
  );
  const paymentIntentId = payment[0]?.pi ?? null;
  if (!paymentIntentId) {
    throw new AppError(409, 'no_payment', `${inv.invoice_number} carries no Stripe payment, so there is nothing for Stripe to refund. Return this money the way it arrived and record it on the invoice by hand.`);
  }

  /*
   * THE OUTWARD CALL. The idempotency key is the invoice, what had already been refunded, and this
   * amount: a double-pressed control repeats the key and Stripe returns the SAME refund, while a
   * genuine second refund of the same size comes after the first has moved amount_refunded_cents
   * and therefore carries a different key.
   *
   * TWO PEOPLE AT ONCE. The bound above is read without a row lock deliberately — a lock held
   * across an HTTP call to Stripe is a worse failure than the one it prevents. Two presses of the
   * same amount are one refund (same key, same refund id, and the insert below conflicts to
   * nothing). Two presses of DIFFERENT amounts that together exceed the charge are refused by
   * STRIPE, which is the authority on how much of a charge is left to refund; that refusal reaches
   * the person in the modal. SAOS therefore cannot over-refund a charge even where its own view of
   * the balance is a moment stale.
   */
  const refund = await app.stripe.createRefund({
    paymentIntentId,
    amountCents: input.amountCents,
    idempotencyKey: `saos-refund-${inv.id}-${inv.amount_refunded_cents}-${input.amountCents}`,
  });

  const result = await withTransaction(app.db, async () => {
    // THE one recording path, with the actor: the row, the amounts, the status, the receipt.
    const recorded = await recordRefunds(app, {
      invoice: { id: inv.id },
      refunds: [{ id: refund.id, amountCents: refund.amountCents, reason }],
      amountRefundedCents: inv.amount_refunded_cents + refund.amountCents,
      stripeEventId: null,
      actor: { id: actor.id, label: actor.fullName },
    });
    await writeAudit(app.db, {
      actorType: 'staff',
      actorId: actor.id,
      actorLabel: actor.fullName,
      action: 'invoice.refund_issued',
      objectType: 'invoice',
      objectId: inv.id,
      contactId: inv.contact_id,
      details: {
        invoice_number: inv.invoice_number,
        amount_cents: refund.amountCents,
        reason,
        stripe_refund_id: refund.id,
        stripe_payment_intent_id: paymentIntentId,
        refundable_before_cents: refundable,
        to_status: recorded.status,
      },
    });
    return recorded;
  });

  const notice = (await noticesForInvoices(app, [inv.id]))[inv.id]?.find((n) => n.kind === 'refund_receipt') ?? null;
  return {
    invoiceId: inv.id,
    invoiceNumber: inv.invoice_number,
    status: result.status,
    stripeRefundId: refund.id,
    amountCents: refund.amountCents,
    amountRefundedCents: result.amountRefundedCents,
    refundableCents: refundable - refund.amountCents,
    reason,
    refundedBy: actor.fullName,
    notice,
  };
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
    // THE one recording path (shared with re-sync and the Ops door): rows by refund id, gross
    // amount, status, engagement reversal, and a receipt per NEWLY recorded refund.
    const { status, recorded, reconciled } = await recordRefunds(app, {
      invoice: { id: inv.id }, refunds, amountRefundedCents: e.amountRefundedCents, stripeEventId: e.eventId || null,
    });

    /*
     * WHOSE MONEY ACTION IS THIS (R29, 2026-09-20)? A refund every one of whose ids was created by a
     * member of staff through the Ops door is not a second money action — it is Stripe confirming
     * one SAOS already made and already put on the CEO's money line. So it is audited as a
     * RECONCILIATION, an action deliberately absent from MONEY_ACTIONS: the money is counted once,
     * at the door, attributed to the person who pressed it.
     *
     * Anything else keeps `invoice.refunded`: a refund SAOS heard about first (the dashboard) is
     * money that moved outside the door and belongs on its own line, and a re-synced one is folded
     * into its initiator by money-digest's own matching rule.
     */
    const doorOwned = refunds.length === 0 ? 0 : (await app.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM invoice_refunds
        WHERE invoice_id = $1 AND stripe_refund_id = ANY($2::text[]) AND refunded_by_staff_id IS NOT NULL`,
      [inv.id, refunds.map((r) => r.id)]
    )).rows[0]!.n;
    const reconciledToTheDoor = recorded === 0 && refunds.length > 0 && doorOwned === refunds.length;

    await writeAudit(app.db, {
      actorType: 'system',
      actorLabel: 'stripe webhook',
      action: reconciledToTheDoor ? 'invoice.refund_reconciled' : 'invoice.refunded',
      objectType: 'invoice',
      objectId: inv.id,
      contactId: inv.contact_id,
      details: {
        invoice_number: inv.invoice_number,
        stripe_event_id: e.eventId,
        refund_ids: refunds.map((r) => r.id),
        amount_refunded_cents: Math.min(e.amountRefundedCents, inv.amount_paid_cents),
        status,
        ...(reconciledToTheDoor ? { reconciled_to_staff_refund: true } : {}),
      },
    });


    const out: StripeOutcome = {
      status, invoiceId: inv.id, invoiceNumber: inv.invoice_number, recorded, reconciled,
      ...(reconciledToTheDoor ? { reconciledToTheDoor: true } : {}),
    };
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
