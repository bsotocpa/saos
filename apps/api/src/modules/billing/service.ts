// Billing service (M13): invoices from price-book items or staff-entered
// amounts (runtime data, never code literals), the Filed → invoice automation
// (12), payment completion, and the unpaid-14-day automation (17).

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { isAutomationEnabled } from '../../automations.ts';
import { AppError } from '../../types.ts';
import {
  DEPOSIT_CREDIT_LABEL_EN,
  DEPOSIT_CREDIT_LABEL_ES,
  assertDepositCreditApplied,
  availableDepositCredit,
  consumeDepositCredit,
} from './deposit-credit.ts';
import { notifyOnce, ownerForRole } from '../../staffing.ts';
import { closeTasksForSource, createTask } from '../tasks/service.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { payLinkFor } from './pay-link.ts';
import { currentPriceBookVersion } from '../pricing/service.ts';

export interface InvoiceLineInput {
  /** Price-book item (unit price from the book) — or omit and provide custom values. */
  code?: string | undefined;
  description?: string | undefined;
  qty?: number | undefined;
  unitCents?: number | undefined;
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function nextInvoiceNumber(app: FastifyInstance): Promise<string> {
  const { rows } = await app.db.query<{ n: string }>(`SELECT nextval('invoice_number_seq') AS n`);
  const year = new Date().getFullYear();
  return `SA-${year}-${String(rows[0]!.n).padStart(4, '0')}`;
}

export async function createInvoice(
  app: FastifyInstance,
  actor: { type: 'staff' | 'system'; id?: string | null; label?: string | null },
  input: {
    contactId: string;
    engagementId?: string | undefined;
    taxEngagementId?: string | undefined;
    lines: InvoiceLineInput[];
    dueDate?: string | undefined;
    send?: boolean | undefined; // send immediately (default true)
    /*
     * THE deposit invoice itself (finding #26). Set only by quote acceptance.
     *
     * Explicit rather than inferred: a deposit invoice must not try to credit itself,
     * and working that out from the shape of the lines would be a guess that breaks the
     * first time a deposit is worded differently.
     */
    isDepositInvoice?: boolean | undefined;
  }
): Promise<{ id: string; invoiceNumber: string; totalCents: number; depositCreditCents: number }> {
  if (input.lines.length === 0) throw new AppError(400, 'empty_invoice', 'Provide at least one line.');

  const contact = await app.db.query<{ first_name: string; email: string | null; language: 'en' | 'es' }>(
    `SELECT first_name, email, language FROM contacts WHERE id = $1`,
    [input.contactId]
  );
  const c = contact.rows[0];
  if (!c) throw new AppError(404, 'not_found', 'Contact not found.');

  const version = await currentPriceBookVersion(app.db);
  const codes = input.lines.filter((l) => l.code).map((l) => l.code!);
  const items = codes.length
    ? await app.db.query<{
        item_code: string; name_en: string; name_es: string;
        amount_cents: number | null; is_pass_through: boolean; display_on_quote: boolean;
      }>(
        `SELECT item_code, name_en, name_es, amount_cents, is_pass_through, display_on_quote
         FROM price_book_items WHERE version_id = $1 AND item_code = ANY($2) AND is_active`,
        [version.id, codes]
      )
    : { rows: [] };
  const byCode = new Map(items.rows.map((i) => [i.item_code, i]));

  const resolved = input.lines.map((line, idx) => {
    const qty = line.qty ?? 1;
    if (qty <= 0) throw new AppError(400, 'invalid_quantity', 'Line quantities must be positive.');
    if (line.code) {
      const item = byCode.get(line.code);
      if (!item) throw new AppError(400, 'unknown_price_items', `Unknown price book item: ${line.code}.`);
      if (item.is_pass_through) {
        throw new AppError(400, 'pass_through_not_invoiceable', `${line.code} is a software pass-through — billed by the vendor, not Soto.`);
      }
      // PRESENTATION RULING (Brian, 2026-08-09): an invoice shows the bundled
      // plan, never a broken-out session component. Refused at the builder so it
      // cannot happen through any caller.
      if (item.display_on_quote === false) {
        throw new AppError(
          400,
          'not_invoiceable',
          `${line.code} is a derivation component, not a billable line. Invoice the bundled plan price instead.`
        );
      }
      if (item.amount_cents === null) {
        throw new AppError(400, 'requires_custom_amount', `${line.code} is range-priced — provide unitCents explicitly.`);
      }
      return {
        code: line.code,
        description: line.description ?? (c.language === 'es' ? item.name_es : item.name_en),
        qty,
        unitCents: item.amount_cents,
        totalCents: Math.round(item.amount_cents * qty),
        sort: idx,
      };
    }
    if (line.unitCents === undefined || !line.description) {
      throw new AppError(400, 'invalid_line', 'Custom lines need description and unitCents.');
    }
    return {
      code: null,
      description: line.description,
      qty,
      unitCents: line.unitCents,
      totalCents: Math.round(line.unitCents * qty),
      sort: idx,
    };
  });

  /*
   * FINDING #26 — the deposit is credited HERE, where no caller can forget it.
   *
   * Master §2 promises the reconciliation and nothing performed it, so the filed-to-
   * invoice automation billed the full fee over a paid deposit. Applying it inside
   * createInvoice rather than at each call site means every future invoice path gets it
   * for free; the guard below then catches anything that builds lines another way.
   *
   * Capped at the invoice subtotal: a deposit larger than the work leaves its remainder
   * available for the next invoice rather than producing a negative total. Master §2
   * says overpayments are credited to the account, not refunded on the spot.
   */
  let depositCreditCents = 0;
  let depositCreditFromInvoiceId: string | null = null;
  const subtotal = resolved.reduce((sum, l) => sum + l.totalCents, 0);

  if (input.engagementId && !input.isDepositInvoice && subtotal > 0) {
    const available = await availableDepositCredit(app, input.engagementId);
    let remaining = subtotal;
    for (const dep of available) {
      if (remaining <= 0) break;
      const want = Math.min(remaining, dep.availableCents);
      const applied = await consumeDepositCredit(app, dep.depositInvoiceId, want);
      if (applied <= 0) continue;
      depositCreditCents += applied;
      remaining -= applied;
      depositCreditFromInvoiceId ??= dep.depositInvoiceId;
    }
    if (depositCreditCents > 0) {
      resolved.push({
        code: null,
        description: c.language === 'es' ? DEPOSIT_CREDIT_LABEL_ES : DEPOSIT_CREDIT_LABEL_EN,
        qty: 1,
        unitCents: -depositCreditCents,
        totalCents: -depositCreditCents,
        sort: resolved.length,
      });
    }
  }

  // "No silent full-price bills" — if a paid deposit is still outstanding and these lines
  // do not carry it, stop rather than invoice over money the client already paid.
  await assertDepositCreditApplied(
    app,
    input.isDepositInvoice ? undefined : input.engagementId,
    resolved.map((l) => l.description)
  );

  const total = resolved.reduce((sum, l) => sum + l.totalCents, 0);
  const invoiceNumber = await nextInvoiceNumber(app);
  const send = input.send ?? true;

  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO invoices
       (invoice_number, contact_id, engagement_id, tax_engagement_id, status, subtotal_cents,
        total_cents, due_date, sent_at, price_book_version_id, created_by_staff_id)
     VALUES ($1,$2,$3,$4,$5::invoice_status,$6,$7,$8,CASE WHEN $5 = 'sent' THEN now() END,$9,$10)
     RETURNING id`,
    [
      invoiceNumber, input.contactId, input.engagementId ?? null, input.taxEngagementId ?? null,
      send ? 'sent' : 'draft', total, total, input.dueDate ?? null, version.id,
      actor.type === 'staff' ? actor.id : null,
    ]
  );
  const id = rows[0]!.id;
  // Record WHICH deposit was consumed, so the reconciliation is auditable without
  // parsing line descriptions.
  if (depositCreditFromInvoiceId) {
    await app.db.query(`UPDATE invoices SET deposit_credit_from_invoice_id = $2 WHERE id = $1`, [
      id,
      depositCreditFromInvoiceId,
    ]);
  }
  for (const line of resolved) {
    await app.db.query(
      `INSERT INTO invoice_line_items (invoice_id, item_code, description, qty, unit_cents, total_cents, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, line.code, line.description, line.qty, line.unitCents, line.totalCents, line.sort]
    );
  }

  if (input.taxEngagementId) {
    await app.db.query(
      `UPDATE tax_engagements
       SET invoice_number = $2, invoice_amount_cents = $3,
           payment_status = 'invoiced', invoice_sent_at = CASE WHEN $4 THEN now() ELSE invoice_sent_at END
       WHERE id = $1`,
      [input.taxEngagementId, invoiceNumber, total, send]
    );
  }

  if (send && c.email) {
    // Portal notice (automation 12): pay in the portal, never by reply.
    await sendTemplatedEmail(app, {
      to: c.email,
      templateKey: 'invoice_sent',
      language: c.language,
      contactId: input.contactId,
      vars: {
        first_name: c.first_name,
        invoice_number: invoiceNumber,
        amount: formatUsd(total),
        // The tokenized pay link (2026-09-09): one invoice, no login, Stripe is the auth.
        // Deep — "your invoice is ready" lands ON the invoice, never on a dashboard.
        portal_link: await payLinkFor(app, id),
      },
    });
  }

  await writeAudit(app.db, {
    actorType: actor.type, actorId: actor.id ?? null, actorLabel: actor.label ?? null,
    action: 'invoice.created', objectType: 'invoice', objectId: id, contactId: input.contactId,
    details: { invoice_number: invoiceNumber, total_cents: total, sent: send },
  });
  return { id, invoiceNumber, totalCents: total, depositCreditCents };
}

/**
 * #48 — send an invoice that was created as a draft, AFTER its caller's durable writes.
 *
 * The split exists because an email cannot be rolled back. Quote acceptance creates the
 * deposit invoice mid-sequence — the ROW is durable state and has to exist before the quote
 * can point at it — but the SEND is an outward effect, and sending it there meant a later
 * failure left a client holding an invoice for an acceptance that may not have finished.
 *
 * `sent_at` and `status` move only when the message actually goes. An invoice marked sent
 * with nothing sent is a lie that A/R reads as "the client has been told", and the dunning
 * clock starts from it.
 */
export async function sendInvoiceNow(
  app: FastifyInstance,
  invoiceId: string,
  actor: { type: 'staff' | 'system'; id?: string | null; label?: string | null }
): Promise<{ sent: boolean; reason?: string }> {
  const { rows } = await app.db.query<{
    invoice_number: string; total_cents: number; status: string;
    contact_id: string; first_name: string; email: string | null; language: 'en' | 'es';
  }>(
    `SELECT i.invoice_number, i.total_cents, i.status::text AS status, i.contact_id,
            c.first_name, c.email, c.language
       FROM invoices i JOIN contacts c ON c.id = i.contact_id
      WHERE i.id = $1`,
    [invoiceId]
  );
  const inv = rows[0];
  if (!inv) throw new AppError(404, 'not_found', 'Invoice not found.');
  if (inv.status !== 'draft') return { sent: false, reason: 'already_sent' };
  if (!inv.email) return { sent: false, reason: 'no_email' };

  await sendTemplatedEmail(app, {
    to: inv.email,
    templateKey: 'invoice_sent',
    language: inv.language,
    contactId: inv.contact_id,
    vars: {
      first_name: inv.first_name,
      invoice_number: inv.invoice_number,
      amount: formatUsd(inv.total_cents),
      portal_link: await payLinkFor(app, invoiceId),
    },
  });

  await app.db.query(
    `UPDATE invoices SET status = 'sent', sent_at = now() WHERE id = $1 AND status = 'draft'`,
    [invoiceId]
  );
  await writeAudit(app.db, {
    actorType: actor.type, actorId: actor.id ?? null, actorLabel: actor.label ?? null,
    action: 'invoice.sent', objectType: 'invoice', objectId: invoiceId, contactId: inv.contact_id,
    details: { invoice_number: inv.invoice_number, post_commit: true },
  });
  return { sent: true };
}

/**
 * Automation 12 — called by the pipeline when a return reaches 'filed':
 * final fee present → invoice generated + portal notice + Rene's queue.
 * No final fee → exception to Rene instead (nothing silently skipped).
 */
export async function invoiceForFiledEngagement(
  app: FastifyInstance,
  actor: { staffId: string | null; label: string },
  taxEngagementId: string
): Promise<{ invoiced: boolean }> {
  const { rows } = await app.db.query<{
    id: string; engagement_id: string; contact_id: string; tax_year: number; return_type: string;
    final_fee_cents: number | null; discount_cents: number; invoice_number: string | null;
    first_name: string; last_name: string; language: 'en' | 'es';
  }>(
    `SELECT te.id, te.engagement_id, e.contact_id, te.tax_year, te.return_type,
            te.final_fee_cents, te.discount_cents, te.invoice_number,
            c.first_name, c.last_name, c.language
     FROM tax_engagements te
     JOIN engagements e ON e.id = te.engagement_id
     JOIN contacts c ON c.id = e.contact_id
     WHERE te.id = $1`,
    [taxEngagementId]
  );
  const te = rows[0];
  if (!te) throw new AppError(404, 'not_found', 'Tax engagement not found.');
  if (te.invoice_number) return { invoiced: false }; // already invoiced — idempotent

  const rene = await ownerForRole(app.db, 'comms_billing');

  if (te.final_fee_cents === null) {
    /*
     * THE TASK IS UNCONDITIONAL; only the ALERT is gated (Brian's rule, 2026-08-17).
     *
     * Both used to sit inside `if (rene)`, so an unfilled role meant the work was
     * never recorded at all. An unassigned task in the queue is visible; a skipped one
     * never existed. A notification still needs a real person — that gate stays.
     */
    await createTask(app, {
      title: `Set final fee + invoice: ${te.first_name} ${te.last_name} (${te.tax_year} ${te.return_type.toUpperCase()})`,
      assignedStaffId: rene,
      contactId: te.contact_id,
      priority: 1,
      source: 'automation',
      sourceType: 'invoice_needed',
      sourceId: te.id,
    });
    if (rene) {
      await notifyOnce(app.db, {
        staffId: rene,
        type: 'invoice_needed',
        severity: 'warning',
        title: `Filed without a final fee: ${te.first_name} ${te.last_name} (${te.tax_year} ${te.return_type.toUpperCase()}) — set fee + invoice`,
        contactId: te.contact_id,
        relatedObjectType: 'tax_engagement',
        relatedObjectId: te.id,
      });
    }
    return { invoiced: false };
  }

  const labelEn = `${te.tax_year} ${te.return_type.toUpperCase()} tax return preparation`;
  const labelEs = `Preparación de la declaración ${te.return_type.toUpperCase()} ${te.tax_year}`;
  const lines: InvoiceLineInput[] = [
    { description: te.language === 'es' ? labelEs : labelEn, unitCents: te.final_fee_cents, qty: 1 },
  ];
  if (te.discount_cents > 0) {
    lines.push({
      description: te.language === 'es' ? 'Descuento' : 'Discount',
      unitCents: -te.discount_cents,
      qty: 1,
    });
  }
  /*
   * DRAFT NOW, DELIVERED BY THE OUTBOX (#48).
   *
   * `send: true` mailed the client from inside `transitionStage`, which is a multi-write
   * sequence: the stage change, the stage-history row, the audit row, the perfection-clock
   * clear and the reject-task close all happen around it. An email in the middle of that
   * cannot be rolled back, so the moment `transitionStage` became transactional-capable this
   * had to move out.
   *
   * The invoice ROW is durable state and stays exactly where it was. Only the delivery moved,
   * and it is now an intent that commits with the filing rather than a call that happens to
   * be in the right place.
   */
  const invoice = await createInvoice(app, { type: 'system', label: 'filed automation' }, {
    contactId: te.contact_id,
    engagementId: te.engagement_id,
    taxEngagementId: te.id,
    lines,
    send: false,
  });
  const { enqueueEffect } = await import('../../outbox.ts');
  await enqueueEffect(app, {
    effect: 'invoice.send',
    payload: { invoiceId: invoice.id },
    contactId: te.contact_id,
    objectType: 'invoice',
    objectId: invoice.id,
  });

  if (rene) {
    await notifyOnce(app.db, {
      staffId: rene,
      type: 'invoice_generated',
      severity: 'info',
      title: `Invoice ${invoice.invoiceNumber} generated (${formatUsd(invoice.totalCents)}): ${te.first_name} ${te.last_name}`,
      contactId: te.contact_id,
      relatedObjectType: 'invoice',
      relatedObjectId: invoice.id,
    });
  }
  return { invoiced: true };
}

/** Payment completion (webhook): idempotent; receipt + engagement rollup + audit. */
export async function markInvoicePaid(
  app: FastifyInstance,
  invoiceId: string,
  refs: { checkoutSessionId?: string | undefined; paymentIntentId?: string | undefined }
): Promise<{ alreadyPaid: boolean; refused?: 'void' | 'refunded' | 'partially_refunded' | 'disputed' }> {
  const { rows } = await app.db.query<{
    id: string; status: string; total_cents: number; invoice_number: string;
    contact_id: string; tax_engagement_id: string | null;
    first_name: string; email: string | null; language: 'en' | 'es';
  }>(
    `SELECT i.id, i.status, i.total_cents, i.invoice_number, i.contact_id, i.tax_engagement_id,
            c.first_name, c.email, c.language
     FROM invoices i JOIN contacts c ON c.id = i.contact_id
     WHERE i.id = $1`,
    [invoiceId]
  );
  const inv = rows[0];
  if (!inv) throw new AppError(404, 'not_found', 'Invoice not found.');
  if (inv.status === 'paid') return { alreadyPaid: true };
  if (inv.status === 'refunded' || inv.status === 'partially_refunded' || inv.status === 'disputed') {
    // 2026-09-09. Money already went back (or is contested). "Paid" from a session or a
    // replayed event is not a new payment; a new payment carries a new payment intent and
    // arrives as its own event. Recorded, refused, left alone.
    await writeAudit(app.db, {
      actorType: 'system',
      actorLabel: 'payment guard',
      action: 'invoice.payment_ignored',
      objectType: 'invoice',
      objectId: invoiceId,
      contactId: inv.contact_id,
      details: { status: inv.status, payment_intent: refs.paymentIntentId ?? null, session: refs.checkoutSessionId ?? null },
    });
    return { alreadyPaid: false, refused: inv.status as 'refunded' | 'partially_refunded' | 'disputed' };
  }
  if (inv.status === 'void') {
    // 2026-09-09. The client paid a link to an invoice that had been voided (the session
    // expiry after void is best effort). Void is terminal; the money needs a person.
    const { paymentOnVoidInvoice } = await import('./refunds.ts');
    await paymentOnVoidInvoice(app, { id: inv.id, invoiceNumber: inv.invoice_number, contactId: inv.contact_id, amountCents: inv.total_cents, ...refs });
    return { alreadyPaid: false, refused: 'void' };
  }

  await app.db.query(
    `UPDATE invoices
     SET status = 'paid', amount_paid_cents = total_cents, paid_at = now(),
         pay_token_revoked_at = now(),
         stripe_payment_intent_id = COALESCE($2, stripe_payment_intent_id),
         stripe_checkout_session_id = COALESCE($3, stripe_checkout_session_id)
     WHERE id = $1`,
    [invoiceId, refs.paymentIntentId ?? null, refs.checkoutSessionId ?? null]
  );
  if (inv.tax_engagement_id) {
    await app.db.query(
      `UPDATE tax_engagements SET payment_status = 'paid', payment_received_at = now() WHERE id = $1`,
      [inv.tax_engagement_id]
    );
  }
  // Item 9 (2026-09-09): the receipt is a client-acting automation — it fires from the
  // webhook, not from a person. Gated; a hold is recorded where the send would have been.
  if (inv.email && !(await isAutomationEnabled(app, 'payment_receipt'))) {
    await writeAudit(app.db, {
      actorType: 'system', actorLabel: 'payment receipt',
      action: 'invoice.payment_receipt_suppressed', objectType: 'invoice', objectId: invoiceId, contactId: inv.contact_id,
      details: { invoice_number: inv.invoice_number, amount_cents: inv.total_cents, automation: 'payment_receipt' },
    });
  } else if (inv.email) {
    await sendTemplatedEmail(app, {
      to: inv.email,
      templateKey: 'payment_received',
      language: inv.language,
      contactId: inv.contact_id,
      vars: {
        first_name: inv.first_name,
        invoice_number: inv.invoice_number,
        amount: formatUsd(inv.total_cents),
      },
    });
    // The send log for this invoice (notices.ts): the receipt is delivered, and when.
    await writeAudit(app.db, {
      actorType: 'system',
      actorLabel: 'payment receipt',
      action: 'invoice.payment_receipt_sent',
      objectType: 'invoice',
      objectId: invoiceId,
      contactId: inv.contact_id,
      details: { invoice_number: inv.invoice_number, amount_cents: inv.total_cents },
    });
  }
  // M25: payment closes the collection work items automatically.
  await closeTasksForSource(app, 'invoice_overdue', invoiceId, 'invoice paid');
  // v4.3 flow 4: payment ends the dunning ladder and LIFTS any work pause.
  await closeTasksForSource(app, 'dunning_call', invoiceId, 'invoice paid');
  const { resumeAfterPayment } = await import('./dunning.ts');
  await resumeAfterPayment(app, invoiceId);
  await writeAudit(app.db, {
    actorType: 'system',
    action: 'invoice.paid',
    objectType: 'invoice',
    objectId: invoiceId,
    contactId: inv.contact_id,
    details: { invoice_number: inv.invoice_number, amount_cents: inv.total_cents },
  });
  return { alreadyPaid: false };
}

/** Automation 17 (daily, date-guarded): unpaid N days → reminder + Rene flag + overdue. */
export async function runInvoiceOverdueJob(
  app: FastifyInstance,
  today: string
): Promise<{ skipped: boolean; overdue: number; suppressed?: number }> {
  const ACTION = 'job.invoice_overdue';
  const already = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = $1 AND details->>'run_date' = $2 LIMIT 1`,
    [ACTION, today]
  );
  if (already.rows.length > 0) return { skipped: true, overdue: 0 };

  const setting = await app.db.query<{ value: number }>(
    `SELECT (value)::text::int AS value FROM app_settings WHERE key = 'sla.invoice_unpaid_reminder_days'`
  );
  const days = setting.rows[0]?.value ?? 14;

  const { rows } = await app.db.query<{
    id: string; invoice_number: string; total_cents: number; contact_id: string;
    tax_engagement_id: string | null; first_name: string; last_name: string;
    email: string | null; language: 'en' | 'es';
  }>(
    `SELECT i.id, i.invoice_number, i.total_cents, i.contact_id, i.tax_engagement_id,
            c.first_name, c.last_name, c.email, c.language
     FROM invoices i JOIN contacts c ON c.id = i.contact_id
     WHERE i.status = 'sent' AND i.sent_at < ($1::date - make_interval(days => $2))`,
    [today, days]
  );

  const rene = await ownerForRole(app.db, 'comms_billing');
  // Kill switch covers the CLIENT reminder only — invoices still flip to
  // overdue (A/R truth) and Rene still gets the flag + chase task.
  const dunningArmed = await isAutomationEnabled(app, 'ar_dunning');
  let overdue = 0;
  let suppressed = 0;
  for (const inv of rows) {
    await app.db.query(
      `UPDATE invoices SET status = 'overdue', overdue_since = COALESCE(overdue_since, $2::date) WHERE id = $1`,
      [inv.id, today]
    );
    if (inv.tax_engagement_id) {
      await app.db.query(`UPDATE tax_engagements SET payment_status = 'overdue' WHERE id = $1`, [inv.tax_engagement_id]);
    }
    if (inv.email && !dunningArmed) suppressed++;
    if (inv.email && dunningArmed) {
      await sendTemplatedEmail(app, {
        to: inv.email,
        templateKey: 'invoice_reminder',
        language: inv.language,
        contactId: inv.contact_id,
        vars: {
          first_name: inv.first_name,
          invoice_number: inv.invoice_number,
          amount: formatUsd(inv.total_cents),
          // The SAME pay link the invoice email carried (reused while live), so the client
          // never holds two links. A reminder that points at a dashboard is the defect
          // Brian's audit found; a reminder that points at a dead link would be worse.
          portal_link: await payLinkFor(app, inv.id),
        },
      });
    }
    if (rene) {
      await notifyOnce(app.db, {
        staffId: rene,
        type: 'invoice_overdue',
        severity: 'warning',
        title: `Invoice ${inv.invoice_number} unpaid ${days}+ days: ${inv.first_name} ${inv.last_name}`,
        contactId: inv.contact_id,
        relatedObjectType: 'invoice',
        relatedObjectId: inv.id,
      });
      // M25: the collection follow-up is a WORK ITEM (v4.3 flow 4's dunning
      // ladder builds on this task in M26). Closed by payment.
      await createTask(app, {
        title: `Chase overdue invoice ${inv.invoice_number} — ${inv.first_name} ${inv.last_name}`,
        assignedStaffId: rene,
        contactId: inv.contact_id,
        priority: 1,
        source: 'automation',
        sourceType: 'invoice_overdue',
        sourceId: inv.id,
      });
    }
    overdue++;
  }

  await writeAudit(app.db, {
    actorType: 'system',
    action: ACTION,
    details: { run_date: today, overdue, suppressed, automation_disabled: !dunningArmed },
  });
  return { skipped: false, overdue, suppressed };
}
