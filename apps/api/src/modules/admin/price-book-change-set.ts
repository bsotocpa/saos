/*
 * A PRICE-BOOK CHANGE SET, READ INTO A VERSION-DOOR REQUEST (R75, 2026-09-27).
 *
 * packages/db/seeds/data/price_book_v6.mjs states what v6 changes. Two of its facts are relative on
 * purpose: "the same deposit rule as BIZ_990" (depositFrom) and "beside BIZ_990 in the catalog"
 * (placeAfter). They are read here from the version the door will copy (the latest), so the request
 * carries the book's own figures and never a number typed twice. The door itself
 * (POST /admin/price-book/versions) does the publishing and the R55 check; this only builds its body.
 */
import type { Db } from '../../db.ts';

export interface ChangeSetAddition {
  itemCode: string;
  serviceLine: string;
  nameEn: string;
  nameEs: string;
  descriptionEn?: string | null;
  descriptionEs?: string | null;
  pricingMode: 'flat' | 'range' | 'hourly' | 'percent';
  unit: string;
  amountCents?: number | null;
  priceMinCents?: number | null;
  priceMaxCents?: number | null;
  /** The deposit of this item in the copied version (e.g. 'BIZ_990'). */
  depositFrom?: string;
  depositCents?: number | null;
  groupKey?: string | null;
  /** Sort right after this item (in the copied version, or earlier in this set). */
  placeAfter?: string;
}

export interface ChangeSet {
  effectiveFrom: string;
  note: string;
  additions?: ChangeSetAddition[];
  discountRules?: Array<Record<string, unknown>>;
  changes?: Array<Record<string, unknown>>;
}

export async function versionRequestFor(db: Db, cs: ChangeSet, opts: { effectiveFrom?: string } = {}) {
  const latest = await db.query<{ id: string }>(`SELECT id FROM price_book_versions ORDER BY version_number DESC LIMIT 1`);
  const versionId = latest.rows[0]?.id;
  if (!versionId) throw new Error('no price book version to build the change set against');
  const rows = await db.query<{ item_code: string; deposit_cents: number | null; sort_order: number }>(
    `SELECT item_code, deposit_cents, sort_order FROM price_book_items WHERE version_id = $1`,
    [versionId]
  );
  const book = new Map(rows.rows.map((r) => [r.item_code, r]));
  const placed = new Map<string, number>();
  const additions = (cs.additions ?? []).map((a) => {
    const { depositFrom, placeAfter, ...rest } = a;
    let depositCents = a.depositCents ?? null;
    if (depositFrom) {
      const from = book.get(depositFrom);
      if (!from) throw new Error(`${a.itemCode}: depositFrom ${depositFrom} is not in the book`);
      depositCents = from.deposit_cents;
    }
    let sortOrder = 0;
    if (placeAfter) {
      const after = placed.get(placeAfter) ?? book.get(placeAfter)?.sort_order;
      if (after === undefined) throw new Error(`${a.itemCode}: placeAfter ${placeAfter} is not in the book or the set`);
      sortOrder = after + 1;
    }
    placed.set(a.itemCode, sortOrder);
    return { ...rest, depositCents, sortOrder };
  });
  return {
    effectiveFrom: opts.effectiveFrom ?? cs.effectiveFrom,
    note: cs.note,
    changes: cs.changes ?? [],
    additions,
    discountRules: cs.discountRules ?? [],
  };
}
