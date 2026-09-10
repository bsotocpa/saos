/*
 * QUOTE BUILDER, the pure part (item 13, 2026-09-09, Brian's phone-walk ruling).
 *
 * The builder page is a React component with no render harness; the rules that decide what a
 * chip shows, what a tap does, and what the summary bar says live here as functions, so they
 * are tested the way every other rule is. The page only calls them.
 */

export interface PickedLine {
  itemCode: string;
  quantity: number;
  isOptional: boolean;
}

export interface CatalogLine {
  item_code: string;
  amount_cents: number | null;
  price_min_cents: number | null;
  price_max_cents: number | null;
  deposit_cents: number | null;
  is_pass_through: boolean;
}

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
    : [...picked, { itemCode, quantity: 1, isOptional: false }];
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
}

/** The sticky bar's numbers, recomputed from the picked lines on every tap. */
export function builderSummary(picked: readonly PickedLine[], catalog: readonly CatalogLine[]): BuilderSummary {
  let committed = 0;
  let min = 0;
  let max = 0;
  let hasRange = false;
  const deposits: number[] = [];
  for (const p of picked) {
    const item = catalog.find((i) => i.item_code === p.itemCode);
    if (!item) continue;
    if (item.deposit_cents !== null) deposits.push(item.deposit_cents);
    if (p.isOptional || item.is_pass_through) continue;
    const qty = Math.max(1, p.quantity);
    if (item.amount_cents !== null) {
      committed += item.amount_cents * qty;
      min += item.amount_cents * qty;
      max += item.amount_cents * qty;
    } else if (item.price_min_cents !== null && item.price_max_cents !== null) {
      hasRange = true;
      min += item.price_min_cents * qty;
      max += item.price_max_cents * qty;
    }
  }
  return {
    lineCount: picked.length,
    committedCents: committed,
    committedMinCents: min,
    committedMaxCents: max,
    hasRange,
    depositCents: deposits.length === 0 ? null : deposits.reduce((a, b) => a + b, 0),
  };
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
