/*
 * THE VOID PATH (2026-09-09, Brian's ruling).
 *
 * Void is how an invoice that should never be paid is retired: a superseded deposit, a
 * duplicate, a mistake. It is NOT how money is given back — a paid invoice is refunded,
 * and the database refuses to void one (migration 0081 holds the rule; this module only
 * performs the consequences).
 *
 * On void, in one transaction: status void with reason and actor, the engagement's payment
 * mark back to unbilled, the audit line, and the intent to tell the client (outbox) — they
 * may be holding a live pay link to an invoice that no longer exists, and must not use it.
 * After the commit, best effort: the open Stripe Checkout session is expired, so the link
 * in their inbox dies at Stripe's end too. If that call fails, the webhook path knows a
 * void invoice cannot be paid and raises a task instead of flipping it.
 *
 * The invoice number is retained. Never renumbered, never reused.
 */

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { enqueueEffect } from '../../outbox.ts';
import { withTransaction } from '../../db.ts';
import { AppError } from '../../types.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { isAutomationEnabled } from '../../automations.ts';
import { formatUsd } from './service.ts';
import { noticesForInvoices, type NoticeState } from './notices.ts';

export const VOIDABLE_STATUSES = ['sent', 'overdue'] as const;

export interface VoidResult {
  invoiceId: string;
  invoiceNumber: string;
  /** The Stripe session that was open on it, if any — expired after commit. */
  expiredSession: string | null;
  /**
   * The cancellation notice, as it actually stands when this returns: queued (an outbox
   * row, not yet delivered) — never "the client has been told" (2026-09-09).
   */
  notice: NoticeState | null;
}

/** Who voided: a staff member, or the system acting on a rule (decision 1: withdrawal). */
/** A staff member (AuthedStaff fits), or the system acting on a rule (id null). */
export interface VoidActor { id: string | null; fullName: string; email?: string; roleKey?: string; permissions?: string[]; sessionId?: string }

export async function voidInvoice(
  app: FastifyInstance,
  invoiceId: string,
  input: { reason: string },
  actor: VoidActor
): Promise<VoidResult> {
  const reason = input.reason.trim();
  if (reason.length < 5) {
    throw new AppError(400, 'reason_required', 'Say why this invoice is being voided — it is the record.');
  }

  const voided = await withTransaction(app.db, async () => {
    const { rows } = await app.db.query<{
      id: string; invoice_number: string; status: string; total_cents: number;
      amount_paid_cents: number; amount_refunded_cents: number;
      contact_id: string; tax_engagement_id: string | null; stripe_checkout_session_id: string | null;
      engagement_id: string | null;
    }>(
      `SELECT id, invoice_number, status::text AS status, total_cents, amount_paid_cents, amount_refunded_cents,
              contact_id, tax_engagement_id, stripe_checkout_session_id, engagement_id
         FROM invoices WHERE id = $1 FOR UPDATE`,
      [invoiceId]
    );
    const inv = rows[0];
    if (!inv) throw new AppError(404, 'not_found', 'Invoice not found.');

    // Say it in words before the database says it in a constraint. Same rule, both places.
    if (inv.status === 'paid' || inv.status === 'partially_refunded' || inv.status === 'disputed' || inv.status === 'refunded') {
      throw new AppError(409, 'not_voidable', `${inv.invoice_number} is ${inv.status}. A paid invoice is refunded, not voided.`);
    }
    if (inv.status === 'void') {
      throw new AppError(409, 'already_void', `${inv.invoice_number} is already void.`);
    }
    if (!(VOIDABLE_STATUSES as readonly string[]).includes(inv.status)) {
      throw new AppError(409, 'not_voidable', `${inv.invoice_number} is ${inv.status}; only a sent or overdue invoice can be voided.`);
    }
    if (inv.amount_paid_cents > inv.amount_refunded_cents) {
      throw new AppError(409, 'has_payment', `${inv.invoice_number} carries a payment. Refund it first.`);
    }

    // The trigger re-checks every one of the above; this UPDATE is where it fires.
    await app.db.query(
      `UPDATE invoices
          SET status = 'void', void_reason = $2, voided_by_staff_id = $3, voided_by_label = $4, voided_at = now(),
              stripe_checkout_session_id = NULL, pay_token_revoked_at = now()
        WHERE id = $1`,
      [inv.id, reason, actor.id, actor.fullName]
    );
    if (inv.tax_engagement_id) {
      await app.db.query(
        `UPDATE tax_engagements SET payment_status = 'unbilled', invoice_number = NULL, invoice_amount_cents = NULL
          WHERE id = $1`,
        [inv.tax_engagement_id]
      );
    }
    /*
     * DECISION 3 (2026-09-09): void reverses issuance COMPLETELY. Acceptance stamped the
     * engagement with the deposit it intended to charge; "unbilled" on the tax engagement
     * beside "deposit charged" with an amount on the engagement was two answers to one question.
     * The stamp is re-derived from what is still live, which after this void is nothing.
     */
    if (inv.engagement_id) {
      const { restampDepositFromRecord } = await import('../engagements/deposits.ts');
      await restampDepositFromRecord(app, inv.engagement_id, { type: actor.id ? 'staff' : 'system', id: actor.id, label: actor.fullName });
    }
    await writeAudit(app.db, {
      actorType: actor.id ? 'staff' : 'system',
      actorId: actor.id,
      actorLabel: actor.fullName,
      action: 'invoice.voided',
      objectType: 'invoice',
      objectId: inv.id,
      contactId: inv.contact_id,
      details: {
        invoice_number: inv.invoice_number,
        from_status: inv.status,
        total_cents: inv.total_cents,
        reason,
        stripe_checkout_session_id: inv.stripe_checkout_session_id,
      },
    });
    // The client is told through the outbox, so the notice commits with the void.
    await enqueueEffect(app, {
      effect: 'invoice.void_notice',
      payload: { invoiceId: inv.id },
      contactId: inv.contact_id,
      objectType: 'invoice',
      objectId: inv.id,
    });
    return inv;
  });

  // Outside the transaction: an outward call that cannot be rolled back. Best effort — the
  // invoice is already void whatever Stripe says, and a payment on a void invoice is caught
  // at the webhook.
  let expiredSession: string | null = null;
  if (voided.stripe_checkout_session_id) {
    try {
      await app.stripe.expireCheckoutSession(voided.stripe_checkout_session_id);
      expiredSession = voided.stripe_checkout_session_id;
      await writeAudit(app.db, {
        actorType: 'system',
        actorLabel: 'void',
        action: 'invoice.checkout_session_expired',
        objectType: 'invoice',
        objectId: voided.id,
        contactId: voided.contact_id,
        details: { session: voided.stripe_checkout_session_id },
      });
    } catch (err) {
      app.log.warn(
        { invoice: voided.invoice_number, session: voided.stripe_checkout_session_id, err },
        'could not expire the checkout session of a voided invoice — the webhook guard covers a late payment'
      );
    }
  }

  const notice = (await noticesForInvoices(app, [voided.id]))[voided.id]?.find((n) => n.kind === 'void_notice') ?? null;
  return { invoiceId: voided.id, invoiceNumber: voided.invoice_number, expiredSession, notice };
}

/** The outbox handler for `invoice.void_notice`: the pay link in their inbox is dead; say so. */
export async function sendVoidNotice(
  app: FastifyInstance,
  invoiceId: string
): Promise<{ sent: boolean; reason?: string }> {
  const { rows } = await app.db.query<{
    invoice_number: string; total_cents: number; status: string; contact_id: string;
    first_name: string; email: string | null; language: 'en' | 'es';
  }>(
    `SELECT i.invoice_number, i.total_cents, i.status::text AS status, i.contact_id, c.first_name, c.email, c.language
       FROM invoices i JOIN contacts c ON c.id = i.contact_id WHERE i.id = $1`,
    [invoiceId]
  );
  const inv = rows[0];
  if (!inv) return { sent: false, reason: 'invoice not found' };
  if (inv.status !== 'void') return { sent: false, reason: 'already_sent' }; // no longer void: nothing to say
  if (!inv.email) return { sent: false, reason: 'no_email' };

  const already = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = 'invoice.void_notice_sent' AND object_id = $1 LIMIT 1`,
    [invoiceId]
  );
  if (already.rows.length > 0) return { sent: false, reason: 'already_sent' };

  // Item 9 (2026-09-09): the void is a person's action; the notice was automatic — gated,
  // and the hold is recorded on the invoice's send log.
  if (!(await isAutomationEnabled(app, 'void_notice'))) {
    await writeAudit(app.db, {
      actorType: 'system', actorLabel: 'outbox',
      action: 'invoice.void_notice_suppressed', objectType: 'invoice', objectId: invoiceId, contactId: inv.contact_id,
      details: { invoice_number: inv.invoice_number, amount_cents: inv.total_cents, automation: 'void_notice' },
    });
    return { sent: false, reason: 'suppressed' };
  }

  await sendTemplatedEmail(app, {
    to: inv.email,
    templateKey: 'invoice_voided',
    language: inv.language,
    contactId: inv.contact_id,
    vars: { first_name: inv.first_name, invoice_number: inv.invoice_number, amount: formatUsd(inv.total_cents) },
  });
  await writeAudit(app.db, {
    actorType: 'system',
    actorLabel: 'outbox',
    action: 'invoice.void_notice_sent',
    objectType: 'invoice',
    objectId: invoiceId,
    contactId: inv.contact_id,
    details: { invoice_number: inv.invoice_number },
  });
  return { sent: true };
}
