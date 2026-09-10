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
import { enqueueEffect } from '../../outbox.ts';
import { withTransaction } from '../../db.ts';
import { AppError, type AuthedStaff } from '../../types.ts';
import { firstActiveByRole, notifyOnce, ownerForRole } from '../../staffing.ts';
import { createTask } from '../tasks/service.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { createEngagement } from '../engagements/service.ts';
import { createInvoice } from '../billing/service.ts';
import { addDays, todayChicago } from '../tax/deadlines.ts';
import { periodKeyFor } from '../engagements/period.ts';
import {
  assertChangeOrderIfActive, finishSupersession, quoteTaxYear, withdrawForChangeOrder,
} from '../engagements/change-order.ts';
import { composeBundle } from './bundles.ts';
import {
  assertEveryLineCreatesWork,
  engagementLinesForQuote,
  engagementTitle,
} from './engagement-lines.ts';
import { setLeadStage } from './pipeline.ts';
import {
  assertSendableOverCoverage,
  schedulesImpliedByQuote,
  type DuplicateIntent,
} from './quote-coverage.ts';

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
    /** The interview answers that derived these lines — kept so the price stays explainable. */
    interviewAnswers?: Record<string, string | number | boolean> | undefined;
    /** 'base_only' narrows the band to the base return; derived schedules are exact. */
    rangeBasis?: 'total' | 'base_only' | undefined;
    /** The base portion of the subtotal. Required when rangeBasis is 'base_only'. */
    baseCents?: number | undefined;
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
    if (input.rangeBasis === 'base_only') {
      // Only the BASE widens. A client who told us they have three rentals sees
      // precision on the schedules and a band only where complexity genuinely
      // varies — Brian's ruling on the guided interview. Widening the whole total
      // is what made a derived quote read as vague.
      const baseCents = Math.min(Math.max(input.baseCents ?? 0, 0), totalCents);
      const exactPart = totalCents - baseCents;
      rangeMaxCents = exactPart + Math.round(baseCents * (1 + band / 100));
    } else {
      rangeMaxCents = Math.round(totalCents * (1 + band / 100));
    }
  }

  /*
   * ONE TRANSACTION (#48, same shape as acceptance).
   *
   * A quote is a header plus N line items, written one statement at a time. A failure
   * part-way through the loop left a quote carrying SOME of its lines — and a quote missing
   * lines is not a broken record, it is a quote that UNDER-PRICES THE WORK. Nothing
   * downstream could tell: `subtotal_cents` on the header still says what the full set came
   * to, so the totals and the lines would disagree, and the coverage gate would decide what
   * schedules the quote implies from an incomplete set of items.
   *
   * The audit row is inside for the same reason it is inside everywhere else — a quote with
   * no record of who built it, or a record of a quote that does not exist, are both wrong.
   *
   * Nothing here reaches outward. A quote is not sent until `sendQuote`, which is where the
   * email lives.
   */
  return withTransaction(app.db, async () => {
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO quotes
         (contact_id, business_id, language, bundle_slug, price_book_version_id,
          subtotal_cents, discount_cents, total_cents, range_min_cents, range_max_cents,
          deposit_item_code, expires_at, created_by_staff_id, notes,
          interview_answers, range_basis)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16)
       RETURNING id`,
      [
        input.contactId, input.businessId ?? null, input.language ?? 'en', input.bundleSlug ?? null, version.id,
        subtotalCents, discountCents, totalCents, rangeMinCents, rangeMaxCents,
        input.depositItemCode ?? null,
        input.expiresInDays ? `${addDays(todayChicago(), input.expiresInDays)}T23:59:59Z` : null,
        actor.id, input.notes ?? null,
        input.interviewAnswers ? JSON.stringify(input.interviewAnswers) : null,
        input.asRange ? (input.rangeBasis ?? 'total') : null,
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
      actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
      action: 'quote.created', objectType: 'quote', objectId: quoteId,
      contactId: input.contactId,
      details: { bundle: input.bundleSlug ?? null, total_cents: totalCents, lines: lines.length },
    });
    return { id: quoteId, totalCents, rangeMinCents, rangeMaxCents };
  });
}

/** Send the quote: mints the client link, pins the version, moves the pipeline. */
export async function sendQuote(
  app: FastifyInstance,
  quoteId: string,
  actor: AuthedStaff,
  opts: { duplicateIntent?: DuplicateIntent | undefined; changeOrderOf?: string | undefined } = {}
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

  /*
   * FINDING #17, the other half. If this quote's schedules are ALREADY accepted by
   * this client, stop here and make the sender say what they mean. Blocking at send
   * rather than at accept is deliberate: at send there is a staff member on the screen
   * who knows whether this is extra scope or a mistake, and the client has not yet
   * been asked to decide anything.
   */
  // GATE 1 IS LIFTED (#19 fixed, 2026-08-15): acceptance derives the service line from
  // the book, so a non-tax quote no longer produces a tax engagement. Its successor
  // still runs first — "this cannot be quoted at all" outranks "is this a duplicate?".
  await assertEveryLineCreatesWork(app, quoteId);

  /*
   * ONE ACTIVE ENGAGEMENT PER LINE AND PERIOD (2026-09-09, Brian's ruling). A plain quote for
   * a line the client already has active work on cannot be sent; it must be a change order
   * naming the engagement it replaces. The refusal carries the candidates.
   */
  const changeOrder = await assertChangeOrderIfActive(app, quoteId, quote.contact_id, opts.changeOrderOf);
  const coverage = await assertSendableOverCoverage(
    app,
    quoteId,
    quote.contact_id,
    // A change order replaces the agreement it names; the schedule gate is told so.
    opts.duplicateIntent ?? (changeOrder ? 'replaces_existing' : undefined)
  );

  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  await app.db.query(
    `UPDATE quotes
     SET status = 'sent', sent_at = now(), public_token_hash = $2,
         duplicate_intent = $3::quote_duplicate_intent,
         duplicate_intent_schedules = $4::text[],
         change_order_of_engagement_id = $5
     WHERE id = $1`,
    [
      quoteId,
      hash,
      coverage.intent,
      coverage.overlapping.length > 0 ? coverage.overlapping : null,
      changeOrder?.engagementId ?? null,
    ]
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
        actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
        action: 'quote.send_failed', objectType: 'quote', objectId: quoteId,
        contactId: quote.contact_id,
        details: { reason: (err as Error).message, rolled_back_to: 'draft' },
      });
      throw err;
    }
  }

  await setLeadStage(app, quote.contact_id, 'quoted', actor, 'quote sent');
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
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
    deposit_item_code: string | null; deposit_override_cents: number | null;
  }>(
    `SELECT q.id, q.status::text, q.language, q.contact_id, q.subtotal_cents, q.discount_cents, q.total_cents,
            q.range_min_cents, q.range_max_cents, q.expires_at, q.bundle_slug, q.notes,
            q.deposit_item_code, q.deposit_override_cents,
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
  // The deposit the client will actually be asked for. Resolved rather than read
  // raw so a waiver reads as "waived", not as a silently missing line.
  const deposit = await resolveDeposit(app, quote.deposit_item_code, quote.deposit_override_cents, quote.id);
  // Decision 2 (2026-09-09): the client reads which tax year the proposal is for. The year
  // comes from the interview when it says; otherwise the prior calendar year (defaultTaxYear).
  const { periodsForQuote } = await import('../engagements/change-order.ts');
  return {
    quote: { ...quote, expired },
    lines: lines.rows,
    periods: await periodsForQuote(app, quote.id),
    deposit: {
      standardCents: deposit.standardCents,
      dueCents: deposit.chargeCents,
      treatment: deposit.treatment,
      // The client is told the deposit was adjusted; the internal REASON is
      // never shipped to them.
      waived: deposit.treatment === 'waived',
      reduced: deposit.treatment === 'reduced',
    },
  };
}

export interface ResolvedDeposit {
  /** The price-book deposit, or null when the quote carries no deposit item. */
  standardCents: number | null;
  /** What to actually charge: null = no deposit at all, 0 = waived. */
  chargeCents: number | null;
  isOverridden: boolean;
  treatment: 'standard' | 'reduced' | 'waived' | null;
  label: string;
}

/**
 * Work out the deposit for a quote. The STANDARD figure is always read from the
 * price book; an override replaces the amount and nothing else.
 *
 * Treatment is derived by comparing the two, not asserted by the caller — so an
 * "override" that happens to equal the standard deposit is honestly recorded as
 * standard rather than flagged as an exception for A/R to chase.
 */
/**
 * The v4 standard deposit: the SUM of the quote's lines' own deposits.
 *
 * Deliberately does NOT multiply by quantity, unlike every price on the same lines.
 * Brian's ruling 2026-08-14: "one line = one work-start commitment regardless of units."
 * Three extra states on one return is still one piece of work starting, so reusing the
 * line-total path here would be wrong in a way that shows up as an inflated invoice.
 *
 * The version is pinned to the QUOTE's locked version, not today's book, so a quote
 * written under v4 keeps quoting v4 deposits after v5 ships.
 */
async function summedLineDeposits(app: FastifyInstance, quoteId: string): Promise<number | null> {
  const { rows } = await app.db.query<{ total: string | null; n: number }>(
    `SELECT SUM(pbi.deposit_cents)::text AS total, count(pbi.deposit_cents)::int AS n
       FROM quote_line_items qli
       JOIN quotes q ON q.id = qli.quote_id
       JOIN price_book_items pbi
         ON pbi.item_code = qli.item_code
        AND pbi.version_id = q.price_book_version_id
      WHERE qli.quote_id = $1
        AND pbi.deposit_cents IS NOT NULL`,
    [quoteId]
  );
  const row = rows[0];
  // No line asks for a deposit → this quote has none, which is different from zero.
  if (!row || row.n === 0 || row.total === null) return null;
  return Number(row.total);
}

export async function resolveDeposit(
  app: FastifyInstance,
  depositItemCode: string | null,
  overrideCents: number | null,
  // v4: when given, the summed line deposits are the standard and the legacy
  // deposit_item_code is ignored. Absent only for quotes written before v4.
  quoteId?: string
): Promise<ResolvedDeposit> {
  const summed = quoteId ? await summedLineDeposits(app, quoteId) : null;

  if (summed === null && !depositItemCode) {
    // No deposit at all. An override cannot invent one — that would be a price with
    // no book entry behind it.
    return { standardCents: null, chargeCents: null, isOverridden: false, treatment: null, label: 'Deposit' };
  }

  let standardCents: number;
  let label: string;

  if (summed !== null) {
    standardCents = summed;
    label = 'Deposit';
  } else {
    /*
     * LEGACY READ ONLY. Before v4 a deposit was its own sellable price-book item and a
     * quote picked exactly one. Two accepted quotes still reference DEPOSIT_1040 and are
     * price-locked against it, so this path exists to keep telling those clients the
     * truth about what they were quoted. Nothing writes deposit_item_code any more.
     */
    const version = await currentVersion(app);
    const { rows } = await app.db.query<{ name_en: string; amount_cents: number | null }>(
      `SELECT name_en, amount_cents FROM price_book_items
       WHERE version_id = $1 AND item_code = $2`,
      [version.id, depositItemCode]
    );
    const item = rows[0];
    if (!item || item.amount_cents === null) {
      throw new AppError(
        400,
        'deposit_not_priced',
        `${depositItemCode} is not a priced deposit item in the price book in force.`
      );
    }
    standardCents = item.amount_cents;
    label = item.name_en;
  }
  if (overrideCents === null) {
    return {
      standardCents,
      chargeCents: standardCents,
      isOverridden: false,
      treatment: 'standard',
      label,
    };
  }
  const treatment = overrideCents === 0 ? 'waived' : overrideCents < standardCents ? 'reduced' : 'standard';
  return {
    standardCents,
    chargeCents: overrideCents,
    // An override equal to (or above) standard is not an exception to track.
    isOverridden: overrideCents !== standardCents,
    treatment,
    label: overrideCents === 0 ? `${label} — waived` : `${label} (adjusted)`,
  };
}

/**
 * Set (or clear) the deposit override on a quote. Guarded by the explicit-only
 * `deposits.override` permission at the route.
 *
 * Refused once the quote is accepted: the deposit invoice already exists by then,
 * and silently changing the figure behind an issued invoice would put the books
 * and the client's copy out of step. Adjust the invoice instead.
 */
export async function overrideQuoteDeposit(
  app: FastifyInstance,
  quoteId: string,
  input: { amountCents: number | null; reason: string },
  actor: AuthedStaff
): Promise<ResolvedDeposit & { quoteId: string }> {
  const { rows } = await app.db.query<{ status: string; deposit_item_code: string | null; contact_id: string }>(
    `SELECT status::text, deposit_item_code, contact_id FROM quotes WHERE id = $1`,
    [quoteId]
  );
  const quote = rows[0];
  if (!quote) throw new AppError(404, 'not_found', 'Quote not found.');
  if (!['draft', 'sent'].includes(quote.status)) {
    throw new AppError(
      409,
      'quote_closed',
      `This quote is '${quote.status}'. A deposit can only be adjusted before the quote is accepted — ` +
        `after that the deposit invoice exists and must be adjusted directly.`
    );
  }
  /*
   * "Does this quote have a deposit?" — asked properly.
   *
   * This used to test `deposit_item_code IS NULL`, which WAS the same question until v4
   * moved the deposit onto the service lines. After that, a normal quote has a real
   * deposit and no item code, so the guard refused every override with "add the deposit
   * item first" — an instruction referring to a thing that no longer exists.
   *
   * The rule it protects is still right and still enforced: an override adjusts an
   * amount, it never creates one out of nothing.
   */
  const summed = await summedLineDeposits(app, quoteId);
  if (summed === null && !quote.deposit_item_code) {
    throw new AppError(
      400,
      'no_deposit_on_quote',
      'This quote has no deposit — none of its lines ask for one. An override adjusts a deposit, it does not create one.'
    );
  }
  if (input.amountCents !== null && input.amountCents < 0) {
    throw new AppError(400, 'invalid_amount', 'A deposit cannot be negative.');
  }

  if (input.amountCents === null) {
    // Back to the price-book deposit. The CHECK requires all four columns to
    // clear together.
    await app.db.query(
      `UPDATE quotes
       SET deposit_override_cents = NULL, deposit_override_reason = NULL,
           deposit_override_by_staff_id = NULL, deposit_override_at = NULL
       WHERE id = $1`,
      [quoteId]
    );
  } else {
    await app.db.query(
      `UPDATE quotes
       SET deposit_override_cents = $2, deposit_override_reason = $3,
           deposit_override_by_staff_id = $4, deposit_override_at = now()
       WHERE id = $1`,
      [quoteId, input.amountCents, input.reason.trim(), actor.id]
    );
  }

  const resolved = await resolveDeposit(app, quote.deposit_item_code, input.amountCents, quoteId);
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
    action: input.amountCents === null ? 'quote.deposit_override_cleared' : 'quote.deposit_overridden',
    objectType: 'quote', objectId: quoteId,
    contactId: quote.contact_id,
    details: {
      standard_cents: resolved.standardCents,
      override_cents: input.amountCents,
      treatment: resolved.treatment,
      reason: input.amountCents === null ? null : input.reason.trim(),
      approver: actor.email,
    },
  });
  return { ...resolved, quoteId };
}

/**
 * Client accepts. Converts to an engagement with NO re-entry, and issues the
 * deposit invoice when the quote carries a deposit item.
 */
/**
 * A rolled-back acceptance, recorded OUTSIDE the transaction that discarded itself.
 *
 * Brian's rule from part one, applied at the transaction boundary: silent failure is how a
 * client ends up with nothing and nobody knowing. Here the client has nothing — which is the
 * correct database outcome — but they DID just try to buy something, the quote is open again,
 * and that is a hot lead with a broken checkout. It is worth more attention than a successful
 * acceptance, not less.
 *
 * Every write in here is best-effort and swallowed: this runs while an error is already on its
 * way to the caller, and a failure to record the failure must not replace the failure.
 */
async function recordFailedAcceptance(
  app: FastifyInstance,
  quote: { id: string; contact_id: string; first_name: string; last_name: string },
  err: unknown
): Promise<void> {
  const reason = err instanceof Error ? err.message : String(err);
  app.log.error(
    { err, quoteId: quote.id, contactId: quote.contact_id },
    '#48 ACCEPTANCE ROLLED BACK: the client tried to accept and nothing was written'
  );
  try {
    await writeAudit(app.db, {
      actorType: 'client',
      actorId: quote.contact_id,
      actorLabel: `${quote.first_name} ${quote.last_name}`,
      action: 'quote.acceptance_failed',
      objectType: 'quote',
      objectId: quote.id,
      contactId: quote.contact_id,
      details: { reason, rolled_back: true },
    });
    /*
     * `already_accepted` is deliberately NOT paged. It is the losing half of a double-tap —
     * the acceptance went through, the client is fine, and raising a P1 for it would train
     * whoever holds the queue to ignore this task type.
     */
    const isRace = err instanceof AppError && err.code === 'already_accepted';
    if (isRace) return;

    const owner = await ownerForRole(app.db, 'comms_billing');
    await createTask(app, {
      title: `ACCEPTANCE FAILED: ${quote.first_name} ${quote.last_name} tried to accept their quote and could not`,
      description:
        `Their acceptance was rolled back, so nothing was created — no engagement, no invoice, no charge (${reason}). ` +
        'The quote is open again and they can still accept it. Call them, or accept it on their behalf once the ' +
        'cause is fixed. Nothing else in the system will chase this.',
      assignedStaffId: owner,
      contactId: quote.contact_id,
      priority: 1,
      source: 'automation',
      sourceType: 'acceptance_failed',
      sourceId: quote.id,
    });
    if (owner) {
      await notifyOnce(app.db, {
        staffId: owner,
        type: 'acceptance_failed',
        severity: 'critical',
        title: `Quote acceptance FAILED: ${quote.first_name} ${quote.last_name}`,
        contactId: quote.contact_id,
        relatedObjectType: 'quote',
        relatedObjectId: quote.id,
      });
    }
  } catch (recordErr) {
    app.log.error({ err: recordErr, quoteId: quote.id }, '#48 could not record the failed acceptance');
  }
}

/**
 * The DURABLE half of acceptance — everything that must land together or not at all (#48
 * part two).
 *
 * Lifted out of `acceptQuote` for one reason: it runs inside `withTransaction`, and a named
 * function keeps the transaction boundary a single readable line at the call site instead of
 * a hundred-and-fifty-line closure. Nothing in here sends anything outward — that was
 * checked call-by-call through the whole graph (createEngagement, captureEngagementScope,
 * createInvoice with send:false, createTask, notifyOnce, writeAudit, refreshContactStatus,
 * setLeadStage) and it is the property that lets this be transactional at all.
 *
 * Every `app.db.query` below joins the caller's transaction automatically — see db.ts for
 * why that is ambient rather than threaded through 792 signatures.
 */
async function convertAcceptedQuote(
  app: FastifyInstance,
  quote: { id: string; contact_id: string; first_name: string; last_name: string },
  opts: { chooseOptional?: string[] | undefined }
): Promise<{
  engagementId: string;
  engagements: Array<{ id: string; serviceLine: string; title: string }>;
  depositInvoiceId: string | null;
  totalCents: number;
}> {
  /*
   * #48 — CLAIM THE QUOTE BEFORE DOING ANY WORK.
   *
   * The checks above are a READ followed by a decision, and until this statement existed
   * the write that made the decision true sat TEN STEPS LOWER — after every engagement,
   * every scope row and the deposit invoice. Two acceptances overlapping in that window
   * both passed the guard and both built a full set: two engagement sets, two deposit
   * invoices, two emails, nothing anywhere detecting it. A double-tap on a phone, a
   * retried request, or a refresh on a slow page was enough.
   *
   * That is not hypothetical. It is the mechanism behind #41 — Brian's client carrying two
   * indistinguishable tax engagements plus a third already marked "duplicate accept".
   *
   * One conditional UPDATE fixes it, because a single statement is atomic: exactly one
   * caller can move the row out of 'sent'. Everything below this line now runs knowing it
   * is the only one running it.
   *
   * The guards above are kept even though this makes them redundant — they produce a
   * better message for the ordinary sequential case ("already accepted" vs "expired" vs
   * "declined"), and this claim is the correctness, not the explanation.
   */
  const claimed = await app.db.query(
    `UPDATE quotes SET status = 'accepted', accepted_at = now()
      WHERE id = $1 AND status = 'sent'`,
    [quote.id]
  );
  if ((claimed.rowCount ?? 0) === 0) {
    throw new AppError(
      409,
      'already_accepted',
      'This quote was already accepted. Nothing further is needed — the acceptance that went through is the one that counts.'
    );
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
  const q = await app.db.query<{
    discount_cents: number; contact_id: string; business_id: string | null;
    deposit_item_code: string | null; bundle_slug: string | null;
    deposit_override_cents: number | null; deposit_override_reason: string | null;
    deposit_override_by_staff_id: string | null;
    price_book_version_id: string;
    change_order_of_engagement_id: string | null;
  }>(
    // `price_book_version_id` is read here rather than on the client-facing quote object:
    // #47 pins it onto the engagement's scope, and the portal has no business knowing it.
    `SELECT discount_cents, contact_id, business_id, deposit_item_code, bundle_slug,
            deposit_override_cents, deposit_override_reason, deposit_override_by_staff_id,
            price_book_version_id, change_order_of_engagement_id
     FROM quotes WHERE id = $1`,
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
  /*
   * FINDING #19 — one engagement per SERVICE LINE the quote actually contains.
   *
   * This used to create exactly one engagement, hardcoded `serviceLine: 'tax'` and
   * titled "Accepted quote". So a bookkeeping quote produced a tax engagement (which is
   * why GATE 1 refused to send one at all), and a client with two engagements read
   * "2 active engagements (tax, tax)" with nothing distinguishing them.
   *
   * Brian's ruling 2026-08-15: one per distinct line, matching how schedules already
   * work — a packet attaches Schedule A AND Schedule C, so the agreements behind them
   * are two different agreements.
   */
  const quotedLines = await engagementLinesForQuote(app, quote.id);
  if (quotedLines.length === 0) {
    // Every chosen line was a deposit, a pass-through or a scope ladder. Accepting that
    // would produce an engagement for nothing — the #17 rule inverted: consequence
    // without work is as wrong as work without consequence.
    throw new AppError(
      400,
      'no_engageable_lines',
      'This quote contains no service lines that create an engagement (only deposits, ' +
        'pass-through software or scope ladders). Add the work being agreed to.'
    );
  }

  const { captureEngagementScope, warnIfScopeless } = await import('../engagements/scope.ts');
  /*
   * CHANGE ORDER, step one (2026-09-09): withdraw the engagement this quote replaces BEFORE the
   * new one is created, in this same transaction, so the one-active-per-line-period index
   * lets the new row in. If anything below fails, the withdrawal rolls back with the rest.
   */
  const changeOrder = row.change_order_of_engagement_id
    ? await withdrawForChangeOrder(app, row.change_order_of_engagement_id, quote.id)
    : null;
  const taxYear = await quoteTaxYear(app, quote.id);
  const todayIso = todayChicago();
  const engagements: Array<{ id: string; serviceLine: string; title: string }> = [];
  for (const line of quotedLines) {
    const periodKey = periodKeyFor(line.serviceLine, { taxYear, todayIso });
    const title = engagementTitle(line, periodKey);
    const created = await createEngagement(
      app,
      system,
      {
        contactId: row.contact_id,
        ...(row.business_id ? { businessId: row.business_id } : {}),
        serviceLine: line.serviceLine,
        title,
        status: 'active',
        // The period puts this row under the unique index; a second plain acceptance for
        // the same line and period is refused by the database and rolls this whole
        // acceptance back (engagement_exists).
        periodKey,
      },
      {}
    );
    /*
     * #47 — WHAT THIS ENGAGEMENT COVERS, snapshotted here and never again.
     *
     * Immediately after the engagement exists and before anything else in acceptance can
     * fail. The split from quote into engagements happens right here in code and used to
     * leave no trace, which is why #41's two rows were indistinguishable: they were the
     * same thing twice and nothing recorded what either one was.
     *
     * The lines are copied by VALUE. A quote edited next week must not change what this
     * client agreed to today.
     */
    const captured = await captureEngagementScope(
      app, created.id, quote.id, row.price_book_version_id, line.scope
    );
    warnIfScopeless(app.log, created.id, captured);

    /*
     * (3b) — AN ANNUAL-REPORT SERVICE LINE ACTIVATING ENROLS THE ENTITY (Brian, 2026-08-17).
     *
     * Here, immediately after the scope snapshot, because the scope items ARE the trigger: an
     * `entity` engagement might be a BOI report or a DBA, and only `ENTITY_ANNUAL_REPORT` means
     * we have been engaged to file one. Reading the service line instead would enrol clients who
     * asked for something else entirely.
     *
     * Inside the acceptance transaction, so an enrolment cannot survive an acceptance that rolls
     * back — a compliance row for an engagement that was never created is exactly the orphan
     * #48 existed to prevent.
     */
    const { enrolFromEngagement } = await import('../entity/enrolment.ts');
    const enrolment = await enrolFromEngagement(app, created.id, 'annual_report_engaged');
    if (enrolment?.enrolled) {
      app.log.info(
        { engagementId: created.id, complianceId: enrolment.complianceId, dueDate: enrolment.dueDate },
        'annual-report scope accepted — entity enrolled in annual-report tracking'
      );
    }

    engagements.push({ id: created.id, serviceLine: line.serviceLine, title });
    // Change order, step two: the successor is named, unapplied deposit credit follows it,
    // one audit row.
    if (changeOrder && changeOrder.serviceLine === line.serviceLine) {
      await finishSupersession(app, changeOrder.engagementId, created.id, quote.id, row.contact_id);
    }
  }
  /*
   * The deposit invoice, the quote's converted_engagement_id and the lead-stage move all
   * need ONE engagement to hang from. The first is the quote's primary line — price-book
   * sort_order, so it is the same one a reader would call the main service rather than
   * whichever row the database returned first.
   */
  const engagement = engagements[0]!;

  // ── DEPOSIT (standard, reduced, or waived) ──────────────────────────────────
  // The standard figure always comes from the price book. An override replaces
  // the AMOUNT only, and is stamped onto the engagement so A/R can later ask
  // whether non-standard deposits collect worse.
  const deposit = await resolveDeposit(app, row.deposit_item_code, row.deposit_override_cents, quote.id);

  let depositInvoiceId: string | null = null;
  if (deposit.chargeCents !== null && deposit.chargeCents > 0) {
    const invoice = await createInvoice(
      app,
      { type: 'system', label: 'quote acceptance' },
      {
        contactId: row.contact_id,
        engagementId: engagement.id,
        /*
         * ONE LINE, always a resolved amount — never an item code.
         *
         * This used to invoice the deposit ITEM (`{ code: deposit_item_code }`) for a
         * standard deposit and fall back to a custom line only for an override. v4
         * removes the item: a deposit is the SUM of the quote's lines' deposit_cents,
         * so there is no single code that represents it, and the two deposit items are
         * retired anyway (bookings are free — Brian, 2026-08-14).
         *
         * The amount is still price-book-derived — resolveDeposit summed it out of
         * deposit_cents on the pinned version — so no price is invented here. Collapsing
         * to one path also removes the branch where an override and a standard deposit
         * were billed by different mechanisms.
         */
        lines: [{ description: deposit.label, unitCents: deposit.chargeCents }],
        // THIS is the deposit (finding #26) — it must not try to credit itself, and the
        // invoice that follows it is the one that carries the credit.
        isDepositInvoice: true,
        /*
         * #48 — CREATED AS A DRAFT; DELIVERY IS AN INTENT, NOT A CALL.
         *
         * The invoice ROW has to exist here: the quote points at it two statements down.
         * The EMAIL does not, and sending it here meant every failure below this line left a
         * client holding an invoice for an acceptance that never completed — a message no
         * rollback can recall.
         */
        send: false,
      }
    );
    depositInvoiceId = invoice.id;
    /*
     * The intent to email it is written HERE, inside the same transaction as the acceptance.
     * If the acceptance rolls back, so does the instruction to tell the client about it —
     * which is the property the inline post-commit version could not have.
     */
    await enqueueEffect(app, {
      effect: 'invoice.send',
      payload: { invoiceId: invoice.id },
      contactId: row.contact_id,
      objectType: 'invoice',
      objectId: invoice.id,
    });
  }

  if (deposit.treatment) {
    await app.db.query(
      `UPDATE engagements
       SET deposit_treatment = $2::deposit_treatment,
           deposit_standard_cents = $3,
           deposit_charged_cents = $4,
           deposit_override_reason = $5,
           deposit_override_by_staff_id = $6
       WHERE id = $1`,
      [
        engagement.id, deposit.treatment, deposit.standardCents, deposit.chargeCents ?? 0,
        row.deposit_override_reason, row.deposit_override_by_staff_id,
      ]
    );
  }

  /*
   * The status and timestamp moved UP to the claim (#48); what is left here is the result
   * of the work, which could not be known before it was done.
   */
  await app.db.query(
    `UPDATE quotes
     SET total_cents = $2, converted_engagement_id = $3, deposit_invoice_id = $4
     WHERE id = $1`,
    [quote.id, totalCents, engagement.id, depositInvoiceId]
  );

  // #42: acceptance is what turns a lead into someone being onboarded. Recomputed rather
  // than assigned, so a returning dormant client walks the same ladder.
  const { refreshContactStatus } = await import('../crm/lifecycle.ts');
  await refreshContactStatus(app, quote.contact_id, 'quote_accepted');
  await setLeadStage(app, row.contact_id, depositInvoiceId ? 'deposit_paid' : 'onboarding', null, 'quote accepted');

  /*
   * FINDING #17 — acceptance must ALWAYS produce visible consequence.
   *
   * This block used to sit entirely inside `if (rene)`. `comms_billing` is a role
   * nobody holds yet, so on a real acceptance the engagement row was created and the
   * task and the alert were both skipped: Brian accepted a quote and, from every
   * screen he could see, nothing happened. Silent acceptance into the void.
   *
   * The task is now UNCONDITIONAL. Only its assignee is conditional, and
   * ownerForRole() falls back to Brian before it gives up. An unassigned task in the
   * queue is visible; a skipped task is not.
   */
  const owner = await ownerForRole(app.db, 'comms_billing');
  const scheduleCodes = await schedulesImpliedByQuote(app, quote.id);
  const scheduleNote =
    scheduleCodes.length > 0
      ? ` Schedule${scheduleCodes.length > 1 ? 's' : ''} ${scheduleCodes.join(', ')} ${
          scheduleCodes.length > 1 ? 'are' : 'is'
        } what this quote covers.`
      : '';

  await createTask(app, {
    title: `Start onboarding: ${quote.first_name} ${quote.last_name} (quote accepted)`,
    description:
      'The quote converted to an engagement. Send the engagement letter + §7216 and open ' +
      `the portal checklist.${scheduleNote}`,
    assignedStaffId: owner,
    contactId: row.contact_id,
    priority: 1,
    source: 'automation',
    sourceType: 'quote_accepted',
    sourceId: quote.id,
  });

  // Alerts need an actual person to alert; the task above is the durable record.
  if (owner) {
    await notifyOnce(app.db, {
      staffId: owner,
      type: 'quote_accepted',
      severity: 'info',
      title: `Quote ACCEPTED: ${quote.first_name} ${quote.last_name} — $${(totalCents / 100).toFixed(2)}`,
      contactId: row.contact_id,
      relatedObjectType: 'quote',
      relatedObjectId: quote.id,
    });
  }
  await writeAudit(app.db, {
    actorType: 'client', actorId: row.contact_id, actorLabel: `${quote.first_name} ${quote.last_name}`,
    action: 'quote.accepted', objectType: 'quote', objectId: quote.id,
    contactId: row.contact_id,
    details: {
      total_cents: totalCents,
      // EVERY engagement, not just the primary — a two-line quote creating two
      // agreements must not be recorded as if it created one.
      engagement_id: engagement.id,
      engagements: engagements.map((e) => ({ id: e.id, service_line: e.serviceLine, title: e.title })),
      deposit_invoice_id: depositInvoiceId,
    },
  });

  return {
    engagementId: engagement.id,
    engagements: engagements.map((e) => ({ id: e.id, serviceLine: e.serviceLine, title: e.title })),
    depositInvoiceId,
    totalCents,
  };
}

export async function acceptQuote(
  app: FastifyInstance,
  token: string,
  opts: { chooseOptional?: string[] | undefined } = {}
): Promise<{
  /** The primary engagement — the quote's first line by price-book sort order. */
  engagementId: string;
  /** Every engagement created, one per distinct service line on the quote (#19). */
  engagements: Array<{ id: string; serviceLine: string; title: string }>;
  depositInvoiceId: string | null;
  totalCents: number;
}> {
  const { quote } = await quoteByToken(app, token);
  if (quote.status === 'accepted') throw new AppError(409, 'already_accepted', 'This quote was already accepted.');
  if (quote.status !== 'sent') throw new AppError(409, 'not_open', `This quote is '${quote.status}'.`);
  if (quote.expired) {
    await expireQuote(app, quote.id, 'expired before acceptance');
    throw new AppError(409, 'expired', 'This quote has expired. We will send you a fresh one.');
  }

  /*
   * ── #48 part two: ONE TRANSACTION ─────────────────────────────────────────
   *
   * Part one moved the claim to the top so two acceptances could not both proceed. It did
   * not help the other half of the problem: eighteen writes in sequence, any of which
   * could fail and leave the client with some of an acceptance — engagements but no
   * invoice, an invoice but no onboarding task, a charge and nobody at Soto knowing to
   * start. Silent, and the worst of them looks exactly like nothing happening.
   *
   * THE CLAIM IS INSIDE THE TRANSACTION, and that composes better than either fix alone:
   *
   *   · Two concurrent acceptances no longer race — the second BLOCKS on the row lock the
   *     first holds, and when the first commits it re-checks `status = 'sent'`, finds it
   *     gone and is refused. Serialised rather than merely detected.
   *   · A failed acceptance UN-CLAIMS the quote. The rollback puts it back to `sent`, so
   *     the client can try again — and the retry cannot collide with the wreckage of the
   *     failed attempt, because there is none.
   */
  let converted: Awaited<ReturnType<typeof convertAcceptedQuote>>;
  try {
    converted = await withTransaction(app.db, () => convertAcceptedQuote(app, quote, opts));
  } catch (err) {
    /*
     * A ROLLED-BACK ACCEPTANCE IS STILL AN EVENT.
     *
     * Everything the transaction wrote is gone, including any audit row it managed to
     * write — which is correct, there was no acceptance to record. But a client just tried
     * to buy something and could not, and that must not evaporate with the transaction.
     * This runs OUTSIDE it, so it survives.
     */
    await recordFailedAcceptance(app, quote, err);
    throw err;
  }
  const { engagements, depositInvoiceId, totalCents } = converted;
  const engagement = { id: converted.engagementId };

  /*
   * The deposit invoice is DELIVERED BY THE OUTBOX (#48).
   *
   * Part one sent it here, after the commit, with a try/catch that raised a P1 task on
   * failure. That was right about where the send belongs and wrong about durability: an
   * effect that only exists in code after the commit is lost if the process dies between
   * the two, and the client is never told about an acceptance that definitely happened.
   *
   * The intent is now a row written INSIDE the transaction above — see
   * `convertAcceptedQuote` — so it commits with the acceptance or vanishes with it. The drain
   * performs it within a tick, retries with backoff, and after five attempts raises the same
   * P1 task the inline version did. The loud failure did not go away; it moved somewhere it
   * cannot be skipped.
   */
  // engagementId stays the primary, so existing callers and the portal are unchanged;
  // engagements carries the full set for anything that needs to show them all.
  return {
    engagementId: engagement.id,
    engagements: engagements.map((e) => ({ id: e.id, serviceLine: e.serviceLine, title: e.title })),
    depositInvoiceId,
    totalCents,
  };
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

  // A decline is a consequence too: the task is unconditional, the assignee is not.
  await createTask(app, {
    title: `Quote declined: ${quote.first_name} ${quote.last_name} — "${reason.slice(0, 80)}"`,
    description: 'Declined quotes return to the leads pipeline. Decide whether to re-quote, adjust scope, or close the lead.',
    assignedStaffId: await ownerForRole(app.db, 'ceo'),
    contactId: quote.contact_id,
    source: 'automation',
    sourceType: 'quote_declined',
    sourceId: quote.id,
  });
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
