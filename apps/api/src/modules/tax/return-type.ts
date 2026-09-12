/*
 * WHICH RETURN A QUOTED TAX LINE IS (2026-09-12, the first 1120S).
 *
 * Until today an accepted quote created the tax ENGAGEMENT and never the RETURN record: no
 * tax_engagements row, so no stages, no 8879 gate, no filing, no acknowledgment, and the
 * schedule resolver defaulted a business-tax quote to Schedule A because it had no return type
 * to read. The preparer then opening the return by hand collided with the accepted quote's
 * engagement on the one-active-per-line-period index. The quote's own price-book items say what
 * the return is; this reads them.
 *
 * The map is by item code, the stable key the price book carries (packages/db/seeds/data/
 * price_book.mjs). An add-on (Schedule C, an extra state, a notice) names no return by itself;
 * a quote with only add-ons and no base return item creates no return record, and says so.
 */
export type QuotedReturn = { returnType: string; clientType: 'individual' | 'business' | 'nonprofit' };

const BASE_ITEMS: Record<string, QuotedReturn> = {
  IND_BASE_SINGLE: { returnType: '1040', clientType: 'individual' },
  IND_BASE_MFJ: { returnType: '1040', clientType: 'individual' },
  IND_BASE_MFS: { returnType: '1040', clientType: 'individual' },
  IND_BASE_HOH: { returnType: '1040', clientType: 'individual' },
  BIZ_SCH_C: { returnType: '1040', clientType: 'individual' }, // a Schedule C rides on the owner's 1040
  BIZ_1065: { returnType: '1065', clientType: 'business' },
  BIZ_1120S: { returnType: '1120s', clientType: 'business' },
  BIZ_1120: { returnType: '1120', clientType: 'business' },
  BIZ_1120C: { returnType: '1120c', clientType: 'business' },
  BIZ_1120F: { returnType: '1120f', clientType: 'business' },
  BIZ_1120H: { returnType: '1120h', clientType: 'business' },
  BIZ_1120POL: { returnType: '1120pol', clientType: 'business' },
  BIZ_990: { returnType: '990', clientType: 'nonprofit' },
};

/** The return a set of quoted item codes names, or null when none of them is a base return. */
export function returnTypeForItems(itemCodes: readonly string[]): QuotedReturn | null {
  // A business base return wins over an individual one on the same line (an S corp owner's
  // quote can carry BIZ_1120S beside BIZ_SCH_C for a side business; the line is the entity's).
  const hits = itemCodes.map((c) => BASE_ITEMS[c]).filter((x): x is QuotedReturn => x !== undefined);
  if (hits.length === 0) return null;
  return hits.find((h) => h.clientType !== 'individual') ?? hits[0]!;
}
