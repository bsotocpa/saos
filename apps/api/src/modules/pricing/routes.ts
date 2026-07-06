import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { computeQuote } from './service.ts';

const QuoteBody = z.object({
  items: z.array(z.object({ code: z.string().min(1), qty: z.number().positive().optional() })).min(1),
  language: z.enum(['en', 'es']).optional(),
  asOf: z.iso.date().optional(),
});

export function registerPricingRoutes(app: FastifyInstance): void {
  const read = { preHandler: [app.authenticate, requirePermission('engagements.read')] };
  const manage = { preHandler: [app.authenticate, requirePermission('engagements.tax.manage')] };

  /** Compute a quote (no persistence) — staff pricing tool + Get an Estimate backend. */
  app.post('/pricing/quote', read, async (request) => {
    const b = QuoteBody.parse(request.body);
    return computeQuote(app, b);
  });

  /**
   * Compute AND lock onto a tax engagement: writes the one-time revenue range
   * to estimated_fee_min/max, stamps estimate_locked_at (automation 8 —
   * preparation unlocks), pins the price book version on the parent
   * engagement, and records the full line detail in the audit trail.
   */
  app.post<{ Params: { id: string } }>('/tax-engagements/:id/quote', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = QuoteBody.parse(request.body);
    const quote = await computeQuote(app, b);
    if (!quote.revenue.one_time) {
      throw new AppError(400, 'no_one_time_component', 'A tax estimate needs at least one one-time item.');
    }

    const te = await app.db.query<{ engagement_id: string; contact_id: string }>(
      `SELECT te.engagement_id, e.contact_id
       FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id
       WHERE te.id = $1`,
      [id]
    );
    if (!te.rows[0]) throw new AppError(404, 'not_found', 'Tax engagement not found.');

    await app.db.query(
      `UPDATE tax_engagements
       SET estimated_fee_min_cents = $2, estimated_fee_max_cents = $3, estimate_locked_at = now()
       WHERE id = $1`,
      [id, quote.revenue.one_time.minCents, quote.revenue.one_time.maxCents]
    );
    // Pin the version in force at estimate time (grandfathering root).
    await app.db.query(`UPDATE engagements SET price_book_version_id = $2 WHERE id = $1`, [
      te.rows[0].engagement_id,
      quote.priceBookVersionId,
    ]);

    await writeAudit(app.db, {
      actorType: 'staff',
      actorId: request.staff!.id,
      actorLabel: request.staff!.email,
      action: 'tax_engagement.estimate_locked',
      objectType: 'tax_engagement',
      objectId: id,
      contactId: te.rows[0].contact_id,
      details: {
        price_book_version: quote.priceBookVersionNumber,
        band_percent: quote.bandPercent,
        range_cents: quote.revenue.one_time,
        items: b.items,
        adjustments: quote.adjustments.map((a) => a.ruleCode),
      },
    });
    return { status: 'ok', quote };
  });
}
