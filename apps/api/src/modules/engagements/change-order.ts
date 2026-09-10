/*
 * CHANGE ORDERS (2026-09-09, Brian's ruling).
 *
 * A plain quote for a service line the client already has active work on — same contact,
 * same line, same period — cannot be sent. It must be a change order naming the engagement it
 * replaces. At acceptance, inside the #48 claim, the old engagement is withdrawn ("superseded
 * by change order <quote>"), the new one becomes active with the new quote's price lock, any
 * paid-and-unapplied deposit credit moves to the new engagement, and ONE audit row records the
 * supersession. The database's partial unique index (migration 0083) is the guard underneath:
 * the withdrawal has to land before the new row can, and it does, in the same transaction.
 */

import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types.ts';
import { writeAudit } from '../../audit.ts';
import { engagementLinesForQuote } from '../pricing/engagement-lines.ts';
import { todayChicago } from '../tax/deadlines.ts';
import { activeEngagementsFor, periodKeyFor } from './period.ts';

export interface ChangeOrderTarget {
  engagementId: string;
  serviceLine: string;
  periodKey: string;
}

/** The tax year a quote names, when it does (interview answer `tax_year`). */
export async function quoteTaxYear(app: FastifyInstance, quoteId: string): Promise<number | null> {
  const { rows } = await app.db.query<{ tax_year: string | null }>(
    `SELECT interview_answers->>'tax_year' AS tax_year FROM quotes WHERE id = $1`,
    [quoteId]
  );
  const raw = rows[0]?.tax_year;
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 1990 && n < 2200 ? n : null;
}

/** Each engagement line on the quote with the period it would cover. */
export async function periodsForQuote(
  app: FastifyInstance,
  quoteId: string
): Promise<Array<{ serviceLine: string; periodKey: string | null }>> {
  const taxYear = await quoteTaxYear(app, quoteId);
  const lines = await engagementLinesForQuote(app, quoteId);
  const todayIso = todayChicago();
  return lines.map((l) => ({ serviceLine: l.serviceLine, periodKey: periodKeyFor(l.serviceLine, { taxYear, todayIso }) }));
}

/**
 * THE SEND GATE. Refuses a plain quote for a line with active work; accepts a change order
 * that names one of those engagements. The refusal carries the candidates (as `issues`, which
 * the API error handler ships), so the builder can offer them as buttons instead of an
 * instruction the screen cannot follow.
 */
export async function assertChangeOrderIfActive(
  app: FastifyInstance,
  quoteId: string,
  contactId: string,
  changeOrderOf: string | undefined
): Promise<ChangeOrderTarget | null> {
  const periods = await periodsForQuote(app, quoteId);
  const candidates: Array<{ id: string; title: string | null; serviceLine: string; periodKey: string }> = [];
  for (const p of periods) {
    if (p.periodKey === null) continue; // per-matter lines: not enforced (period.ts)
    for (const e of await activeEngagementsFor(app, contactId, p.serviceLine, p.periodKey)) {
      candidates.push({ id: e.id, title: e.title, serviceLine: p.serviceLine, periodKey: p.periodKey });
    }
  }

  if (changeOrderOf) {
    const target = candidates.find((c) => c.id === changeOrderOf);
    if (!target) {
      throw new AppError(
        409,
        'change_order_target_not_active',
        'The engagement this quote says it replaces is not active work on a line this quote covers. Pick the engagement it actually replaces, or send it as a plain quote.'
      );
    }
    return { engagementId: target.id, serviceLine: target.serviceLine, periodKey: target.periodKey };
  }

  if (candidates.length === 0) return null;
  const named = candidates
    .map((c) => `${c.title ?? c.serviceLine} (${c.serviceLine}, ${c.periodKey}, ${c.id})`)
    .join('; ');
  throw Object.assign(
    new AppError(
      409,
      'change_order_required',
      `This client already has active work on this line for this period: ${named}. ` +
        'A second agreement for the same work is a change order — send it as one, naming the engagement it replaces.'
    ),
    { issues: candidates }
  );
}

/**
 * Step one of a change-order acceptance, BEFORE the new engagement is created: withdraw the
 * old one so the unique index lets the new row in. Same transaction as the rest of acceptance.
 */
export async function withdrawForChangeOrder(
  app: FastifyInstance,
  oldEngagementId: string,
  quoteId: string
): Promise<ChangeOrderTarget> {
  // Decision 1 (2026-09-09): the superseded engagement's payable invoices retire with it —
  // the change order issues its own. Same transaction as the acceptance.
  const { retirePayableInvoices } = await import('./retire-invoices.ts');
  await retirePayableInvoices(app, oldEngagementId, `superseded by change order ${quoteId}`, { id: null, label: 'change order acceptance' });
  const { rows } = await app.db.query<{ id: string; service_line: string; period_key: string | null }>(
    `UPDATE engagements
        SET status = 'withdrawn', ended_on = CURRENT_DATE,
            close_reason = 'superseded by change order ' || $2
      WHERE id = $1 AND status IN ('active', 'on_hold')
      RETURNING id, service_line::text AS service_line, period_key`,
    [oldEngagementId, quoteId]
  );
  const old = rows[0];
  if (!old) {
    throw new AppError(
      409,
      'change_order_target_not_active',
      'The engagement this change order replaces is no longer active. Nothing was changed.'
    );
  }
  // The return under it would otherwise dangle in the preparer queue (migration 0061's rule).
  await app.db.query(
    `UPDATE tax_engagements SET stage = 'withdrawn' WHERE engagement_id = $1 AND stage <> 'withdrawn'`,
    [oldEngagementId]
  );
  return { engagementId: old.id, serviceLine: old.service_line, periodKey: old.period_key ?? '' };
}

/**
 * Step two, AFTER the new engagement exists: point the old at its successor, carry any paid
 * and unapplied deposit credit across (the credit derives from invoices.engagement_id, so the
 * deposit invoice moves), and write the one audit row.
 */
export async function finishSupersession(
  app: FastifyInstance,
  oldEngagementId: string,
  newEngagementId: string,
  quoteId: string,
  contactId: string
): Promise<{ carriedDepositInvoices: string[] }> {
  await app.db.query(`UPDATE engagements SET superseded_by_engagement_id = $2 WHERE id = $1`, [oldEngagementId, newEngagementId]);
  const carried = await app.db.query<{ invoice_number: string }>(
    `UPDATE invoices SET engagement_id = $2
      WHERE engagement_id = $1
        AND status IN ('paid', 'partially_refunded')
        AND deposit_credit_from_invoice_id IS NULL
        AND (amount_paid_cents - amount_refunded_cents) > deposit_applied_cents
      RETURNING invoice_number`,
    [oldEngagementId, newEngagementId]
  );
  const carriedDepositInvoices = carried.rows.map((r) => r.invoice_number);
  await writeAudit(app.db, {
    actorType: 'system',
    actorLabel: 'change order',
    action: 'engagement.superseded',
    objectType: 'engagement',
    objectId: oldEngagementId,
    contactId,
    details: {
      old_engagement_id: oldEngagementId,
      new_engagement_id: newEngagementId,
      quote_id: quoteId,
      carried_deposit_invoices: carriedDepositInvoices,
    },
  });
  return { carriedDepositInvoices };
}
