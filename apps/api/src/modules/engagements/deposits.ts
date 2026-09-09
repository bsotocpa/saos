/*
 * STRANDED DEPOSITS (2026-09-09, Brian's ruling, item 7).
 *
 * SA-2026-0001 (a paid deposit) sat on engagement 70adeb82 — withdrawn on 08-16 as a duplicate.
 * Money the client paid for work, attached to work that no longer exists, with nothing that
 * would ever notice. Two rules:
 *
 *   a) Withdrawing an engagement that carries a paid, unapplied deposit is refused — unless
 *      the withdrawal is a supersession (the deposit transfers to the successor) or the actor
 *      explicitly chooses "refund", which raises a billing task through the one door. No
 *      automatic Stripe refund, ever.
 *   b) A deposit invoice can be TRANSFERRED between two engagements of the same contact, by
 *      billing.manage, with an audit row on both engagements.
 */

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { withTransaction } from '../../db.ts';
import { AppError } from '../../types.ts';
import { createTask } from '../tasks/service.ts';
import { ownerForRole } from '../../staffing.ts';
import { formatUsd } from '../billing/service.ts';

export interface UnappliedDeposit {
  invoiceId: string;
  invoiceNumber: string;
  availableCents: number;
}

/** Paid deposit invoices on this engagement with credit left (paid − refunded − applied). */
export async function unappliedDepositsFor(app: FastifyInstance, engagementId: string): Promise<UnappliedDeposit[]> {
  const { rows } = await app.db.query<{ id: string; invoice_number: string; available: number }>(
    `SELECT i.id, i.invoice_number, (i.amount_paid_cents - i.amount_refunded_cents - i.deposit_applied_cents) AS available
       FROM invoices i
      WHERE i.engagement_id = $1
        AND i.status IN ('paid', 'partially_refunded')
        AND i.deposit_credit_from_invoice_id IS NULL
        AND (i.amount_paid_cents - i.amount_refunded_cents) > i.deposit_applied_cents
        AND EXISTS (SELECT 1 FROM quotes q WHERE q.deposit_invoice_id = i.id)`,
    [engagementId]
  );
  return rows.map((r) => ({ invoiceId: r.id, invoiceNumber: r.invoice_number, availableCents: r.available }));
}

/**
 * Move a paid, unapplied deposit invoice from one engagement to another of the SAME contact.
 * The credit follows the invoice (it derives from invoices.engagement_id), so this is the
 * whole of the transfer; the audit row sits on both engagements.
 */
export async function transferDeposit(
  app: FastifyInstance,
  input: { invoiceId: string; toEngagementId: string; reason: string },
  actor: { type: 'staff' | 'system'; id?: string | null; label: string }
): Promise<{ invoiceNumber: string; fromEngagementId: string | null; toEngagementId: string; availableCents: number }> {
  const reason = input.reason.trim();
  if (reason.length < 5) throw new AppError(400, 'reason_required', 'Say why the deposit is moving — it is the record.');
  return withTransaction(app.db, async () => {
    const inv = (await app.db.query<{
      id: string; invoice_number: string; status: string; contact_id: string; engagement_id: string | null;
      amount_paid_cents: number; amount_refunded_cents: number; deposit_applied_cents: number;
    }>(
      `SELECT id, invoice_number, status::text AS status, contact_id, engagement_id, amount_paid_cents, amount_refunded_cents, deposit_applied_cents
         FROM invoices WHERE id = $1 FOR UPDATE`,
      [input.invoiceId]
    )).rows[0];
    if (!inv) throw new AppError(404, 'not_found', 'Invoice not found.');
    if (inv.status !== 'paid' && inv.status !== 'partially_refunded') {
      throw new AppError(409, 'not_a_paid_deposit', `${inv.invoice_number} is ${inv.status}; only a paid deposit can be moved.`);
    }
    const available = inv.amount_paid_cents - inv.amount_refunded_cents - inv.deposit_applied_cents;
    if (available <= 0) throw new AppError(409, 'nothing_to_move', `${inv.invoice_number} has no unapplied credit left.`);

    const to = (await app.db.query<{ id: string; contact_id: string; status: string; title: string | null }>(
      `SELECT id, contact_id, status::text AS status, title FROM engagements WHERE id = $1`,
      [input.toEngagementId]
    )).rows[0];
    if (!to) throw new AppError(404, 'not_found', 'Target engagement not found.');
    if (to.contact_id !== inv.contact_id) {
      throw new AppError(409, 'different_client', 'A deposit moves only between engagements of the same client.');
    }
    if (to.status !== 'active' && to.status !== 'on_hold') {
      throw new AppError(409, 'target_not_open', `The target engagement is ${to.status}; a deposit moves onto open work.`);
    }
    if (to.id === inv.engagement_id) throw new AppError(409, 'same_engagement', 'The deposit is already on that engagement.');

    const from = inv.engagement_id;
    await app.db.query(`UPDATE invoices SET engagement_id = $2 WHERE id = $1`, [inv.id, to.id]);
    const details = {
      invoice_number: inv.invoice_number, from_engagement_id: from, to_engagement_id: to.id, available_cents: available, reason,
    };
    for (const engagementId of [from, to.id]) {
      if (!engagementId) continue;
      await writeAudit(app.db, {
        actorType: actor.type, actorId: actor.id ?? null, actorLabel: actor.label,
        action: 'engagement.deposit_transferred', objectType: 'engagement', objectId: engagementId,
        contactId: inv.contact_id, details,
      });
    }
    await writeAudit(app.db, {
      actorType: actor.type, actorId: actor.id ?? null, actorLabel: actor.label,
      action: 'invoice.deposit_transferred', objectType: 'invoice', objectId: inv.id, contactId: inv.contact_id, details,
    });
    return { invoiceNumber: inv.invoice_number, fromEngagementId: from, toEngagementId: to.id, availableCents: available };
  });
}

/**
 * The actor chose "refund" on withdrawal: a billing task through the one door, naming the
 * deposit. Nothing touches Stripe here — a person issues the refund, and the webhook records it.
 */
export async function raiseDepositRefundTask(
  app: FastifyInstance,
  input: { engagementId: string; contactId: string; deposits: UnappliedDeposit[]; reason: string },
  actor: { label: string }
): Promise<{ taskId: string }> {
  const owner = await ownerForRole(app.db, 'comms_billing');
  const named = input.deposits.map((d) => `${d.invoiceNumber} (${formatUsd(d.availableCents)} unapplied)`).join(', ');
  const task = await createTask(app, {
    title: `Refund the deposit on a withdrawn engagement: ${named}`,
    description:
      `${actor.label} withdrew the engagement ("${input.reason}") and chose REFUND for its unapplied deposit. ` +
      'Issue the refund in the Stripe dashboard; the webhook records it on the invoice and the client gets the receipt. ' +
      'Nothing was refunded automatically.',
    ...(owner ? { assignedStaffId: owner } : {}),
    contactId: input.contactId,
    engagementId: input.engagementId,
    priority: 1,
    source: 'automation',
    sourceType: 'deposit_refund',
    sourceId: input.engagementId,
  });
  return { taskId: task.id };
}

/** Item 7d: every invoice attached to an engagement that is not active — by contact and amount. */
export async function invoicesOnNonActiveEngagements(app: FastifyInstance): Promise<Array<{
  contact: string; invoiceNumber: string; status: string; totalCents: number; unappliedCents: number; engagementStatus: string; engagementTitle: string | null;
}>> {
  const { rows } = await app.db.query<{
    contact: string; invoice_number: string; status: string; total_cents: number; unapplied: number; engagement_status: string; title: string | null;
  }>(
    `SELECT c.first_name || ' ' || left(c.last_name, 1) || '.' AS contact, i.invoice_number, i.status::text AS status, i.total_cents,
            (i.amount_paid_cents - i.amount_refunded_cents - i.deposit_applied_cents) AS unapplied,
            e.status::text AS engagement_status, e.title
       FROM invoices i JOIN engagements e ON e.id = i.engagement_id JOIN contacts c ON c.id = i.contact_id
      WHERE e.status NOT IN ('active', 'on_hold')
      ORDER BY c.last_name, c.first_name, i.total_cents DESC`
  );
  return rows.map((r) => ({
    contact: r.contact, invoiceNumber: r.invoice_number, status: r.status, totalCents: r.total_cents,
    unappliedCents: r.unapplied, engagementStatus: r.engagement_status, engagementTitle: r.title,
  }));
}
