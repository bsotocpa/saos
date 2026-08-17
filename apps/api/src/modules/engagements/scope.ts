/*
 * #47 — WHAT AN ENGAGEMENT COVERS.
 *
 * An engagement could not say what it was for. #41's two identical `tax`/`active` rows had
 * nothing to distinguish them because nothing recorded what either one covered — the split
 * from quote into engagements happened in code and was never written down.
 *
 * These rows are a SNAPSHOT of the quote lines as they read at acceptance. Nothing here
 * joins back to `quote_line_items`, by design: a quote edited afterwards must not silently
 * rewrite an agreement that was already made. The database refuses UPDATE on these rows;
 * this module never attempts one.
 */

import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import type { QuotedScopeItem } from '../pricing/engagement-lines.ts';

export interface ScopeItem {
  itemCode: string;
  descriptionEn: string;
  descriptionEs: string | null;
  quantity: string;
  unitCents: number | null;
  lineCents: number | null;
  isPassThrough: boolean;
}

/**
 * Snapshot a quote's lines onto the engagement they created.
 *
 * ONE STATEMENT, so the whole set lands or none of it does. `acceptQuote` is not
 * transactional — it creates engagements, then invoices, then packets in sequence, and has
 * always been that way — so this cannot promise "engagement and scope together". What it
 * can promise is that scope is written in the same loop iteration, immediately after the
 * engagement exists and before anything else can fail, and that a partial scope is
 * impossible. Making acceptance atomic is its own piece of work, larger than #47.
 */
export async function captureEngagementScope(
  app: FastifyInstance,
  engagementId: string,
  quoteId: string,
  priceBookVersionId: string,
  items: QuotedScopeItem[]
): Promise<number> {
  if (items.length === 0) return 0;

  await app.db.query(
    `INSERT INTO engagement_scope_items
       (engagement_id, source_quote_id, source_quote_line_id, price_book_version_id,
        item_code, description_en, description_es, quantity, unit_cents, line_cents,
        is_pass_through, sort_order)
     SELECT $1, $2, x.line_id, $3,
            x.item_code, x.description_en, x.description_es, x.quantity, x.unit_cents,
            x.line_cents, x.is_pass_through, x.sort_order
       FROM jsonb_to_recordset($4::jsonb) AS x(
         line_id uuid, item_code text, description_en text, description_es text,
         quantity numeric, unit_cents integer, line_cents integer,
         is_pass_through boolean, sort_order integer
       )`,
    [
      engagementId,
      quoteId,
      priceBookVersionId,
      JSON.stringify(
        items.map((i) => ({
          line_id: i.sourceQuoteLineId,
          item_code: i.itemCode,
          description_en: i.descriptionEn,
          description_es: i.descriptionEs,
          quantity: i.quantity,
          unit_cents: i.unitCents,
          line_cents: i.lineCents,
          is_pass_through: i.isPassThrough,
          sort_order: i.sortOrder,
        }))
      ),
    ]
  );
  return items.length;
}

/** What this engagement covers, in agreement order. Empty for pre-#47 engagements. */
export async function scopeForEngagement(
  app: FastifyInstance,
  engagementId: string
): Promise<ScopeItem[]> {
  const { rows } = await app.db.query<{
    item_code: string; description_en: string; description_es: string | null;
    quantity: string; unit_cents: number | null; line_cents: number | null;
    is_pass_through: boolean;
  }>(
    `SELECT item_code, description_en, description_es, quantity::text AS quantity,
            unit_cents, line_cents, is_pass_through
       FROM engagement_scope_items
      WHERE engagement_id = $1
      ORDER BY sort_order, item_code`,
    [engagementId]
  );
  return rows.map((r) => ({
    itemCode: r.item_code,
    descriptionEn: r.description_en,
    descriptionEs: r.description_es,
    quantity: r.quantity,
    unitCents: r.unit_cents,
    lineCents: r.line_cents,
    isPassThrough: r.is_pass_through,
  }));
}

/**
 * Scope for many engagements at once, keyed by engagement id.
 *
 * The portal and the client record both list engagements, and asking per row is the query
 * that looks fine with two engagements and is a problem with a season's worth.
 */
export async function scopeForEngagements(
  app: FastifyInstance,
  engagementIds: string[]
): Promise<Map<string, ScopeItem[]>> {
  const out = new Map<string, ScopeItem[]>();
  if (engagementIds.length === 0) return out;
  const { rows } = await app.db.query<{
    engagement_id: string; item_code: string; description_en: string;
    description_es: string | null; quantity: string; unit_cents: number | null;
    line_cents: number | null; is_pass_through: boolean;
  }>(
    `SELECT engagement_id, item_code, description_en, description_es,
            quantity::text AS quantity, unit_cents, line_cents, is_pass_through
       FROM engagement_scope_items
      WHERE engagement_id = ANY($1::uuid[])
      ORDER BY engagement_id, sort_order, item_code`,
    [engagementIds]
  );
  for (const r of rows) {
    const list = out.get(r.engagement_id) ?? [];
    list.push({
      itemCode: r.item_code,
      descriptionEn: r.description_en,
      descriptionEs: r.description_es,
      quantity: r.quantity,
      unitCents: r.unit_cents,
      lineCents: r.line_cents,
      isPassThrough: r.is_pass_through,
    });
    out.set(r.engagement_id, list);
  }
  return out;
}

/**
 * A client-facing name for the engagement, in one language.
 *
 * Returns null when there is no scope, and the caller keeps composing the way it does
 * today (service line + tax year). That is deliberate: an engagement created before #47
 * genuinely does not know what it covers, and inventing a name would be a confident wrong
 * answer — the same error as the 426-client backfill.
 *
 * Pass-through lines are excluded from the NAME. Software a client pays for through us is
 * part of the bill, not part of what we agreed to do, and leading with it would describe
 * the engagement by its smallest true detail.
 */
export function scopeName(items: ScopeItem[], lang: 'en' | 'es'): string | null {
  const named = items.filter((i) => !i.isPassThrough);
  const first = named[0];
  if (!first) return null;
  const label = (i: ScopeItem) => (lang === 'es' ? i.descriptionEs || i.descriptionEn : i.descriptionEn);
  const extra = named.length - 1;
  if (extra === 0) return label(first);
  return lang === 'es'
    ? `${label(first)} +${extra} más`
    : `${label(first)} +${extra} more`;
}

/**
 * #44's delivery question, for work that has no pipeline.
 *
 * A tax engagement knows it is done because the return reached a terminal stage. Bookkeeping
 * and payroll have no such signal, and scope is what makes "is it all delivered?" answerable
 * at all: an engagement covering three items is done when all three are.
 *
 * Not wired to anything yet — the rest of #44 is where a staff member marks items delivered.
 * Exported now so the shape is settled before the UI is built on it.
 */
export function scopeSummary(items: ScopeItem[]): { count: number; totalCents: number } {
  const billable = items.filter((i) => !i.isPassThrough);
  return {
    count: billable.length,
    totalCents: billable.reduce((sum, i) => sum + (i.lineCents ?? 0), 0),
  };
}

/**
 * Log when an engagement is created from a quote without scope landing.
 *
 * Not an error — the caller must not fail an acceptance over a record-keeping row — but
 * silence here is how #41 happened the first time.
 */
export function warnIfScopeless(log: FastifyBaseLogger, engagementId: string, captured: number): void {
  if (captured === 0) {
    log.warn(
      { engagementId },
      '#47: engagement created from a quote with no scope items captured — it will not be able to say what it covers'
    );
  }
}
