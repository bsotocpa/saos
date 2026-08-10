// Quote builder + leads pipeline routes (M27, v4.4).
//
// Staff routes build and send; the three /public/quote/:token routes are
// UNAUTHENTICATED by design — the emailed token IS the credential, exactly like
// a magic link, and only its SHA-256 is stored. A client should not need an
// account to read a proposal we sent them.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import {
  acceptQuote, createQuote, declineQuote, overrideQuoteDeposit, quoteByToken, sendQuote,
} from './quotes.ts';
import { pipelineBoard, pipelineMetrics, setLeadStage } from './pipeline.ts';

const LineInput = z.object({
  itemCode: z.string().min(1),
  quantity: z.number().positive().optional(),
  isOptional: z.boolean().optional(),
  chosen: z.boolean().optional(),
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
  })
  .refine((b) => Boolean(b.bundleSlug) || (b.lines?.length ?? 0) > 0, {
    message: 'Provide bundleSlug or at least one line item.',
  });

export function registerQuoteRoutes(app: FastifyInstance): void {
  const read = { preHandler: [app.authenticate, requirePermission('engagements.read')] };
  const manage = { preHandler: [app.authenticate, requirePermission('engagements.tax.manage')] };

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
      `SELECT item_code, service_line::text AS service_line, name_en, name_es, amount_cents,
              price_min_cents, price_max_cents, unit, is_pass_through, needs_confirmation
       FROM price_book_items
       WHERE version_id = $1 AND is_active AND display_on_quote
       ORDER BY service_line, sort_order`,
      [v.id]
    );
    const bundles = await app.db.query(
      `SELECT b.slug, b.name_en, b.name_es, count(bc.id)::int AS component_count
       FROM bundles b LEFT JOIN bundle_components bc ON bc.bundle_id = b.id
       WHERE b.version_id = $1 AND b.is_active
       GROUP BY b.slug, b.name_en, b.name_es ORDER BY b.name_en`,
      [v.id]
    );
    return { version: v, items: items.rows, bundles: bundles.rows };
  });

  /** Build a draft quote from price-book items or a bundle. Nothing sends yet. */
  app.post('/quotes', manage, async (request, reply) => {
    const b = CreateQuoteBody.parse(request.body);
    const result = await createQuote(app, b, request.staff!);
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
          reason: z.string().trim().min(10, 'Say why in at least a few words — this is the record.').max(1000),
        })
        .parse(request.body);
      return overrideQuoteDeposit(app, id, b, request.staff!);
    }
  );

  /** Send it: mints the client link, pins the version, moves the lead to 'quoted'. */
  app.post<{ Params: { id: string } }>('/quotes/:id/send', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    return sendQuote(app, id, request.staff!);
  });

  /** Staff view of a quote (by id) — the same body the client sees, plus internals. */
  app.get<{ Params: { id: string } }>('/quotes/:id', read, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const { rows } = await app.db.query(
      `SELECT q.*, c.first_name, c.last_name, c.email
       FROM quotes q JOIN contacts c ON c.id = q.contact_id WHERE q.id = $1`,
      [id]
    );
    if (rows.length === 0) return { quote: null, lines: [] };
    const lines = await app.db.query(
      `SELECT item_code, description_en, description_es, quantity, unit_cents, line_cents,
              min_cents, max_cents, is_optional, chosen, is_pass_through
       FROM quote_line_items WHERE quote_id = $1 ORDER BY sort_order`,
      [id]
    );
    return { quote: rows[0], lines: lines.rows };
  });

  /** Quotes for one contact (client-detail tab). */
  app.get<{ Params: { id: string } }>('/contacts/:id/quotes', read, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const { rows } = await app.db.query(
      `SELECT id, status::text AS status, total_cents, range_min_cents, range_max_cents,
              bundle_slug, sent_at, accepted_at, declined_at, decline_reason, expires_at, created_at
       FROM quotes WHERE contact_id = $1 ORDER BY created_at DESC`,
      [id]
    );
    return { quotes: rows };
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
