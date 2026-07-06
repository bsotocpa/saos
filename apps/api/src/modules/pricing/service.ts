// Pricing calculator (MP: pricing calculator (range); v4.2 Billing
// Architecture). Every number here comes from the price_book tables — the
// calculator carries NO amounts of its own (CLAUDE.md hard rule).
//
// Output is a RANGE, never an exact figure (MP "Get an Estimate"):
//  - line minimums sum to the floor; line maximums (range-priced items use
//    their max) sum and then widen by the estimate band
//  - the band applies to ONE-TIME work only (scope uncertainty); recurring
//    prices are contractual and stay exact
//  - band % lives in app_settings ('pricing.estimate_band_percent', default
//    15) — flagged for Brian's review, tunable in admin without a deploy
//
// Bundle rules (v4.2): bundle_price replaces one unit of each component with
// the combined price; free_with zeroes component lines when the condition
// item is on the quote. Pass-through items (QBO software) appear on quotes
// but never in revenue totals.

import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db.ts';
import { AppError } from '../../types.ts';

export type QuoteGroup = 'one_time' | 'monthly' | 'quarterly' | 'semi_annual' | 'annual';

const GROUP_BY_UNIT: Record<string, QuoteGroup> = {
  flat: 'one_time', per_hour: 'one_time', per_form: 'one_time', per_state: 'one_time',
  per_property: 'one_time', per_k1: 'one_time', per_filing: 'one_time', per_unit: 'one_time',
  per_additional: 'one_time',
  per_month: 'monthly', per_quarter: 'quarterly', per_6_months: 'semi_annual', per_year: 'annual',
};

export interface QuoteLine {
  code: string;
  name: string;
  qty: number;
  unit: string;
  group: QuoteGroup;
  minCents: number;
  maxCents: number;
  isPassThrough: boolean;
  needsConfirmation: boolean;
  freeVia: string | null;
}

export interface QuoteAdjustment {
  ruleCode: string;
  description: string;
  group: QuoteGroup;
  deltaCents: number; // negative = discount
}

export interface Quote {
  priceBookVersionId: string;
  priceBookVersionNumber: number;
  bandPercent: number;
  lines: QuoteLine[];
  adjustments: QuoteAdjustment[];
  /** Soto revenue by recurrence — pass-throughs excluded. one_time.max carries the band. */
  revenue: Partial<Record<QuoteGroup, { minCents: number; maxCents: number }>>;
  /** Software pass-through (shown on the quote, NOT Soto revenue). */
  passThrough: Partial<Record<QuoteGroup, number>>;
  needsConfirmation: boolean;
}

export async function currentPriceBookVersion(
  db: Db,
  asOf?: string
): Promise<{ id: string; versionNumber: number }> {
  const { rows } = await db.query<{ id: string; version_number: number }>(
    `SELECT id, version_number FROM price_book_versions
     WHERE effective_from <= COALESCE($1::date, CURRENT_DATE)
       AND (effective_to IS NULL OR effective_to > COALESCE($1::date, CURRENT_DATE))
     ORDER BY version_number DESC LIMIT 1`,
    [asOf ?? null]
  );
  if (!rows[0]) throw new AppError(500, 'price_book_missing', 'No price book version is in force — run the seeds.');
  return { id: rows[0].id, versionNumber: rows[0].version_number };
}

interface ItemRow {
  item_code: string;
  name_en: string;
  name_es: string;
  amount_cents: number | null;
  price_min_cents: number | null;
  price_max_cents: number | null;
  unit: string;
  is_pass_through: boolean;
  needs_confirmation: boolean;
}

interface RuleRow {
  rule_code: string;
  rule_type: 'bundle_price' | 'free_with';
  description_en: string;
  description_es: string | null;
  component_item_codes: string[];
  bundle_price_cents: number | null;
  condition_item_code: string | null;
}

export async function computeQuote(
  app: FastifyInstance,
  input: { items: Array<{ code: string; qty?: number | undefined }>; language?: 'en' | 'es' | undefined; asOf?: string | undefined }
): Promise<Quote> {
  if (input.items.length === 0) throw new AppError(400, 'empty_quote', 'Provide at least one item.');
  const language = input.language ?? 'en';
  const version = await currentPriceBookVersion(app.db, input.asOf);

  const codes = input.items.map((i) => i.code);
  const { rows: items } = await app.db.query<ItemRow>(
    `SELECT item_code, name_en, name_es, amount_cents, price_min_cents, price_max_cents,
            unit, is_pass_through, needs_confirmation
     FROM price_book_items
     WHERE version_id = $1 AND item_code = ANY($2) AND is_active`,
    [version.id, codes]
  );
  const byCode = new Map(items.map((i) => [i.item_code, i]));
  const unknown = codes.filter((c) => !byCode.has(c));
  if (unknown.length > 0) {
    throw new AppError(400, 'unknown_price_items', `Unknown price book item(s): ${unknown.join(', ')}.`);
  }

  const lines: QuoteLine[] = input.items.map(({ code, qty }) => {
    const item = byCode.get(code)!;
    const q = qty ?? 1;
    if (q <= 0) throw new AppError(400, 'invalid_quantity', `Quantity for ${code} must be positive.`);
    const minUnit = item.amount_cents ?? item.price_min_cents ?? 0;
    const maxUnit = item.amount_cents ?? item.price_max_cents ?? 0;
    return {
      code,
      name: language === 'es' ? item.name_es : item.name_en,
      qty: q,
      unit: item.unit,
      group: GROUP_BY_UNIT[item.unit] ?? 'one_time',
      minCents: Math.round(minUnit * q),
      maxCents: Math.round(maxUnit * q),
      isPassThrough: item.is_pass_through,
      needsConfirmation: item.needs_confirmation,
      freeVia: null,
    };
  });

  // Bundle rules for this version.
  const { rows: rules } = await app.db.query<RuleRow>(
    `SELECT rule_code, rule_type, description_en, description_es, component_item_codes,
            bundle_price_cents, condition_item_code
     FROM bundle_rules WHERE version_id = $1 AND is_active`,
    [version.id]
  );
  const present = new Set(lines.map((l) => l.code));
  const adjustments: QuoteAdjustment[] = [];

  for (const rule of rules) {
    const description = (language === 'es' ? rule.description_es : rule.description_en) ?? rule.description_en;
    if (rule.rule_type === 'free_with') {
      if (rule.condition_item_code && present.has(rule.condition_item_code)) {
        for (const line of lines) {
          if (rule.component_item_codes.includes(line.code)) {
            line.minCents = 0;
            line.maxCents = 0;
            line.freeVia = rule.rule_code;
          }
        }
      }
    } else {
      // bundle_price: all components present → one unit of each is replaced
      // by the combined price (extra quantities stay individually priced).
      if (rule.component_item_codes.every((c) => present.has(c))) {
        const componentLines = lines.filter((l) => rule.component_item_codes.includes(l.code) && !l.freeVia);
        if (componentLines.length === rule.component_item_codes.length && rule.bundle_price_cents !== null) {
          const oneUnitSum = componentLines.reduce((sum, l) => sum + Math.round(l.minCents / l.qty), 0);
          const delta = rule.bundle_price_cents - oneUnitSum;
          if (delta < 0) {
            adjustments.push({
              ruleCode: rule.rule_code,
              description,
              group: componentLines[0]!.group,
              deltaCents: delta,
            });
          }
        }
      }
    }
  }

  // Totals: revenue (non-pass-through) + pass-through, grouped by recurrence.
  const bandPercent = await estimateBandPercent(app.db);
  const revenue: Quote['revenue'] = {};
  const passThrough: Quote['passThrough'] = {};
  for (const line of lines) {
    if (line.isPassThrough) {
      passThrough[line.group] = (passThrough[line.group] ?? 0) + line.maxCents;
      continue;
    }
    const g = (revenue[line.group] ??= { minCents: 0, maxCents: 0 });
    g.minCents += line.minCents;
    g.maxCents += line.maxCents;
  }
  for (const adj of adjustments) {
    const g = (revenue[adj.group] ??= { minCents: 0, maxCents: 0 });
    g.minCents += adj.deltaCents;
    g.maxCents += adj.deltaCents;
  }
  // The estimate band widens ONE-TIME maximums only (recurring is contractual).
  if (revenue.one_time) {
    revenue.one_time.maxCents = Math.round(revenue.one_time.maxCents * (1 + bandPercent / 100));
  }

  return {
    priceBookVersionId: version.id,
    priceBookVersionNumber: version.versionNumber,
    bandPercent,
    lines,
    adjustments,
    revenue,
    passThrough,
    needsConfirmation: lines.some((l) => l.needsConfirmation),
  };
}

async function estimateBandPercent(db: Db): Promise<number> {
  const { rows } = await db.query<{ value: number }>(
    `SELECT (value)::text::int AS value FROM app_settings WHERE key = 'pricing.estimate_band_percent'`
  );
  return rows[0]?.value ?? 15;
}
