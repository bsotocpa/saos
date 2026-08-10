// Billing service (M13): invoices from price-book items or staff-entered
// amounts (runtime data, never code literals), the Filed → invoice automation
// (12), payment completion, and the unpaid-14-day automation (17).

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { isAutomationEnabled } from '../../automations.ts';
import { AppError } from '../../types.ts';
import { firstActiveByRole, notifyOnce } from '../../staffing.ts';
import { closeTasksForSource, createTask } from '../tasks/service.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { currentPriceBookVersion } from '../pricing/service.ts';

export interface InvoiceLineInput {
  /** Price-book item (unit price from the book) — or omit and provide custom values. */
  code?: string | undefined;
  description?: string | undefined;
  qty?: number | undefined;
  unitCents?: number | undefined;
}

function formatUsd(cents: number): string {
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
  }
): Promise<{ id: string; invoiceNumber: string; totalCents: number }> {
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
        portal_link: app.config.PORTAL_BASE_URL,
      },
    });
  }

  await writeAudit(app.db, {
    actorType: actor.type, actorId: actor.id ?? null, actorLabel: actor.label ?? null,
    action: 'invoice.created', objectType: 'invoice', objectId: id, contactId: input.contactId,
    details: { invoice_number: invoiceNumber, total_cents: total, sent: send },
  });
  return { id, invoiceNumber, totalCents: total };
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

  const rene = await firstActiveByRole(app.db, 'comms_billing');

  if (te.final_fee_cents === null) {
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
      await createTask(app, {
        title: `Set final fee + invoice: ${te.first_name} ${te.last_name} (${te.tax_year} ${te.return_type.toUpperCase()})`,
        assignedStaffId: rene,
        contactId: te.contact_id,
        priority: 1,
        source: 'automation',
        sourceType: 'invoice_needed',
        sourceId: te.id,
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
  const invoice = await createInvoice(app, { type: 'system', label: 'filed automation' }, {
    contactId: te.contact_id,
    engagementId: te.engagement_id,
    taxEngagementId: te.id,
    lines,
    send: true,
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
): Promise<{ alreadyPaid: boolean }> {
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

  await app.db.query(
    `UPDATE invoices
     SET status = 'paid', amount_paid_cents = total_cents, paid_at = now(),
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
  if (inv.email) {
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

  const rene = await firstActiveByRole(app.db, 'comms_billing');
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
          portal_link: app.config.PORTAL_BASE_URL,
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
