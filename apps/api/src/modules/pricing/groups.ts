/*
 * THE CATALOG GROUPS (Brian, 2026-09-20). The builder lists the price book as grouped rows; the
 * group a row belongs to is presentation metadata on the item (price_book_items.group_key, set by
 * migration 0116 and the seed), and this is the order and the labels of the groups themselves.
 *
 * The keys here and the keys the seed writes must agree; quote-builder.spec.ts asserts every
 * catalog item carries one of these keys, so a group added in one place and not the other fails
 * a test rather than rendering an unlabelled section.
 */

export type ClientType = 'business' | 'individual';

export interface CatalogGroup {
  key: string;
  label: string;
  /** Which client type the group belongs to; 'both' fits either. */
  fits: ClientType | 'both';
}

export const CATALOG_GROUPS: readonly CatalogGroup[] = [
  { key: 'business_returns', label: 'Business returns', fits: 'business' },
  { key: 'business_addons', label: 'Business add-ons', fits: 'business' },
  { key: 'individual_returns', label: 'Individual returns', fits: 'individual' },
  { key: 'individual_forms', label: 'Individual schedules and forms', fits: 'individual' },
  { key: 'entity_compliance', label: 'Entity and compliance', fits: 'business' },
  { key: 'information_returns', label: 'Information returns', fits: 'business' },
  { key: 'assurance', label: 'Assurance and audits', fits: 'business' },
  { key: 'advisory', label: 'Advisory', fits: 'both' },
  { key: 'recurring', label: 'Recurring services', fits: 'business' },
];

export const GROUP_KEYS: ReadonlySet<string> = new Set(CATALOG_GROUPS.map((g) => g.key));

/**
 * The service lines a custom line may belong to: every sellable line in the book. 'deposit' is
 * the retired deposit-item line and 'scope_ladder' has no items left; neither is work a person
 * writes a line for.
 */
export const CUSTOM_LINE_SERVICE_LINES = [
  'individual_tax', 'business_tax', 'recurring_accounting', 'setup_conversion',
  'software_passthrough', 'filings_1099_w2', 'entity_services', 'attest', 'specialized_cpa', 'coo',
] as const;
export type CustomLineServiceLine = (typeof CUSTOM_LINE_SERVICE_LINES)[number];

export const SERVICE_LINE_LABEL: Record<CustomLineServiceLine, string> = {
  individual_tax: 'Individual tax',
  business_tax: 'Business tax',
  recurring_accounting: 'Recurring accounting',
  setup_conversion: 'Setup and conversion',
  software_passthrough: 'Software pass-through',
  filings_1099_w2: '1099 / W-2 filings',
  entity_services: 'Entity services',
  attest: 'Attest',
  specialized_cpa: 'Specialized CPA',
  coo: 'COO services',
};
