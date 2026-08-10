// Quote builder (M27, v4.4). Quotes compose from the price book — or from a
// bundle, which is itself only price-book references — and PIN the version at
// send time. Accepting converts to an engagement + deposit checkout with no
// re-entry: the accepted lines are the locked prices.
//
// Two rules the spec is explicit about:
//   · one-time work is quoted as a RANGE, never a single exact number
//     (recurring prices stay exact)
//   · a declined or expired quote returns to the leads pipeline WITH A REASON

import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError, type AuthedStaff } from '../../types.ts';
import { firstActiveByRole, notifyOnce } from '../../staffing.ts';
import { createTask } from '../tasks/service.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { createEngagement } from '../engagements/service.ts';
import { createInvoice } from '../billing/service.ts';
import { addDays, todayChicago } from '../tax/deadlines.ts';
import { composeBundle } from './bundles.ts';
import { setLeadStage } from './pipeline.ts';

/** Range width for one-time work — a SETTING, never a literal (⚠ Brian tunes). */
async function estimateBandPercent(app: FastifyInstance): Promise<number> {
  const { rows } = await app.db.query<{ value: number }>(
    `SELECT (value)::text::int AS value FROM app_settings WHERE key = 'pricing.estimate_band_percent'`
  );
  return rows[0]?.value ?? 15;
}

export interface QuoteLineInput {
  itemCode: string;
  quantity?: number | undefined;
  isOptional?: boolean | undefined;
  chosen?: boolean | undefined;
}

async function currentVersion(app: FastifyInstance): Promise<{ id: string }> {
  const { rows } = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions
     WHERE effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
     ORDER BY version_number DESC LIMIT 1`
  );
  if (!rows[0]) throw new AppError(500, 'price_book_missing', 'No price book version in force.');
  return rows[0];
}

/**
 * Build a quote from explicit line items or from a bundle slug. Nothing is
 * sent yet — a draft quote is safe to rebuild as often as the UI likes.
 */
export async function createQuote(
  app: FastifyInstance,
  input: {
    contactId: string;
    businessId?: string | null | undefined;
    language?: 'en' | 'es' | undefined;
    lines?: QuoteLineInput[] | undefined;
    bundleSlug?: string | undefined;
    includeOptional?: string[] | undefined;
    depositItemCode?: string | null | undefined;
    /** Recurring work quotes exact; one-time work quotes as a range. */
    asRange?: boolean | undefined;
    expiresInDays?: number | undefined;
    notes?: string | null | undefined;
  },
  actor: AuthedStaff
): Promise<{ id: string; totalCents: number; rangeMinCents: number | null; rangeMaxCents: number | null }> {
  const version = await currentVersion(app);
  const contact = await app.db.query(`SELECT 1 FROM contacts WHERE id = $1`, [input.contactId]);
  if (contact.rows.length === 0) throw new AppError(404, 'not_found', 'Contact not found.');

  // BOTH descriptions are frozen onto every line. A quote written in English
  // that the client reads in Spanish must not show Spanish chrome around
  // English service names — and the price is identical either way.
  let lines: Array<{
    itemCode: string; descriptionEn: string; descriptionEs: string; quantity: number;
    unitCents: number | null; minCents: number | null; maxCents: number | null;
    isOptional: boolean; chosen: boolean; isPassThrough: boolean;
  }> = [];
  let discountCents = 0;

  if (input.bundleSlug) {
    const composed = await composeBundle(app, input.bundleSlug, {
      includeOptional: input.includeOptional ?? [],
    });
    const chosenSet = new Set(input.includeOptional ?? []);
    lines = composed.lines.map((l) => ({
      itemCode: l.itemCode,
      descriptionEn: l.nameEn,
      descriptionEs: l.nameEs,
      quantity: l.quantity,
      unitCents: l.unitCents,
      minCents: l.minCents,
      maxCents: l.maxCents,
      isOptional: l.isOptional,
      chosen: !l.isOptional || chosenSet.has(l.itemCode),
      isPassThrough: false,
    }));
    discountCents = composed.discount.amountCents;
  } else {
    const requested = input.lines ?? [];
    if (requested.length === 0) throw new AppError(400, 'empty_quote', 'Provide line items or a bundle.');
    const priced = await app.db.query<{
      item_code: string; name_en: string; name_es: string; amount_cents: number | null;
      price_min_cents: number | null; price_max_cents: number | null; is_pass_through: boolean;
      display_on_quote: boolean;
    }>(
      `SELECT item_code, name_en, name_es, amount_cents, price_min_cents, price_max_cents,
              is_pass_through, display_on_quote
       FROM price_book_items WHERE version_id = $1 AND item_code = ANY($2) AND is_active`,
      [version.id, requested.map((l) => l.itemCode)]
    );
    const byCode = new Map(priced.rows.map((r) => [r.item_code, r]));
    const missing = requested.filter((l) => !byCode.has(l.itemCode)).map((l) => l.itemCode);
    if (missing.length > 0) {
      throw new AppError(400, 'unknown_price_items', `Not in the price book in force: ${missing.join(', ')}.`);
    }
    // PRESENTATION RULING (Brian, 2026-08-09): derivation components never reach
    // a client. A quote itemizing the session component separately is a defect,
    // so the builder refuses the code outright rather than trusting the UI to
    // hide it.
    const components = requested
      .filter((l) => byCode.get(l.itemCode)!.display_on_quote === false)
      .map((l) => l.itemCode);
    if (components.length > 0) {
      throw new AppError(
        400,
        'not_quotable',
        `These are derivation components, not sellable lines: ${components.join(', ')}. ` +
          `A client sees one bundled plan price — configure the engagement and quote that figure instead.`
      );
    }
    lines = requested.map((l) => {
      const item = byCode.get(l.itemCode)!;
      const qty = l.quantity ?? 1;
      return {
        itemCode: l.itemCode,
        descriptionEn: item.name_en,
        descriptionEs: item.name_es,
        quantity: qty,
        unitCents: item.amount_cents,
        minCents: item.price_min_cents,
        maxCents: item.price_max_cents,
        isOptional: l.isOptional ?? false,
        chosen: l.chosen ?? !(l.isOptional ?? false),
        isPassThrough: item.is_pass_through,
      };
    });
  }

  // Pass-throughs (software subscriptions) are shown but never revenue.
  const counted = lines.filter((l) => l.chosen && !l.isPassThrough);
  const subtotalCents = counted.reduce(
    (sum, l) => sum + (l.unitCents === null ? 0 : Math.round(l.unitCents * l.quantity)),
    0
  );
  const totalCents = Math.max(0, subtotalCents - discountCents);

  // RANGE for one-time work: the top widens by the band; the bottom is the
  // composed price. Recurring quotes stay exact (asRange false).
  let rangeMinCents: number | null = null;
  let rangeMaxCents: number | null = null;
  if (input.asRange) {
    const band = await estimateBandPercent(app);
    rangeMinCents = totalCents;
    rangeMaxCents = Math.round(totalCents * (1 + band / 100));
  }

  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO quotes
       (contact_id, business_id, language, bundle_slug, price_book_version_id,
        subtotal_cents, discount_cents, total_cents, range_min_cents, range_max_cents,
        deposit_item_code, expires_at, created_by_staff_id, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id`,
    [
      input.contactId, input.businessId ?? null, input.language ?? 'en', input.bundleSlug ?? null, version.id,
      subtotalCents, discountCents, totalCents, rangeMinCents, rangeMaxCents,
      input.depositItemCode ?? null,
      input.expiresInDays ? `${addDays(todayChicago(), input.expiresInDays)}T23:59:59Z` : null,
      actor.id, input.notes ?? null,
    ]
  );
  const quoteId = rows[0]!.id;
  for (const [i, l] of lines.entries()) {
    await app.db.query(
      `INSERT INTO quote_line_items
         (quote_id, item_code, description_en, description_es, quantity, unit_cents, line_cents,
          min_cents, max_cents, is_optional, chosen, is_pass_through, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        quoteId, l.itemCode, l.descriptionEn, l.descriptionEs, l.quantity, l.unitCents,
        l.unitCents === null ? null : Math.round(l.unitCents * l.quantity),
        l.minCents, l.maxCents, l.isOptional, l.chosen, l.isPassThrough, i,
      ]
    );
  }
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'quote.created', objectType: 'quote', objectId: quoteId,
    contactId: input.contactId,
    details: { bundle: input.bundleSlug ?? null, total_cents: totalCents, lines: lines.length },
  });
  return { id: quoteId, totalCents, rangeMinCents, rangeMaxCents };
}

/** Send the quote: mints the client link, pins the version, moves the pipeline. */
export async function sendQuote(
  app: FastifyInstance,
  quoteId: string,
  actor: AuthedStaff
): Promise<{ token: string; url: string }> {
  const q = await app.db.query<{
    status: string; contact_id: string; language: 'en' | 'es'; total_cents: number;
    range_min_cents: number | null; range_max_cents: number | null; expires_at: Date | null;
  }>(
    `SELECT status, contact_id, language, total_cents, range_min_cents, range_max_cents, expires_at
     FROM quotes WHERE id = $1`,
    [quoteId]
  );
  const quote = q.rows[0];
  if (!quote) throw new AppError(404, 'not_found', 'Quote not found.');
  if (quote.status !== 'draft') throw new AppError(409, 'already_sent', `Quote is '${quote.status}'.`);

  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  await app.db.query(
    `UPDATE quotes SET status = 'sent', sent_at = now(), public_token_hash = $2 WHERE id = $1`,
    [quoteId, hash]
  );
  const url = `${app.config.PORTAL_BASE_URL}/quote/${token}`;

  const contact = await app.db.query<{ first_name: string; email: string | null }>(
    `SELECT first_name, email FROM contacts WHERE id = $1`,
    [quote.contact_id]
  );
  const c = contact.rows[0];
  if (c?.email) {
    const amount =
      quote.range_min_cents !== null && quote.range_max_cents !== null
        ? `$${(quote.range_min_cents / 100).toFixed(2)}–$${(quote.range_max_cents / 100).toFixed(2)}`
        : `$${(quote.total_cents / 100).toFixed(2)}`;
    try {
      await sendTemplatedEmail(app, {
        to: c.email,
        templateKey: 'quote_ready',
        language: quote.language,
        contactId: quote.contact_id,
        vars: { first_name: c.first_name, amount, quote_link: url },
      });
    } catch (err) {
      // The status flip has to come back. Otherwise the quote sits in 'sent'
      // holding a token hash whose plaintext died with the failed email: the
      // client never got a link, and sendQuote refuses to re-send a non-draft
      // quote. Roll back so staff can fix the cause and send for real.
      await app.db.query(
        `UPDATE quotes SET status = 'draft', sent_at = NULL, public_token_hash = NULL WHERE id = $1`,
        [quoteId]
      );
      await writeAudit(app.db, {
        actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
        action: 'quote.send_failed', objectType: 'quote', objectId: quoteId,
        contactId: quote.contact_id,
        details: { reason: (err as Error).message, rolled_back_to: 'draft' },
      });
      throw err;
    }
  }

  await setLeadStage(app, quote.contact_id, 'quoted', actor, 'quote sent');
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'quote.sent', objectType: 'quote', objectId: quoteId,
    contactId: quote.contact_id,
    details: { emailed: Boolean(c?.email) },
  });
  return { token, url };
}

/** Look a quote up by its client link token (no session — the token IS the key). */
export async function quoteByToken(app: FastifyInstance, token: string) {
  const hash = createHash('sha256').update(token).digest('hex');
  const { rows } = await app.db.query<{
    id: string; status: string; language: 'en' | 'es'; contact_id: string;
    subtotal_cents: number; discount_cents: number; total_cents: number;
    range_min_cents: number | null; range_max_cents: number | null;
    expires_at: Date | null; bundle_slug: string | null; notes: string | null;
    first_name: string; last_name: string;
  }>(
    `SELECT q.id, q.status::text, q.language, q.contact_id, q.subtotal_cents, q.discount_cents, q.total_cents,
            q.range_min_cents, q.range_max_cents, q.expires_at, q.bundle_slug, q.notes,
            c.first_name, c.last_name
     FROM quotes q JOIN contacts c ON c.id = q.contact_id
     WHERE q.public_token_hash = $1`,
    [hash]
  );
  const quote = rows[0];
  if (!quote) throw new AppError(404, 'not_found', 'Quote not found.');
  const lines = await app.db.query(
    `SELECT item_code, description_en, description_es, quantity, unit_cents, line_cents,
            min_cents, max_cents, is_optional, chosen, is_pass_through
     FROM quote_line_items WHERE quote_id = $1 ORDER BY sort_order`,
    [quote.id]
  );
  const expired = quote.expires_at !== null && quote.expires_at.getTime() < Date.now();
  return { quote: { ...quote, expired }, lines: lines.rows };
}

/**
 * Client accepts. Converts to an engagement with NO re-entry, and issues the
 * deposit invoice when the quote carries a deposit item.
 */
export async function acceptQuote(
  app: FastifyInstance,
  token: string,
  opts: { chooseOptional?: string[] | undefined } = {}
): Promise<{ engagementId: string; depositInvoiceId: string | null; totalCents: number }> {
  const { quote } = await quoteByToken(app, token);
  if (quote.status === 'accepted') throw new AppError(409, 'already_accepted', 'This quote was already accepted.');
  if (quote.status !== 'sent') throw new AppError(409, 'not_open', `This quote is '${quote.status}'.`);
  if (quote.expired) {
    await expireQuote(app, quote.id, 'expired before acceptance');
    throw new AppError(409, 'expired', 'This quote has expired. We will send you a fresh one.');
  }

  // Optional add-ons the client ticked at accept time.
  if (opts.chooseOptional && opts.chooseOptional.length > 0) {
    await app.db.query(
      `UPDATE quote_line_items SET chosen = true WHERE quote_id = $1 AND item_code = ANY($2)`,
      [quote.id, opts.chooseOptional]
    );
  }
  const recount = await app.db.query<{ subtotal: number }>(
    `SELECT COALESCE(sum(line_cents), 0)::int AS subtotal
     FROM quote_line_items WHERE quote_id = $1 AND chosen AND NOT is_pass_through`,
    [quote.id]
  );
  const q = await app.db.query<{ discount_cents: number; contact_id: string; business_id: string | null; deposit_item_code: string | null; bundle_slug: string | null }>(
    `SELECT discount_cents, contact_id, business_id, deposit_item_code, bundle_slug FROM quotes WHERE id = $1`,
    [quote.id]
  );
  const row = q.rows[0]!;
  const totalCents = Math.max(0, recount.rows[0]!.subtotal - row.discount_cents);

  // The engagement inherits the quote's numbers — zero re-entry.
  const system: AuthedStaff = {
    id: (await firstActiveByRole(app.db, 'ceo')) ?? '',
    email: 'system@saos',
    fullName: 'SAOS',
    roleKey: 'ceo',
    permissions: ['*'],
    sessionId: 'quote-accept',
  };
  const engagement = await createEngagement(
    app,
    system,
    {
      contactId: row.contact_id,
      ...(row.business_id ? { businessId: row.business_id } : {}),
      serviceLine: 'tax',
      title: row.bundle_slug ? `Accepted quote — ${row.bundle_slug}` : 'Accepted quote',
      status: 'active',
    },
    {}
  );

  let depositInvoiceId: string | null = null;
  if (row.deposit_item_code) {
    const invoice = await createInvoice(
      app,
      { type: 'system', label: 'quote acceptance' },
      { contactId: row.contact_id, engagementId: engagement.id, lines: [{ code: row.deposit_item_code }] }
    );
    depositInvoiceId = invoice.id;
  }

  await app.db.query(
    `UPDATE quotes
     SET status = 'accepted', accepted_at = now(), total_cents = $2,
         converted_engagement_id = $3, deposit_invoice_id = $4
     WHERE id = $1`,
    [quote.id, totalCents, engagement.id, depositInvoiceId]
  );
  await setLeadStage(app, row.contact_id, depositInvoiceId ? 'deposit_paid' : 'onboarding', null, 'quote accepted');

  const rene = await firstActiveByRole(app.db, 'comms_billing');
  if (rene) {
    await notifyOnce(app.db, {
      staffId: rene,
      type: 'quote_accepted',
      severity: 'info',
      title: `Quote ACCEPTED: ${quote.first_name} ${quote.last_name} — $${(totalCents / 100).toFixed(2)}`,
      contactId: row.contact_id,
      relatedObjectType: 'quote',
      relatedObjectId: quote.id,
    });
    await createTask(app, {
      title: `Start onboarding: ${quote.first_name} ${quote.last_name} (quote accepted)`,
      description: 'The quote converted to an engagement. Send the engagement letter + §7216 and open the portal checklist.',
      assignedStaffId: rene,
      contactId: row.contact_id,
      priority: 1,
      source: 'automation',
      sourceType: 'quote_accepted',
      sourceId: quote.id,
    });
  }
  await writeAudit(app.db, {
    actorType: 'client', actorId: row.contact_id, actorLabel: `${quote.first_name} ${quote.last_name}`,
    action: 'quote.accepted', objectType: 'quote', objectId: quote.id,
    contactId: row.contact_id,
    details: { total_cents: totalCents, engagement_id: engagement.id, deposit_invoice_id: depositInvoiceId },
  });
  return { engagementId: engagement.id, depositInvoiceId, totalCents };
}

/** Client declines — the REASON is the point (it feeds conversion analysis). */
export async function declineQuote(
  app: FastifyInstance,
  token: string,
  reason: string
): Promise<void> {
  const { quote } = await quoteByToken(app, token);
  if (quote.status !== 'sent') throw new AppError(409, 'not_open', `This quote is '${quote.status}'.`);
  await app.db.query(
    `UPDATE quotes SET status = 'declined', declined_at = now(), decline_reason = $2 WHERE id = $1`,
    [quote.id, reason]
  );
  // Back to the pipeline as a lost lead, carrying the reason.
  await setLeadStage(app, quote.contact_id, 'lost', null, `quote declined: ${reason}`);
  await app.db.query(`UPDATE contacts SET lost_reason = $2 WHERE id = $1`, [quote.contact_id, reason]);

  const brian = await firstActiveByRole(app.db, 'ceo');
  if (brian) {
    await createTask(app, {
      title: `Quote declined: ${quote.first_name} ${quote.last_name} — "${reason.slice(0, 80)}"`,
      description: 'Declined quotes return to the leads pipeline. Decide whether to re-quote, adjust scope, or close the lead.',
      assignedStaffId: brian,
      contactId: quote.contact_id,
      source: 'automation',
      sourceType: 'quote_declined',
      sourceId: quote.id,
    });
  }
  await writeAudit(app.db, {
    actorType: 'client', actorId: quote.contact_id, actorLabel: `${quote.first_name} ${quote.last_name}`,
    action: 'quote.declined', objectType: 'quote', objectId: quote.id,
    contactId: quote.contact_id, details: { reason },
  });
}

async function expireQuote(app: FastifyInstance, quoteId: string, note: string): Promise<void> {
  const { rows } = await app.db.query<{ contact_id: string }>(
    `UPDATE quotes SET status = 'expired' WHERE id = $1 AND status = 'sent' RETURNING contact_id`,
    [quoteId]
  );
  if (!rows[0]) return;
  await setLeadStage(app, rows[0].contact_id, 'lost', null, note);
  await app.db.query(
    `UPDATE contacts SET lost_reason = COALESCE(lost_reason, 'quote expired') WHERE id = $1`,
    [rows[0].contact_id]
  );
  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'quote-expiry',
    action: 'quote.expired', objectType: 'quote', objectId: quoteId,
    contactId: rows[0].contact_id, details: { note },
  });
}

/** Daily, date-guarded: expire quotes past their date, with a reason recorded. */
export async function runQuoteExpiryJob(
  app: FastifyInstance,
  today: string
): Promise<{ skipped: boolean; expired: number }> {
  const ACTION = 'job.quote_expiry';
  const already = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = $1 AND details->>'run_date' = $2 LIMIT 1`,
    [ACTION, today]
  );
  if (already.rows.length > 0) return { skipped: true, expired: 0 };

  const { rows } = await app.db.query<{ id: string }>(
    `SELECT id FROM quotes WHERE status = 'sent' AND expires_at IS NOT NULL AND expires_at < $1::date`,
    [today]
  );
  for (const q of rows) await expireQuote(app, q.id, 'expired without a response');
  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'daily-jobs',
    action: ACTION, details: { run_date: today, expired: rows.length },
  });
  return { skipped: false, expired: rows.length };
}
