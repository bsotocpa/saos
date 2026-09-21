// Quote builder + leads pipeline routes (M27, v4.4).
//
// Staff routes build and send; the three /public/quote/:token routes are
// UNAUTHENTICATED by design — the emailed token IS the credential, exactly like
// a magic link, and only its SHA-256 is stored. A client should not need an
// account to read a proposal we sent them.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { z } from 'zod';
import { reasonText } from '../../reasons.ts';
import { holds, requireAnyPermission, requirePermission } from '../../plugins/auth.ts';
import {
  acceptQuote, createQuote, declineQuote, overrideQuoteDeposit, clientLinkFor, quoteByToken, sendQuote,
} from './quotes.ts';
import { pipelineBoard, pipelineMetrics, setLeadStage } from './pipeline.ts';
import { CATALOG_GROUPS, CUSTOM_LINE_SERVICE_LINES, SERVICE_LINE_LABEL } from './groups.ts';
import { savePackage } from './packages.ts';

/*
 * A LINE ON THE QUOTE (2026-09-20): a book item by code, or a custom line written by hand. The
 * unit amount is optional on a book line — absent, the book's price stands; present and different,
 * the line is priced off the book and the quote needs its one reason. A custom line has no book
 * price, so its amount is required and it always counts as priced off the book.
 */
const LineInput = z.object({
  itemCode: z.string().min(1).optional(),
  quantity: z.number().positive().optional(),
  isOptional: z.boolean().optional(),
  chosen: z.boolean().optional(),
  unitCents: z.number().int().min(0).optional(),
  custom: z.object({
    name: z.string().trim().min(1, 'Name the line.').max(120),
    serviceLine: z.enum(CUSTOM_LINE_SERVICE_LINES),
  }).optional(),
}).superRefine((l, ctx) => {
  if (!l.itemCode && !l.custom) ctx.addIssue({ code: 'custom', path: ['itemCode'], message: 'A line is a price-book item or a custom line.' });
  if (l.itemCode && l.custom) ctx.addIssue({ code: 'custom', path: ['itemCode'], message: 'A line is a price-book item or a custom line, not both.' });
  if (l.custom && l.unitCents === undefined) ctx.addIssue({ code: 'custom', path: ['unitCents'], message: 'A custom line needs an amount.' });
});

const CreateQuoteBody = z
  .object({
    contactId: z.uuid(),
    businessId: z.uuid().nullable().optional(),
    language: z.enum(['en', 'es']).optional(),
    lines: z.array(LineInput).optional(),
    bundleSlug: z.string().min(1).optional(),
    includeOptional: z.array(z.string()).optional(),
    depositItemCode: z.string().nullable().optional(),
    asRange: z.boolean().optional(),
    expiresInDays: z.number().int().min(1).max(365).optional(),
    notes: z.string().nullable().optional(),
    // One standalone reason for every line priced off the book (2026-09-20). Validated as a staff
    // reason: it is the record the money line reads.
    priceChangeReason: reasonText(10, 1000).optional(),
    // Set by the guided interview so the quote records what the client told us and
    // the band narrows to the base return only.
    interviewAnswers: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    rangeBasis: z.enum(['total', 'base_only']).optional(),
    baseCents: z.number().int().min(0).optional(),
  })
  .refine((b) => Boolean(b.bundleSlug) || (b.lines?.length ?? 0) > 0, {
    message: 'Provide bundleSlug or at least one line item.',
  });

const InterviewBody = z.object({
  answers: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  language: z.enum(['en', 'es']).optional(),
});

export function registerQuoteRoutes(app: FastifyInstance): void {

  /**
   * THE GUIDED TAX INTERVIEW. Questions first, then derive — so the quote's line
   * items come from what the client actually has rather than what a staffer
   * remembered to add. Read-only: it prices nothing until the builder creates a
   * quote from the derived lines, which staff can still edit.
   */
  const interviewGuard = { preHandler: [app.authenticate, requirePermission('engagements.read')] };

  app.get('/quotes/tax-interview', interviewGuard, async (request) => {
    const language = z.object({ language: z.enum(['en', 'es']).optional() })
      .parse(request.query ?? {}).language ?? 'en';
    const { interviewQuestions } = await import('./tax-interview.ts');
    return { questions: await interviewQuestions(app, language) };
  });

  app.post('/quotes/tax-interview/derive', interviewGuard, async (request) => {
    const b = InterviewBody.parse(request.body);
    const { deriveTaxQuote } = await import('./tax-interview.ts');
    return deriveTaxQuote(app, b.answers, b.language ?? 'en');
  });

  const read = { preHandler: [app.authenticate, requirePermission('engagements.read')] };
  /*
   * QUOTES HAVE THEIR OWN DOOR (Brian, 2026-09-20, the Quotes card): quotes.manage, seeded to the
   * preparer beside engagements.tax.manage, which still opens every quote route so nothing that
   * quoted yesterday is refused today. The card shows its controls to a session holding
   * quotes.manage (or the wildcard) and nothing to anyone else.
   */
  const manage = { preHandler: [app.authenticate, requireAnyPermission('quotes.manage', 'engagements.tax.manage')] };

  /**
   * What the builder can put on a quote: the items and bundles in the price
   * book in force. Read-only, and scoped to engagement staff — building a
   * quote should not require the Admin → Pricing permission that can CHANGE
   * prices.
   */
  app.get('/quotes/catalog', read, async () => {
    const version = await app.db.query<{ id: string; version_number: number }>(
      `SELECT id, version_number FROM price_book_versions
       WHERE effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
       ORDER BY version_number DESC LIMIT 1`
    );
    const v = version.rows[0];
    if (!v) return { version: null, items: [], bundles: [] };
    const items = await app.db.query(
      // display_on_quote = false items are derivation components (prep/session
      // splits, the late-fee rate). They are not offered here at all, so the
      // builder never shows a staffer a line a client must not see.
      // deposit_cents is returned so the builder can show the SAME deposit the server will
      // resolve at acceptance (summedLineDeposits). Without it the builder had nothing to show
      // and kept a dropdown from the retired one-deposit-item model, which read "— no deposit —"
      // over a quote that carried a real deposit. Nine weeks nobody built a quote; the first person who
      // did was told there was no deposit while the client would have been asked for one.
      // group_key, sort_order and description_en (2026-09-20): the builder lays the book out as
      // grouped rows, each with its one-line description. The groups' own order is CATALOG_GROUPS.
      `SELECT item_code, service_line::text AS service_line, name_en, name_es, amount_cents,
              price_min_cents, price_max_cents, unit, is_pass_through, needs_confirmation,
              deposit_cents, description_en, group_key, sort_order, pricing_mode::text AS pricing_mode
       FROM price_book_items
       WHERE version_id = $1 AND is_active AND display_on_quote
       ORDER BY group_key, sort_order, item_code`,
      [v.id]
    );
    const bundles = await app.db.query(
      `SELECT b.slug, b.name_en, b.name_es, count(bc.id)::int AS component_count
       FROM bundles b LEFT JOIN bundle_components bc ON bc.bundle_id = b.id
       WHERE b.version_id = $1 AND b.is_active
       GROUP BY b.slug, b.name_en, b.name_es ORDER BY b.name_en`,
      [v.id]
    );
    // Decision 2 (2026-09-09): the builder shows the tax year a return quoted today is for.
    // The rule lives in one place (defaultTaxYear); the builder only reads it.
    const { defaultTaxYear } = await import('../engagements/period.ts');
    const { todayChicago } = await import('../tax/deadlines.ts');
    // The band (a setting) travels with the catalog so the builder's live "quoted range" is the
    // same arithmetic createQuote will do; the groups and the custom-line service lines are the
    // API's, so the screen never carries its own copy of either list.
    const { estimateBandPercent } = await import('./quotes.ts');
    return {
      version: v, items: items.rows, bundles: bundles.rows, defaultTaxYear: defaultTaxYear(todayChicago()),
      groups: CATALOG_GROUPS,
      serviceLines: CUSTOM_LINE_SERVICE_LINES.map((key) => ({ key, label: SERVICE_LINE_LABEL[key] })),
      bandPercent: await estimateBandPercent(app),
    };
  });

  /** Build a draft quote from price-book items or a bundle. Nothing sends yet. */
  app.post('/quotes', manage, async (request, reply) => {
    const b = CreateQuoteBody.parse(request.body);
    const result = await createQuote(app, b, request.staff!);
    reply.code(201);
    return result;
  });

  /**
   * SAVE THESE LINES AS A PACKAGE (2026-09-20). The CEO alone: `pricing.packages.save` is
   * explicit-only, so a wildcard role does not hold it. A package composes from the price book
   * only, so a custom line is refused here; the discount stays unset (admin-set at publish), and
   * the new package is offered in the builder's package list from the next catalog load.
   */
  app.post('/quotes/packages', { preHandler: [app.authenticate, requirePermission('pricing.packages.save')] }, async (request, reply) => {
    const b = z.object({
      name: z.string().trim().min(3, 'Name the package in at least a few words.').max(120),
      lines: z.array(z.object({
        itemCode: z.string().min(1),
        quantity: z.number().positive().optional(),
        isOptional: z.boolean().optional(),
      })).min(1, 'A package needs at least one line.'),
    }).parse(request.body);
    const result = await savePackage(app, b, request.staff!);
    reply.code(201);
    return result;
  });

  /**
   * Adjust or waive the deposit on a quote. Guarded by `deposits.override`,
   * which is EXPLICIT-ONLY: a role holding '*' does not get it, so this is
   * Brian's alone until he grants it to someone else. The reason is required by
   * the schema, not just by this handler.
   */
  app.post<{ Params: { id: string } }>(
    '/quotes/:id/deposit-override',
    { preHandler: [app.authenticate, requirePermission('deposits.override')] },
    async (request) => {
      const id = z.uuid().parse(request.params.id);
      const b = z
        .object({
          // null = revert to the price-book deposit.
          amountCents: z.number().int().min(0).nullable(),
          reason: reasonText(10, 1000),
        })
        .parse(request.body);
      return overrideQuoteDeposit(app, id, b, request.staff!);
    }
  );

  /**
   * Send it: mints the client link, pins the version, moves the lead to 'quoted'.
   *
   * FINDING #17: refuses with 409 `schedule_already_covered` when this quote's
   * schedules are already accepted by the client, unless the sender declares whether
   * this is additional work or replaces what exists. The declared answer is stored on
   * the quote — a warning someone clicked through is not a record.
   */
  app.post<{ Params: { id: string } }>('/quotes/:id/send', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const body = z
      .object({
        duplicateIntent: z.enum(['additional_work', 'replaces_existing']).optional(),
        // The engagement this quote replaces (2026-09-09): required when the client already
        // has active work on the line for the period.
        changeOrderOf: z.uuid().optional(),
        // The Quotes card's Resend (2026-09-20): the same send site, for a sent quote the client did not find.
        resend: z.boolean().optional(),
      })
      .parse(request.body ?? {});
    return sendQuote(app, id, request.staff!, { duplicateIntent: body.duplicateIntent, changeOrderOf: body.changeOrderOf, resend: body.resend });
  });

  /**
   * COPY CLIENT LINK (2026-09-20, the Quotes card). The stored token is read back (0117) and nothing
   * changes; no email leaves. A quote sent before the token was kept rotates once, and `rotated`
   * tells the control to say the emailed link no longer works.
   */
  app.post<{ Params: { id: string } }>('/quotes/:id/client-link', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    return clientLinkFor(app, id, request.staff!);
  });

  /**
   * Staff view of a quote (by id) — the same body the client sees, plus internals.
   *
   * `deposit` is the SERVER's resolution — summed line deposits, then any override — the
   * same call acceptance makes. The builder shows this, not its own memory of what it asked
   * for. 2026-09-09: Brian reduced a deposit to a small amount in the builder, nothing reached
   * the API (a prompt-based control that failed off-screen), the builder kept displaying its
   * local belief, and the client was invoiced the standard amount. What the builder displays
   * about a deposit must come from here, so a failed override cannot look like a successful one.
   */
  app.get<{ Params: { id: string } }>('/quotes/:id', read, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const { rows } = await app.db.query<{
      deposit_item_code: string | null; deposit_override_cents: number | null;
      deposit_override_reason: string | null; deposit_override_at: Date | null;
    }>(
      // The business by name in the same read (2026-09-20): the Ops quote page prints it, and a second
      // fetch for it landed after the page had been read on the phone.
      `SELECT q.*, c.first_name, c.last_name, c.email, b.name AS business_name
       FROM quotes q JOIN contacts c ON c.id = q.contact_id LEFT JOIN businesses b ON b.id = q.business_id WHERE q.id = $1`,
      [id]
    );
    const quote = rows[0];
    if (!quote) return { quote: null, lines: [], deposit: null };
    // THE WALL (phase 2, 2026-09-12): the interview answers that derived the price are return
    // content. They leave this route only for a holder of interviews.read.
    if (!holds(request.staff!, 'interviews.read')) delete (quote as Record<string, unknown>).interview_answers;
    const lines = await app.db.query(
      // The book price beside each line (2026-09-20), read by joining the quote's pinned version:
      // a line priced off the book shows the book's figure struck through; a custom line has none.
      `SELECT qli.item_code, qli.description_en, qli.description_es, qli.quantity, qli.unit_cents, qli.line_cents,
              qli.min_cents, qli.max_cents, qli.is_optional, qli.chosen, qli.is_pass_through,
              qli.is_custom, COALESCE(qli.service_line, pbi.service_line)::text AS service_line,
              pbi.amount_cents AS book_unit_cents, pbi.price_min_cents AS book_min_cents, pbi.price_max_cents AS book_max_cents
       FROM quote_line_items qli
       JOIN quotes q ON q.id = qli.quote_id
       LEFT JOIN price_book_items pbi ON pbi.item_code = qli.item_code AND pbi.version_id = q.price_book_version_id
       WHERE qli.quote_id = $1 ORDER BY qli.sort_order`,
      [id]
    );
    const { resolveDeposit } = await import('./quotes.ts');
    const resolved = await resolveDeposit(app, quote.deposit_item_code, quote.deposit_override_cents, id);
    const { periodsForQuote } = await import('../engagements/change-order.ts');
    return {
      quote,
      lines: lines.rows,
      // Decision 2: the periods each engagement line will cover ('2025' for tax).
      periods: await periodsForQuote(app, id),
      deposit: {
        standardCents: resolved.standardCents,
        chargeCents: resolved.chargeCents,
        treatment: resolved.treatment,
        // Staff see the reason; it is theirs. The public view never ships it.
        reason: quote.deposit_override_reason,
        overriddenAt: quote.deposit_override_at,
      },
    };
  });

  /** Quotes for one contact (client-detail tab). */
  app.get<{ Params: { id: string } }>('/contacts/:id/quotes', read, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const { rows } = await app.db.query(
      /*
       * Audit item 6 (2026-09-09): who started it and when, and whether a draft has gone stale
       * (older than 30 days). Stale is a FLAG for a person — nothing deletes a draft on its own.
       */
      /*
       * THE CARD'S ROW (2026-09-20): who and which business the quote is for, the lines in short form
       * (the price-book codes, chosen lines only), the status, when it was sent and when it expires.
       */
      `SELECT q.id, q.status::text AS status, q.total_cents, q.range_min_cents, q.range_max_cents,
              q.bundle_slug, q.sent_at, q.accepted_at, q.declined_at, q.decline_reason, q.expires_at, q.created_at,
              st.full_name AS created_by,
              (q.status = 'draft' AND q.created_at < now() - interval '30 days') AS is_stale,
              c.first_name || ' ' || c.last_name AS for_name,
              b.name AS business_name,
              COALESCE((SELECT array_agg(l.item_code ORDER BY l.sort_order) FROM quote_line_items l WHERE l.quote_id = q.id AND l.chosen), '{}')::text[] AS line_codes,
              COALESCE((SELECT array_agg(l.description_en ORDER BY l.sort_order) FROM quote_line_items l WHERE l.quote_id = q.id AND l.chosen), '{}')::text[] AS line_names
       FROM quotes q LEFT JOIN staff st ON st.id = q.created_by_staff_id
       JOIN contacts c ON c.id = q.contact_id
       LEFT JOIN businesses b ON b.id = q.business_id
       WHERE q.contact_id = $1 ORDER BY q.created_at DESC`,
      [id]
    );
    return { quotes: rows };
  });

  /**
   * Audit item 6 (2026-09-09): withdraw a DRAFT quote, with a reason. Only a draft — a sent
   * quote is the client's to decide on (they decline; it expires); an accepted one is an
   * engagement. The row stays (status void, the reason on the audit); nothing is deleted.
   */
  app.post<{ Params: { id: string } }>('/quotes/:id/withdraw-draft', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = z.object({ reason: z.string().trim().min(5, 'Say why in at least a few words — this is the record.').max(1000) }).parse(request.body);
    const { rows } = await app.db.query<{ status: string; contact_id: string }>(`SELECT status::text AS status, contact_id FROM quotes WHERE id = $1`, [id]);
    const q = rows[0];
    if (!q) throw new AppError(404, 'not_found', 'Quote not found.');
    if (q.status !== 'draft') throw new AppError(409, 'not_a_draft', `This quote is ${q.status}; only a draft is withdrawn here.`);
    await app.db.query(`UPDATE quotes SET status = 'void' WHERE id = $1 AND status = 'draft'`, [id]);
    await writeAudit(app.db, {
      actorType: 'staff', actorId: request.staff!.id, actorLabel: request.staff!.fullName,
      action: 'quote.draft_withdrawn', objectType: 'quote', objectId: id, contactId: q.contact_id,
      details: { reason: b.reason },
    });
    return { id, status: 'void' };
  });

  /** The pipeline board + conversion metrics. */
  app.get('/pipeline', read, async () => ({
    board: await pipelineBoard(app),
    metrics: await pipelineMetrics(app),
  }));

  /** Manual stage move (a booked call, a lead won offline). */
  app.post<{ Params: { id: string } }>('/contacts/:id/lead-stage', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = z
      .object({
        stage: z.enum(['call_booked', 'quoted', 'deposit_paid', 'onboarding', 'client', 'lost']),
        note: z.string().nullable().optional(),
      })
      .parse(request.body);
    return setLeadStage(app, id, b.stage, request.staff!, b.note ?? null);
  });

  // ---------------------------------------------------------------- public --
  // No session. The token is the credential; a wrong token is a 404.

  app.get<{ Params: { token: string } }>('/public/quote/:token', async (request) => {
    const token = z.string().min(20).parse(request.params.token);
    return quoteByToken(app, token);
  });

  app.post<{ Params: { token: string } }>('/public/quote/:token/accept', async (request) => {
    const token = z.string().min(20).parse(request.params.token);
    const b = z.object({ chooseOptional: z.array(z.string()).optional() }).parse(request.body ?? {});
    return acceptQuote(app, token, b);
  });

  app.post<{ Params: { token: string } }>('/public/quote/:token/decline', async (request) => {
    const token = z.string().min(20).parse(request.params.token);
    const b = z.object({ reason: z.string().min(1).max(2000) }).parse(request.body);
    await declineQuote(app, token, b.reason);
    return { declined: true };
  });
}
