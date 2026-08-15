// FINDING #26 — reconciling a paid deposit against the invoice that follows it.
//
// Master §2 and booking_confirmation both promise this and nothing performed it: the
// filed-to-invoice automation billed the full fee with no knowledge of what the client
// had already paid. Accepting an 1120-S quote meant paying the deposit and then being
// invoiced the whole fee on top of it; on v5's full-prepay lines it was exactly double.
//
// ONE PATH, same rule as settlement (#24). The credit derives from a deposit invoice
// that STRIPE CONFIRMED as paid — `status = 'paid'`, which only markInvoicePaid sets, and
// which only the webhook or the reconcile backstop reach. It is never taken from the
// engagement's stamped `deposit_charged_cents`: that records what we INTENDED to charge,
// and a deposit that was issued but never paid must credit nothing.

import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types.ts';

/** The line a client reads. Matched by the guard, so it lives in one place. */
export const DEPOSIT_CREDIT_LABEL_EN = 'Deposit paid — applied';
export const DEPOSIT_CREDIT_LABEL_ES = 'Depósito pagado — aplicado';

export interface AvailableDeposit {
  /** The deposit invoice this credit would come from. */
  depositInvoiceId: string;
  depositInvoiceNumber: string;
  /** Paid, minus whatever earlier invoices already consumed. */
  availableCents: number;
}

/**
 * Deposits paid for this engagement that still have credit left.
 *
 * Ordered oldest first so the earliest deposit is consumed first — the same order a
 * person reading the account would expect, and it keeps a later deposit available for a
 * later invoice rather than stranding the first.
 */
export async function availableDepositCredit(
  app: FastifyInstance,
  engagementId: string
): Promise<AvailableDeposit[]> {
  const { rows } = await app.db.query<{
    id: string; invoice_number: string; available: number;
  }>(
    `SELECT i.id, i.invoice_number,
            (i.total_cents - i.deposit_applied_cents) AS available
       FROM invoices i
      WHERE i.engagement_id = $1
        -- Stripe-confirmed only. 'paid' is set by markInvoicePaid alone, which the
        -- webhook and the reconcile backstop are the only routes into.
        AND i.status = 'paid'
        -- A deposit invoice is one that CARRIED a deposit, not one that consumed one.
        AND i.deposit_credit_from_invoice_id IS NULL
        AND i.total_cents > i.deposit_applied_cents
        AND EXISTS (
          SELECT 1 FROM quotes q WHERE q.deposit_invoice_id = i.id
        )
      ORDER BY i.created_at`,
    [engagementId]
  );
  return rows.map((r) => ({
    depositInvoiceId: r.id,
    depositInvoiceNumber: r.invoice_number,
    availableCents: r.available,
  }));
}

/**
 * Consume up to `wantedCents` of a deposit, atomically.
 *
 * The UPDATE re-checks the remaining balance in its own WHERE clause, so two invoices
 * generated at once cannot both claim the same deposit: the second matches no row and is
 * told so, rather than quietly crediting money that was already credited.
 */
export async function consumeDepositCredit(
  app: FastifyInstance,
  depositInvoiceId: string,
  wantedCents: number
): Promise<number> {
  /*
   * The pre-update balance is captured in a CTE, and the amount applied is computed from
   * THAT rather than from the updated row.
   *
   * The obvious version — RETURNING LEAST($2, total_cents - deposit_applied_cents) — is
   * wrong in a way that reads as correct: RETURNING evaluates against the row AFTER the
   * SET, by which point the remaining balance is zero, so it reported that nothing had
   * been applied while having applied it. The credit silently vanished.
   *
   * FOR UPDATE holds the row for the duration, so two invoices generated at once cannot
   * both claim the same deposit.
   */
  const { rows } = await app.db.query<{ applied: number }>(
    `WITH before AS (
       SELECT id, (total_cents - deposit_applied_cents) AS avail
         FROM invoices WHERE id = $1 FOR UPDATE
     )
     UPDATE invoices i
        SET deposit_applied_cents = i.deposit_applied_cents + LEAST($2, b.avail)
       FROM before b
      WHERE i.id = b.id AND b.avail > 0
      RETURNING LEAST($2, b.avail) AS applied`,
    [depositInvoiceId, wantedCents]
  );
  return rows[0]?.applied ?? 0;
}

/**
 * THE GUARD (Brian: "no silent full-price bills").
 *
 * Called after the lines are resolved and before the invoice is written. If this
 * engagement has a paid deposit with credit left and the lines do not carry it, the
 * invoice would bill full price over money already taken — so generation stops.
 *
 * It fails LOUDLY on purpose. The quiet alternative — apply it anyway — would hide a
 * caller that built its own lines and bypassed the automatic path, and the next such
 * caller would be silently wrong in some way this one is not.
 */
export async function assertDepositCreditApplied(
  app: FastifyInstance,
  engagementId: string | undefined,
  lineDescriptions: string[]
): Promise<void> {
  if (!engagementId) return;
  const available = await availableDepositCredit(app, engagementId);
  const outstanding = available.reduce((sum, d) => sum + d.availableCents, 0);
  if (outstanding === 0) return;

  const carriesCredit = lineDescriptions.some(
    (d) => d === DEPOSIT_CREDIT_LABEL_EN || d === DEPOSIT_CREDIT_LABEL_ES
  );
  if (carriesCredit) return;

  throw new AppError(
    409,
    'deposit_credit_missing',
    `This engagement has ${(outstanding / 100).toFixed(2)} of paid deposit not yet credited ` +
      `(${available.map((d) => d.depositInvoiceNumber).join(', ')}), and this invoice does not ` +
      `apply it — it would bill full price over money the client has already paid. ` +
      `Master §2 promises the opposite. See finding #26.`
  );
}
