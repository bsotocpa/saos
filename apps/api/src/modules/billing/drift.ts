/*
 * STRIPE DRIFT (2026-09-09, Brian's ruling after SA-2026-0003 read Paid twice).
 *
 * The lesson rule applied: the event that falsifies "refunded" (or "paid") is a Stripe read
 * on a schedule. Once a day, for every invoice that carries a payment intent, ask Stripe what
 * the charge says — refunded, how much, disputed — and compare it with what SAOS says. A
 * mismatch raises ONE task through the one door and corrects nothing: a person decides, and
 * presses re-sync (below) if the record is the thing that is wrong.
 *
 * Re-sync is the deliberate, audited action that pulls Stripe's refunds onto the invoice
 * through the same recording path the webhook uses (idempotent by refund id). It is how
 * SA-2026-0003 was put right, and it is a staff action, not a sweep.
 */

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { withTransaction } from '../../db.ts';
import { AppError } from '../../types.ts';
import { createTask } from '../tasks/service.ts';
import { ownerForRole } from '../../staffing.ts';
import { recordRefunds } from './refunds.ts';

export interface DriftRow {
  invoiceId: string;
  invoiceNumber: string;
  saos: { status: string; amountRefundedCents: number };
  stripe: { refunded: boolean; amountRefundedCents: number; disputed: boolean };
}

/** What SAOS would call the charge, given what Stripe says. */
export function expectedStatus(stripe: { refunded: boolean; amountRefundedCents: number; disputed: boolean }, paidCents: number): string {
  if (stripe.disputed) return 'disputed';
  if (stripe.amountRefundedCents >= paidCents && paidCents > 0) return 'refunded';
  if (stripe.amountRefundedCents > 0) return 'partially_refunded';
  return 'paid';
}

export async function runStripeDriftCheckJob(
  app: FastifyInstance,
  today: string,
  opts: { limit?: number } = {}
): Promise<{ checked: number; drifted: number; unverifiable: number; tasksCreated: number; skipped: boolean }> {
  // Once per calendar day, like the other daily jobs.
  const ran = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = 'ops.stripe_drift_checked' AND details->>'day' = $1 LIMIT 1`,
    [today]
  );
  if (ran.rows.length > 0) return { checked: 0, drifted: 0, unverifiable: 0, tasksCreated: 0, skipped: true };

  const { rows } = await app.db.query<{
    id: string; invoice_number: string; status: string; amount_paid_cents: number; amount_refunded_cents: number;
    stripe_payment_intent_id: string; contact_id: string;
  }>(
    `SELECT i.id, i.invoice_number, i.status::text AS status, i.amount_paid_cents, i.amount_refunded_cents,
            i.stripe_payment_intent_id, i.contact_id
       FROM invoices i
      WHERE i.stripe_payment_intent_id IS NOT NULL
        AND i.status IN ('paid', 'refunded', 'partially_refunded', 'disputed')
        -- A waived invoice (a payment Stripe cannot see from this key, decided by a person with a
        -- reason) is skipped and counted, never re-raised (2026-09-12).
        AND i.stripe_check_waived_at IS NULL
      ORDER BY i.paid_at DESC NULLS LAST
      LIMIT $1`,
    [opts.limit ?? 200]
  );

  const drifted: DriftRow[] = [];
  const unverifiable: Array<{ invoiceNumber: string; reason: string }> = [];
  let tasksCreated = 0;
  for (const inv of rows) {
    /*
     * 2026-09-10, the first daily run under the live key. SA-2026-0001 was paid on 08-13 under
     * the TEST key; the live key cannot see that payment intent; Stripe threw; the throw left
     * this loop, killed the daily tick, and four jobs (review requests, event reminders, the
     * perfection clock, the escalation ladder) and the health refresh did not run. A payment
     * Stripe cannot verify is a FINDING — a task, counted, on the run record — never a throw.
     */
    let charge: Awaited<ReturnType<typeof app.stripe.retrieveCharge>>;
    try {
      charge = await app.stripe.retrieveCharge(inv.stripe_payment_intent_id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      unverifiable.push({ invoiceNumber: inv.invoice_number, reason });
      const owner = await ownerForRole(app.db, 'comms_billing');
      const task = await createTask(app, {
        title: `Stripe cannot verify ${inv.invoice_number}'s payment under the current key`,
        description:
          `SAOS says ${inv.status}; Stripe answered: "${reason}". The usual cause is a payment taken under a ` +
          'different key (test vs live) — the record is right and Stripe simply cannot see it from here. ' +
          'Confirm in the Stripe dashboard (switch the mode toggle), note what you found on this task, and ' +
          'nothing needs changing on the invoice. If Stripe has NO record of it in either mode, tell Brian.',
        ...(owner ? { assignedStaffId: owner } : {}),
        contactId: inv.contact_id,
        priority: 2,
        source: 'automation',
        sourceType: 'stripe_drift',
        sourceId: inv.id,
      });
      if (task.created) tasksCreated++;
      continue;
    }
    if (!charge) continue; // the stub, or a payment intent Stripe no longer knows
    const expected = expectedStatus(charge, inv.amount_paid_cents);
    if (expected === inv.status && charge.amountRefundedCents === inv.amount_refunded_cents) continue;
    drifted.push({
      invoiceId: inv.id, invoiceNumber: inv.invoice_number,
      saos: { status: inv.status, amountRefundedCents: inv.amount_refunded_cents },
      stripe: { refunded: charge.refunded, amountRefundedCents: charge.amountRefundedCents, disputed: charge.disputed },
    });
    const owner = await ownerForRole(app.db, 'comms_billing');
    const task = await createTask(app, {
      title: `Stripe and SAOS disagree on ${inv.invoice_number}: SAOS says ${inv.status}, Stripe says ${expected}`,
      description:
        `SAOS: status ${inv.status}, refunded ${inv.amount_refunded_cents} cents. ` +
        `Stripe: refunded ${charge.amountRefundedCents} cents${charge.disputed ? ', disputed' : ''}. ` +
        'Nothing was changed. If Stripe is right, press "Re-sync from Stripe" on the invoice in Ops; ' +
        'if SAOS is right, say so on this task and tell Brian — that would mean Stripe moved money we did not.',
      ...(owner ? { assignedStaffId: owner } : {}),
      contactId: inv.contact_id,
      priority: 1,
      source: 'automation',
      sourceType: 'stripe_drift',
      sourceId: inv.id,
    });
    if (task.created) tasksCreated++;
  }

  const waived = await app.db.query<{ n: number; numbers: string[] }>(
    `SELECT count(*)::int AS n, COALESCE(array_agg(invoice_number ORDER BY invoice_number), '{}') AS numbers
       FROM invoices WHERE stripe_payment_intent_id IS NOT NULL AND stripe_check_waived_at IS NOT NULL`
  );
  await writeAudit(app.db, {
    actorType: 'system',
    actorLabel: 'stripe drift check',
    action: 'ops.stripe_drift_checked',
    details: { day: today, checked: rows.length, drifted: drifted.map((d) => d.invoiceNumber), unverifiable, waived: waived.rows[0]!.numbers },
  });
  if (drifted.length > 0) app.log.warn({ drifted }, 'Stripe and SAOS disagree about money');
  if (unverifiable.length > 0) app.log.warn({ unverifiable }, 'Stripe could not verify a payment under the current key');
  return { checked: rows.length, drifted: drifted.length, unverifiable: unverifiable.length, tasksCreated, skipped: false };
}

/**
 * Pull Stripe's refunds for this invoice's charge onto the record, through the same path the
 * webhook uses. A staff action with an audit row; idempotent by refund id.
 */
export async function resyncRefundsFromStripe(
  app: FastifyInstance,
  invoiceId: string,
  actor: { type: 'staff' | 'system'; id?: string | null; label: string }
): Promise<{ status: string; amountRefundedCents: number; recorded: number }> {
  const { rows } = await app.db.query<{
    id: string; invoice_number: string; status: string; amount_paid_cents: number; contact_id: string;
    stripe_payment_intent_id: string | null;
  }>(
    `SELECT id, invoice_number, status::text AS status, amount_paid_cents, contact_id, stripe_payment_intent_id
       FROM invoices WHERE id = $1`,
    [invoiceId]
  );
  const inv = rows[0];
  if (!inv) throw new AppError(404, 'not_found', 'Invoice not found.');
  if (!inv.stripe_payment_intent_id) throw new AppError(409, 'no_payment', `${inv.invoice_number} has no Stripe payment to sync from.`);
  const charge = await app.stripe.retrieveCharge(inv.stripe_payment_intent_id);
  if (!charge) throw new AppError(409, 'no_charge', `Stripe has no charge for ${inv.invoice_number}'s payment intent.`);

  return withTransaction(app.db, async () => {
    const result = await recordRefunds(app, {
      invoice: { id: inv.id },
      refunds: charge.refunds,
      amountRefundedCents: charge.amountRefundedCents,
      stripeEventId: null,
    });
    await writeAudit(app.db, {
      actorType: actor.type,
      actorId: actor.id ?? null,
      actorLabel: actor.label,
      action: 'invoice.refunds_resynced',
      objectType: 'invoice',
      objectId: inv.id,
      contactId: inv.contact_id,
      details: { from_status: inv.status, to_status: result.status, amount_refunded_cents: result.amountRefundedCents, recorded: result.recorded },
    });
    return result;
  });
}

/**
 * THE WAIVER (2026-09-12). A payment the current Stripe key cannot see (SA-2026-0001, taken under
 * the test key) raised a drift task nobody could resolve, every day. A person with billing.manage
 * records that the record is right and Stripe simply cannot see it, with a reason. The nightly
 * check skips the invoice from then on and counts it; the open drift tasks for it close; the
 * decision is audited with the reason. It does not touch the invoice's money fields.
 */
export async function waiveStripeCheck(
  app: FastifyInstance,
  invoiceId: string,
  reason: string,
  actor: { id: string; fullName: string }
): Promise<{ waived: true; invoiceNumber: string }> {
  const { rows } = await app.db.query<{ id: string; invoice_number: string; contact_id: string; stripe_payment_intent_id: string | null; waived_at: Date | null }>(
    `SELECT id, invoice_number, contact_id, stripe_payment_intent_id, stripe_check_waived_at AS waived_at FROM invoices WHERE id = $1`,
    [invoiceId]
  );
  const inv = rows[0];
  if (!inv) throw new AppError(404, 'not_found', 'Invoice not found.');
  if (!inv.stripe_payment_intent_id) throw new AppError(409, 'nothing_to_waive', 'This invoice has no Stripe payment; there is no check to waive.');
  if (inv.waived_at) throw new AppError(409, 'already_waived', 'The Stripe check on this invoice is already waived.');
  // A waiver answers a finding. With none open there is nothing to waive (Brian, 2026-09-12).
  const finding = await app.db.query(
    `SELECT 1 FROM tasks WHERE source_type = 'stripe_drift' AND source_id = $1
      AND status IN ('not_started', 'in_progress', 'waiting_for_input', 'deferred') LIMIT 1`,
    [invoiceId]
  );
  if (finding.rows.length === 0) throw new AppError(409, 'no_drift_finding', 'The nightly check has not raised anything on this invoice; there is nothing to waive.');
  await app.db.query(
    `UPDATE invoices SET stripe_check_waived_at = now(), stripe_check_waived_by_staff_id = $2, stripe_check_waived_reason = $3 WHERE id = $1`,
    [invoiceId, actor.id, reason]
  );
  const { closeTasksForSource } = await import('../tasks/service.ts');
  await closeTasksForSource(app, 'stripe_drift', invoiceId, `Stripe check waived by ${actor.fullName}: ${reason}`);
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
    action: 'invoice.stripe_check_waived', objectType: 'invoice', objectId: invoiceId, contactId: inv.contact_id,
    details: { invoice_number: inv.invoice_number, reason },
  });
  return { waived: true, invoiceNumber: inv.invoice_number };
}
