// Bundle builder (v4.6). A bundle PRICES ITSELF from the price book: every
// component is an item_code, so there is no code path by which a bundle can
// carry an ad-hoc amount (CLAUDE.md). The discount is percent, fixed, or an
// explicit override — one of the three at most, enforced by a CHECK.
//
// The prior-year surcharge (+$100/return more than two years back) is itself a
// price-book item, applied automatically wherever a prior-year return is
// quoted — bundled or not.

import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types.ts';
import { surchargeApplies } from '../tax/resolution.ts';
import type { DeadlineReturnType } from '../tax/deadlines.ts';

export const SURCHARGE_ITEM = 'PRIOR_YEAR_SURCHARGE';

export interface ComposedLine {
  itemCode: string;
  nameEn: string;
  nameEs: string;
  quantity: number;
  unitCents: number | null;
  /** Range items (min/max) carry no single unit price — quotes show the range. */
  minCents: number | null;
  maxCents: number | null;
  lineCents: number | null;
  isOptional: boolean;
  needsConfirmation: boolean;
  noteEn: string | null;
  noteEs: string | null;
}

export interface ComposedBundle {
  slug: string;
  nameEn: string;
  nameEs: string;
  descriptionEn: string | null;
  lines: ComposedLine[];
  /** Fixed (non-optional) component subtotal. */
  subtotalCents: number;
  discount: { kind: 'percent' | 'fixed' | 'override' | 'none'; value: number | null; amountCents: number };
  totalCents: number;
  optionalAddOnCents: number;
  /** Any component still awaiting Brian's price confirmation. */
  unconfirmedItems: string[];
}

async function currentVersionId(app: FastifyInstance): Promise<string> {
  const { rows } = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions
     WHERE effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
     ORDER BY version_number DESC LIMIT 1`
  );
  if (!rows[0]) throw new AppError(500, 'price_book_missing', 'No price book version in force.');
  return rows[0].id;
}

/** Compose a bundle's price from the price book in force. */
export async function composeBundle(
  app: FastifyInstance,
  slug: string,
  opts: { includeOptional?: string[] } = {}
): Promise<ComposedBundle> {
  const versionId = await currentVersionId(app);
  const bundle = await app.db.query<{
    id: string; slug: string; name_en: string; name_es: string;
    description_en: string | null; discount_percent: string | null;
    discount_cents: number | null; override_cents: number | null;
  }>(
    `SELECT id, slug, name_en, name_es, description_en, discount_percent, discount_cents, override_cents
     FROM bundles WHERE version_id = $1 AND slug = $2 AND is_active`,
    [versionId, slug]
  );
  const b = bundle.rows[0];
  if (!b) throw new AppError(404, 'not_found', `Bundle '${slug}' not found in the price book in force.`);

  const components = await app.db.query<{
    item_code: string; quantity: string; is_optional: boolean; note_en: string | null; note_es: string | null;
    name_en: string; name_es: string; amount_cents: number | null;
    price_min_cents: number | null; price_max_cents: number | null; needs_confirmation: boolean;
  }>(
    `SELECT bc.item_code, bc.quantity, bc.is_optional, bc.note_en, bc.note_es,
            i.name_en, i.name_es, i.amount_cents, i.price_min_cents, i.price_max_cents, i.needs_confirmation
     FROM bundle_components bc
     JOIN price_book_items i ON i.item_code = bc.item_code AND i.version_id = $2 AND i.is_active
     WHERE bc.bundle_id = $1
     ORDER BY bc.sort_order`,
    [b.id, versionId]
  );

  const chosen = new Set(opts.includeOptional ?? []);
  const lines: ComposedLine[] = components.rows.map((c) => {
    const qty = Number(c.quantity);
    const unit = c.amount_cents;
    return {
      itemCode: c.item_code,
      nameEn: c.name_en,
      nameEs: c.name_es,
      quantity: qty,
      unitCents: unit,
      minCents: c.price_min_cents,
      maxCents: c.price_max_cents,
      lineCents: unit === null ? null : Math.round(unit * qty),
      isOptional: c.is_optional,
      needsConfirmation: c.needs_confirmation,
      noteEn: c.note_en,
      noteEs: c.note_es,
    };
  });

  const counted = lines.filter((l) => !l.isOptional || chosen.has(l.itemCode));
  const subtotalCents = counted.reduce((sum, l) => sum + (l.lineCents ?? 0), 0);

  let discount: ComposedBundle['discount'] = { kind: 'none', value: null, amountCents: 0 };
  let totalCents = subtotalCents;
  if (b.override_cents !== null) {
    discount = { kind: 'override', value: b.override_cents, amountCents: Math.max(0, subtotalCents - b.override_cents) };
    totalCents = b.override_cents;
  } else if (b.discount_percent !== null) {
    const pct = Number(b.discount_percent);
    const amount = Math.round((subtotalCents * pct) / 100);
    discount = { kind: 'percent', value: pct, amountCents: amount };
    totalCents = subtotalCents - amount;
  } else if (b.discount_cents !== null) {
    const amount = Math.min(b.discount_cents, subtotalCents);
    discount = { kind: 'fixed', value: b.discount_cents, amountCents: amount };
    totalCents = subtotalCents - amount;
  }

  return {
    slug: b.slug,
    nameEn: b.name_en,
    nameEs: b.name_es,
    descriptionEn: b.description_en,
    lines,
    subtotalCents,
    discount,
    totalCents,
    optionalAddOnCents: lines
      .filter((l) => l.isOptional && !chosen.has(l.itemCode))
      .reduce((sum, l) => sum + (l.lineCents ?? 0), 0),
    unconfirmedItems: counted.filter((l) => l.needsConfirmation).map((l) => l.itemCode),
  };
}

export interface GridYearInput {
  taxYear: number;
  returnType: DeadlineReturnType;
  /** Price-book item for the return itself (e.g. IND_BASE_MFJ, BIZ_1120S). */
  itemCode: string;
  booksExist?: 'yes' | 'partial' | 'no' | undefined;
  reconstructionHours?: number | undefined;
}

export interface GridRow {
  taxYear: number;
  returnType: DeadlineReturnType;
  lane: 'efile' | 'paper';
  returnCents: number | null;
  surchargeCents: number;
  reconstructionCents: number;
  lineTotalCents: number | null;
  statuteNote: string | null;
}

/**
 * The years × services quote grid (v4.6). Every dollar comes from the price
 * book; the surcharge is applied automatically on the >2-years boundary, and
 * each row carries its refund-statute note.
 */
export async function composeYearGrid(
  app: FastifyInstance,
  years: GridYearInput[],
  opts: { language?: 'en' | 'es'; today?: string; multiYearDiscountPercent?: number } = {}
): Promise<{
  rows: GridRow[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  unconfirmedItems: string[];
}> {
  const versionId = await currentVersionId(app);
  const codes = [...new Set([...years.map((y) => y.itemCode), SURCHARGE_ITEM, 'RES_BOOKS_RECONSTRUCTION'])];
  const priced = await app.db.query<{ item_code: string; amount_cents: number | null; needs_confirmation: boolean }>(
    `SELECT item_code, amount_cents, needs_confirmation
     FROM price_book_items WHERE version_id = $1 AND item_code = ANY($2) AND is_active`,
    [versionId, codes]
  );
  const price = new Map(priced.rows.map((r) => [r.item_code, r.amount_cents]));
  const unconfirmed = new Set(priced.rows.filter((r) => r.needs_confirmation).map((r) => r.item_code));
  const missing = codes.filter((c) => !price.has(c));
  if (missing.length > 0) {
    throw new AppError(400, 'unknown_price_items', `Not in the price book in force: ${missing.join(', ')}.`);
  }

  const { statuteNote, filingLane } = await import('../tax/resolution.ts');
  const surcharge = price.get(SURCHARGE_ITEM) ?? 0;
  const reconRate = price.get('RES_BOOKS_RECONSTRUCTION') ?? 0;

  const rows: GridRow[] = [...years]
    .sort((a, b) => a.taxYear - b.taxYear)
    .map((y) => {
      const returnCents = price.get(y.itemCode) ?? null;
      const surchargeCents = surchargeApplies(y.taxYear, opts.today) ? surcharge : 0;
      const hours = y.booksExist && y.booksExist !== 'yes' ? (y.reconstructionHours ?? 0) : 0;
      const reconstructionCents = Math.round(reconRate * hours);
      return {
        taxYear: y.taxYear,
        returnType: y.returnType,
        lane: filingLane(y.taxYear, opts.today),
        returnCents,
        surchargeCents,
        reconstructionCents,
        lineTotalCents: returnCents === null ? null : returnCents + surchargeCents + reconstructionCents,
        statuteNote: statuteNote(y.returnType, y.taxYear, opts.language ?? 'en', opts.today),
      };
    });

  const subtotalCents = rows.reduce((sum, r) => sum + (r.lineTotalCents ?? 0), 0);
  const pct = opts.multiYearDiscountPercent ?? 0;
  const discountCents = pct > 0 ? Math.round((subtotalCents * pct) / 100) : 0;
  return {
    rows,
    subtotalCents,
    discountCents,
    totalCents: subtotalCents - discountCents,
    unconfirmedItems: [...unconfirmed],
  };
}
