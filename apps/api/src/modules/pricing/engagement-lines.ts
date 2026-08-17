// FINDING #19 — what engagement a quote actually creates.
//
// `acceptQuote()` hardcoded `serviceLine: 'tax'` and titled every engagement "Accepted
// quote". Two consequences: no non-tax quote could be accepted honestly (GATE 1 blocked
// sending them at all), and a client with two engagements read "2 active engagements
// (tax, tax)" with nothing to tell them apart — Brian's RC2 finding.
//
// TWO ENUMS, DELIBERATELY DIFFERENT. `price_service_line` classifies what the price book
// SELLS (12 values); `service_line` classifies what we AGREE TO DO (10 values). They are
// not the same axis and never were:
//
//   · individual_tax and business_tax both produce ONE engagement line, `tax`
//   · recurring_accounting produces THREE — bookkeeping, payroll, sales_tax — which is
//     why this file maps per ITEM there and per line everywhere else
//
// Brian's ruling 2026-08-15: one engagement per distinct service line in the quote, and
// a per-item map for the clear recurring cases with the rest defaulting to bookkeeping.

import type { FastifyInstance } from 'fastify';

/** The engagement service lines (`service_line` enum). */
export type EngagementLine =
  | 'tax' | 'bookkeeping' | 'payroll' | 'sales_tax' | 'advisory'
  | 'coo' | 'entity' | 'attest' | 'specialized_cpa' | 'nonprofit_cfo';

/**
 * Price-book line → engagement line, for the lines that mean exactly one thing.
 *
 * Absent on purpose:
 *   deposit, software_passthrough — not work, and neither survives into v4+ quoting
 *   scope_ladder                  — a pricing device, not a service (maps to no schedule
 *                                   either; see schedule_for_price_line)
 *   recurring_accounting          — genuinely three services; resolved per item below
 */
const LINE_MAP: Record<string, EngagementLine> = {
  individual_tax: 'tax',
  business_tax: 'tax',
  entity_services: 'entity',
  attest: 'attest',
  specialized_cpa: 'specialized_cpa',
  coo: 'coo',
  // Books setup/conversion is bookkeeping work that happens once.
  setup_conversion: 'bookkeeping',
  // 1099/W-2 filing is payroll compliance.
  filings_1099_w2: 'payroll',
};

/**
 * The recurring_accounting exceptions, by item code.
 *
 * Schedule C covers bookkeeping, payroll and sales tax together, so the price book files
 * all three under one line and only the ITEM says which it is. These are the ones that
 * are not bookkeeping; everything else in the line is.
 */
const RECURRING_ITEM_MAP: Record<string, EngagementLine> = {
  SCOPE_FULLMGMT_PAYROLL: 'payroll',
  SCOPE_FULLMGMT_SALES_TAX: 'sales_tax',
  SALES_TAX_ST1_FILING: 'sales_tax',
};
const RECURRING_DEFAULT: EngagementLine = 'bookkeeping';

/** Price lines that never produce an engagement, whatever else is on the quote. */
const NON_ENGAGEMENT_LINES = new Set(['deposit', 'software_passthrough', 'scope_ladder']);

export function engagementLineFor(priceServiceLine: string, itemCode: string): EngagementLine | null {
  if (NON_ENGAGEMENT_LINES.has(priceServiceLine)) return null;
  if (priceServiceLine === 'recurring_accounting') {
    return RECURRING_ITEM_MAP[itemCode] ?? RECURRING_DEFAULT;
  }
  return LINE_MAP[priceServiceLine] ?? null;
}

/**
 * One quote line, as it read at acceptance (#47).
 *
 * Carried by value rather than by id on purpose: these become `engagement_scope_items`,
 * which is a snapshot. A later edit to the quote line must not reach the engagement.
 */
export interface QuotedScopeItem {
  sourceQuoteLineId: string;
  itemCode: string;
  descriptionEn: string;
  descriptionEs: string | null;
  quantity: string;
  unitCents: number | null;
  lineCents: number | null;
  isPassThrough: boolean;
  sortOrder: number;
}

export interface QuotedEngagementLine {
  serviceLine: EngagementLine;
  /** Item names on this quote that belong to this line — the title is built from them. */
  itemNames: string[];
  itemCodes: string[];
  /** #47 — the lines themselves, to be snapshotted onto the engagement. */
  scope: QuotedScopeItem[];
}

/** Human label per engagement line, for titles a person can tell apart at a glance. */
const LINE_LABEL: Record<EngagementLine, string> = {
  tax: 'Tax',
  bookkeeping: 'Bookkeeping',
  payroll: 'Payroll',
  sales_tax: 'Sales tax',
  advisory: 'Advisory',
  coo: 'COO services',
  entity: 'Entity services',
  attest: 'Attest',
  specialized_cpa: 'Specialized CPA',
  nonprofit_cfo: 'Nonprofit CFO',
};

/**
 * A title that distinguishes THIS engagement from the client's others.
 *
 * "Accepted quote" twice on one client is what Brian saw. The line name alone is not
 * enough either — two tax engagements in different years would collide — so the leading
 * item is named, and the count carries the rest.
 */
export function engagementTitle(line: QuotedEngagementLine): string {
  const label = LINE_LABEL[line.serviceLine];
  const first = line.itemNames[0];
  if (!first) return label;
  const extra = line.itemNames.length - 1;
  return extra > 0 ? `${label} — ${first} +${extra} more` : `${label} — ${first}`;
}

/**
 * Group a quote's CHOSEN lines into the engagements it should create.
 *
 * The price-book version is pinned to the quote's own, for the reason spelled out in
 * quote-coverage.ts: joining on item_code alone matches the item in every version, so a
 * later reclassification retroactively changes what an old quote meant.
 */
export async function engagementLinesForQuote(
  app: FastifyInstance,
  quoteId: string
): Promise<QuotedEngagementLine[]> {
  const { rows } = await app.db.query<{
    service_line: string; item_code: string; name_en: string; sort_order: number;
    line_id: string; description_en: string; description_es: string | null;
    quantity: string; unit_cents: number | null; line_cents: number | null;
    is_pass_through: boolean;
  }>(
    /*
     * #47 — the line's own text comes back too, not just the price book's name.
     *
     * `qli.description_en/_es` is what the CLIENT read and agreed to; `pbi.name_en` is
     * what the book calls the item today. They can differ, and the one that belongs on
     * the record of an agreement is the one that was on the page.
     */
    `SELECT pbi.service_line::text AS service_line, qli.item_code, pbi.name_en, pbi.sort_order,
            qli.id AS line_id, qli.description_en, qli.description_es,
            qli.quantity::text AS quantity, qli.unit_cents, qli.line_cents, qli.is_pass_through
       FROM quote_line_items qli
       JOIN quotes q ON q.id = qli.quote_id
       JOIN price_book_items pbi
         ON pbi.item_code = qli.item_code
        AND pbi.version_id = q.price_book_version_id
      WHERE qli.quote_id = $1 AND qli.chosen
      ORDER BY pbi.sort_order, qli.item_code`,
    [quoteId]
  );

  const byLine = new Map<EngagementLine, QuotedEngagementLine>();
  for (const r of rows) {
    const line = engagementLineFor(r.service_line, r.item_code);
    if (!line) continue;
    const item: QuotedScopeItem = {
      sourceQuoteLineId: r.line_id,
      itemCode: r.item_code,
      descriptionEn: r.description_en,
      descriptionEs: r.description_es,
      quantity: r.quantity,
      unitCents: r.unit_cents,
      lineCents: r.line_cents,
      isPassThrough: r.is_pass_through,
      sortOrder: r.sort_order,
    };
    const existing = byLine.get(line);
    if (existing) {
      existing.itemNames.push(r.name_en);
      existing.itemCodes.push(r.item_code);
      existing.scope.push(item);
    } else {
      byLine.set(line, {
        serviceLine: line, itemNames: [r.name_en], itemCodes: [r.item_code], scope: [item],
      });
    }
  }
  return [...byLine.values()];
}

/**
 * THE SUCCESSOR TO GATE 1.
 *
 * GATE 1 refused any non-tax quote at send, because accepting one hardcoded a `tax`
 * engagement and would have papered bookkeeping work with a Schedule A agreement. That
 * reason is gone — acceptance now derives the line from the book.
 *
 * The replacement guards what is left: a chosen line whose price-book classification maps
 * to NO engagement line would be silently dropped when the engagements are built, so the
 * client would agree to work that produces no agreement and no schedule. Refusing at SEND
 * keeps the failure in front of the staff member who can fix it, before the client has
 * been asked to decide anything — the same reasoning as the coverage gate beside it.
 *
 * Deposits, pass-throughs and scope ladders are deliberately not work and pass silently;
 * a quote made ONLY of those is caught at acceptance instead, where the check can see
 * that nothing at all would be created.
 */
export async function assertEveryLineCreatesWork(app: FastifyInstance, quoteId: string): Promise<void> {
  const { rows } = await app.db.query<{ service_line: string; item_code: string }>(
    // Version pinned to the quote's own, so a later reclassification cannot retroactively
    // change what this quote meant (quote-coverage.ts has the full reasoning).
    `SELECT DISTINCT pbi.service_line::text AS service_line, qli.item_code
       FROM quote_line_items qli
       JOIN quotes q ON q.id = qli.quote_id
       JOIN price_book_items pbi
         ON pbi.item_code = qli.item_code
        AND pbi.version_id = q.price_book_version_id
      WHERE qli.quote_id = $1 AND qli.chosen
      ORDER BY 1`,
    [quoteId]
  );

  const orphans = rows.filter(
    (r) => !NON_ENGAGEMENT_LINES.has(r.service_line) && engagementLineFor(r.service_line, r.item_code) === null
  );
  if (orphans.length === 0) return;

  const { AppError } = await import('../../types.ts');
  const detail = orphans.map((o) => `${o.item_code} (${o.service_line})`).join(', ');
  throw new AppError(
    409,
    'unmapped_service_line',
    `These lines are priced but map to no engagement service line, so accepting this quote ` +
      `would agree to work that creates no engagement and no schedule: ${detail}. ` +
      `Add the mapping in engagement-lines.ts before quoting them.`
  );
}
