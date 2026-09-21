/*
 * QUOTE BUILDER, the pure part (item 13, 2026-09-09, Brian's phone-walk ruling; redesigned
 * 2026-09-20 as grouped rows and an editable line table).
 *
 * The builder page is a React component with no render harness; the rules that decide what a
 * row shows, what a tap does, what the table's numbers are and when the reason field appears
 * live here as functions, so they are tested the way every other rule is. The page only calls
 * them.
 */

export interface PickedLine {
  itemCode: string;
  quantity: number;
  isOptional: boolean;
  /**
   * The unit amount on the line, in cents, as the person set it (2026-09-20). null means "the
   * book's price stands" — on a range-priced item that keeps the range. A custom line always
   * carries a number.
   */
  unitCents?: number | null;
  /** A line written by hand: no book item, its own name and service line. */
  custom?: { name: string; serviceLine: string } | undefined;
}

export interface CatalogLine {
  item_code: string;
  amount_cents: number | null;
  price_min_cents: number | null;
  price_max_cents: number | null;
  deposit_cents: number | null;
  is_pass_through: boolean;
  /** The rest is presentation (2026-09-20); optional so older callers and tests keep their shape. */
  name_en?: string;
  description_en?: string | null;
  group_key?: string | null;
  sort_order?: number;
  unit?: string | null;
  service_line?: string;
}

export interface CatalogGroup {
  key: string;
  label: string;
  fits: 'business' | 'individual' | 'both';
}

export type ClientType = 'business' | 'individual';

/** A chip is FILLED exactly when a line for its item is on the quote. */
export function isPicked(picked: readonly PickedLine[], itemCode: string): boolean {
  return picked.some((p) => p.itemCode === itemCode);
}

/**
 * Tapping a chip toggles the line: not on the quote → added (qty 1, required); on the quote →
 * removed. The chip's filled state and the line's presence can never disagree, because both
 * read the same array.
 */
export function togglePick(picked: readonly PickedLine[], itemCode: string): PickedLine[] {
  return isPicked(picked, itemCode)
    ? picked.filter((p) => p.itemCode !== itemCode)
    : [...picked, { itemCode, quantity: 1, isOptional: false, unitCents: null }];
}

/** "Add" on a catalog row: the line joins the quote once at the book price; a second Add is a no-op. */
export function addLine(picked: readonly PickedLine[], itemCode: string): PickedLine[] {
  return isPicked(picked, itemCode) ? [...picked] : [...picked, { itemCode, quantity: 1, isOptional: false, unitCents: null }];
}

let customSeq = 0;
/** A custom line joins the quote with a code no book item can have; the amount is the person's. */
export function addCustomLine(picked: readonly PickedLine[], line: { name: string; serviceLine: string; unitCents: number }): PickedLine[] {
  customSeq += 1;
  return [...picked, {
    itemCode: `CUSTOM_${customSeq}`, quantity: 1, isOptional: false, unitCents: line.unitCents,
    custom: { name: line.name, serviceLine: line.serviceLine },
  }];
}

/**
 * THE GROUPS IN THE ORDER THE PERSON SEES THEM (2026-09-20): those fitting the chosen client
 * type first (business or individual; 'both' fits either), then the rest, each block in the
 * catalog's own order.
 */
export function orderGroups(groups: readonly CatalogGroup[], clientType: ClientType): CatalogGroup[] {
  const fits = groups.filter((g) => g.fits === clientType || g.fits === 'both');
  const rest = groups.filter((g) => !(g.fits === clientType || g.fits === 'both'));
  return [...fits, ...rest];
}

/** "1120-S", "1120s", "form 1120 s" all read as 1120s: letters and digits only, lower case. */
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * The filter matches the name, the form number and the group (2026-09-20). Form numbers are
 * matched with punctuation and spacing ignored, so "1120s" finds "Form 1120-S", and the item
 * code counts as a form number too.
 */
export function matchesFilter(item: CatalogLine, groupLabel: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  const qs = squash(q);
  const name = (item.name_en ?? '').toLowerCase();
  if (name.includes(q)) return true;
  if (qs.length > 0 && squash(name).includes(qs)) return true;
  if (qs.length > 0 && squash(item.item_code).includes(qs)) return true;
  return groupLabel.toLowerCase().includes(q);
}

/** Units the person sets a quantity on: per form, per state, and their kin. Cadence units and flat do not. */
const QUANTITY_UNITS = new Set(['per_form', 'per_state', 'per_k1', 'per_property', 'per_additional', 'per_filing', 'per_hour', 'per_unit', 'per_session']);
export function showsQuantity(unit: string | null | undefined): boolean {
  return unit !== null && unit !== undefined && QUANTITY_UNITS.has(unit);
}

/** The words after the amount: "per state", "per form", "per month"; nothing for a flat price. */
export function unitWords(unit: string | null | undefined): string {
  if (!unit || unit === 'flat') return '';
  return unit.replace(/_/g, ' ').replace(/^per (\d+) months$/, 'per $1 months');
}

/** Dollars typed with or without a sign, commas or decimals → cents; null when the text is not an amount. */
export function parseDollars(text: string): number | null {
  const cleaned = text.replace(/[^0-9.]/g, '');
  if (cleaned.length === 0) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** What the book charges for the line: an amount, a range, or nothing (a custom line). */
export function bookPrice(item: CatalogLine | undefined): { kind: 'amount'; cents: number } | { kind: 'range'; min: number; max: number } | { kind: 'none' } {
  if (!item) return { kind: 'none' };
  if (item.amount_cents !== null) return { kind: 'amount', cents: item.amount_cents };
  if (item.price_min_cents !== null && item.price_max_cents !== null) return { kind: 'range', min: item.price_min_cents, max: item.price_max_cents };
  return { kind: 'none' };
}

/** A line is priced off the book when it is custom, or its amount is set and differs from the book's. */
export function isOffBook(line: PickedLine, item: CatalogLine | undefined): boolean {
  if (line.custom) return true;
  if (line.unitCents === null || line.unitCents === undefined) return false;
  return line.unitCents !== (item?.amount_cents ?? null);
}

export interface LineTotals {
  /** The line's own total: exact, a range, or unknown. Optional lines and pass-throughs still show theirs. */
  exactCents: number | null;
  minCents: number | null;
  maxCents: number | null;
}

/** One line's total from its quantity and its amount — the person's if set, else the book's. */
export function lineTotals(line: PickedLine, item: CatalogLine | undefined): LineTotals {
  const qty = Math.max(1, line.quantity);
  if (line.unitCents !== null && line.unitCents !== undefined) {
    return { exactCents: line.unitCents * qty, minCents: null, maxCents: null };
  }
  const book = bookPrice(item);
  if (book.kind === 'amount') return { exactCents: book.cents * qty, minCents: null, maxCents: null };
  if (book.kind === 'range') return { exactCents: null, minCents: book.min * qty, maxCents: book.max * qty };
  return { exactCents: null, minCents: null, maxCents: null };
}

export interface BuilderSummary {
  lineCount: number;
  /** Required (non-optional), fixed-price lines: what the client commits to. Pass-throughs excluded. */
  committedCents: number;
  /** When a required line is priced as a range, the committed figure is a range too. */
  committedMinCents: number;
  committedMaxCents: number;
  hasRange: boolean;
  /** The sum of the picked lines' price-book deposits; null when no picked line carries one. */
  depositCents: number | null;
  /** The lines priced off the book (2026-09-20): the reason field shows exactly when this is non-empty. */
  offBook: PickedLine[];
}

/** The panel's numbers, recomputed from the picked lines on every tap and every keystroke. */
export function builderSummary(picked: readonly PickedLine[], catalog: readonly CatalogLine[]): BuilderSummary {
  let committed = 0;
  let min = 0;
  let max = 0;
  let hasRange = false;
  const deposits: number[] = [];
  const offBook: PickedLine[] = [];
  for (const p of picked) {
    const item = catalog.find((i) => i.item_code === p.itemCode);
    if (!item && !p.custom) continue;
    if (item && item.deposit_cents !== null) deposits.push(item.deposit_cents);
    if (isOffBook(p, item)) offBook.push(p);
    if (p.isOptional || item?.is_pass_through) continue;
    const t = lineTotals(p, item);
    if (t.exactCents !== null) {
      committed += t.exactCents;
      min += t.exactCents;
      max += t.exactCents;
    } else if (t.minCents !== null && t.maxCents !== null) {
      hasRange = true;
      min += t.minCents;
      max += t.maxCents;
    }
  }
  return {
    lineCount: picked.length,
    committedCents: committed,
    committedMinCents: min,
    committedMaxCents: max,
    hasRange,
    depositCents: deposits.length === 0 ? null : deposits.reduce((a, b) => a + b, 0),
    offBook,
  };
}

/**
 * THE QUOTED RANGE, the same arithmetic createQuote does: the bottom is the composed total, the
 * top widens by the band. Recurring work quotes exact (asRange false) and gets no range.
 */
export function quotedRange(totalCents: number, bandPercent: number, asRange: boolean): { min: number; max: number } | null {
  if (!asRange) return null;
  return { min: totalCents, max: Math.round(totalCents * (1 + bandPercent / 100)) };
}

/** A package's discount rule over the lines as they now stand — mirrors applyBundleDiscount on the server. */
export function packageDiscountCents(
  rule: { kind: 'percent' | 'fixed' | 'override' | 'none'; value: number | null },
  subtotalCents: number
): number {
  if (rule.kind === 'override' && rule.value !== null) return Math.max(0, subtotalCents - rule.value);
  if (rule.kind === 'percent' && rule.value !== null) return Math.round((subtotalCents * rule.value) / 100);
  if (rule.kind === 'fixed' && rule.value !== null) return Math.min(rule.value, subtotalCents);
  return 0;
}

export type TaxYearSource = 'default' | 'chosen' | 'interview';

/** "2025 (default)" until changed; "2024" once chosen; "2023 (from interview)" when the interview said so. */
export function taxYearLabel(year: number | string, source: TaxYearSource): string {
  if (source === 'default') return `${year} (default)`;
  if (source === 'interview') return `${year} (from interview)`;
  return String(year);
}

/** The years the select offers: the default, four back, and one forward. */
export function taxYearOptions(defaultYear: number): number[] {
  return [defaultYear + 1, defaultYear, defaultYear - 1, defaultYear - 2, defaultYear - 3, defaultYear - 4];
}
