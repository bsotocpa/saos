// Catalog groups for the quote builder (Brian, 2026-09-20).
//
// A group and a sort position are PRESENTATION metadata on the item — how the builder lays the
// book out for a person — not a fact about a price. They live on price_book_items as group_key
// and sort_order, and a change to them is never a new price-book version: migration 0116 wrote
// them onto every version's rows by item_code, and this file sets them on fresh rows the seed
// inserts. Editing this file does not touch an existing row (the price-book seed is INSERT ONLY);
// a re-grouping of a live book is its own data migration, the way 0116 was.
//
// The nine groups, in the order the builder lists them when nothing about the client is known.
// `fits` is which client type the group belongs to: the builder lists the groups fitting the
// chosen type first (business or individual), then the rest.
export const GROUPS = [
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

// Every item code in the book, its group and its position inside the group. A code with a
// `note` is one the ruled list did not name: it sits in the closest group, and the note says
// why; the report table (scripts/price-book-groups-report.mjs) prints the notes.
const g = (group, sort, note) => (note ? { group, sort, note } : { group, sort });

export const ITEM_GROUPS = {
  // Business returns: 1120-S, 1120, 1065, 990/990-EZ, 1120-C, 1120-F, 1120-H, 1120-POL, Schedule C.
  BIZ_1120S: g('business_returns', 10),
  BIZ_1120: g('business_returns', 20),
  BIZ_1065: g('business_returns', 30),
  BIZ_990: g('business_returns', 40),
  BIZ_1120C: g('business_returns', 50),
  BIZ_1120F: g('business_returns', 60),
  BIZ_1120H: g('business_returns', 70),
  BIZ_1120POL: g('business_returns', 80),
  BIZ_SCH_C: g('business_returns', 90),
  DEPOSIT_BUSINESS_TAX: g('business_returns', 900, 'fits none: a retired deposit item, inactive and never offered; kept only because accepted quotes are price-locked to it'),

  // Business add-ons: additional state, amended return, notice support, S corp conversion.
  BIZ_ADDL_STATE: g('business_addons', 10),
  BIZ_AMENDMENT: g('business_addons', 20),
  BIZ_NOTICE_SUPPORT: g('business_addons', 30),
  SCORP_CONVERSION_2553: g('business_addons', 40),

  // Individual returns: Single, MFJ, MFS, HOH.
  IND_BASE_SINGLE: g('individual_returns', 10),
  IND_BASE_MFJ: g('individual_returns', 20),
  IND_BASE_MFS: g('individual_returns', 30),
  IND_BASE_HOH: g('individual_returns', 40),
  DEPOSIT_1040: g('individual_returns', 900, 'fits none: a retired deposit item, inactive and never offered; kept only because accepted quotes are price-locked to it'),

  // Individual schedules and forms: additional state, C, A, B/D, E rental, E K-1, H, EIC, 8863, 8995.
  IND_ADDL_STATE: g('individual_forms', 10),
  IND_SCH_C: g('individual_forms', 20),
  IND_SCH_A: g('individual_forms', 30),
  IND_SCH_B_D: g('individual_forms', 40),
  IND_SCH_E_RENTAL: g('individual_forms', 50),
  IND_SCH_E_K1: g('individual_forms', 60),
  IND_SCH_H: g('individual_forms', 70),
  IND_SCH_EIC: g('individual_forms', 80),
  IND_F8863: g('individual_forms', 90),
  IND_F8995: g('individual_forms', 100),
  IND_F4562: g('individual_forms', 110, 'not named in the ruled list; a form on the individual return'),
  IND_F2441: g('individual_forms', 120, 'not named in the ruled list; a form on the individual return'),
  IND_F8812: g('individual_forms', 130, 'not named in the ruled list; a form on the individual return'),
  IND_F5695: g('individual_forms', 140, 'not named in the ruled list; a form on the individual return'),
  IND_F8949_121: g('individual_forms', 150, 'not named in the ruled list; a form on the individual return'),
  IND_F8936: g('individual_forms', 160, 'not named in the ruled list; a form on the individual return'),
  IND_NOL: g('individual_forms', 170, 'not named in the ruled list; a carryover computed on the individual return'),
  IND_W7_ITIN: g('individual_forms', 180, 'not named in the ruled list; a form filed with the individual return'),
  IND_W7_ITIN_ADDL: g('individual_forms', 190, 'not named in the ruled list; a form filed with the individual return'),
  PRIOR_YEAR_SURCHARGE: g('individual_forms', 200, 'fits none: a per-return surcharge applied automatically to any return more than two years back; listed with the individual forms because it is priced per form'),
  IND_AMENDMENT_1040X: g('individual_forms', 210, 'fits none: the individual counterpart of the business add-ons (amended return); no individual add-ons group was ruled'),
  IND_NOTICE_SUPPORT: g('individual_forms', 220, 'fits none: the individual counterpart of the business add-ons (notice support); no individual add-ons group was ruled'),
  IND_AUDIT_DEFENSE: g('individual_forms', 230, 'fits none: the individual counterpart of the business add-ons (audit defense); no individual add-ons group was ruled'),

  // Entity and compliance: formation with EIN, 1023, annual report, entity amendment, DBA, BOI.
  ENTITY_FORMATION_EIN: g('entity_compliance', 10),
  ENTITY_501C3_1023: g('entity_compliance', 20),
  ENTITY_ANNUAL_REPORT: g('entity_compliance', 30),
  ENTITY_AMENDMENT: g('entity_compliance', 40),
  ENTITY_DBA: g('entity_compliance', 50),
  ENTITY_BOI: g('entity_compliance', 60),

  // Information returns: 1099/W-2 base, 1099/W-2 per form.
  FILING_1099_W2_BASE: g('information_returns', 10),
  FILING_1099_W2_PER_FORM: g('information_returns', 20),

  // Assurance and audits: review/audit rung, financial statement review and audit, workers comp audit.
  SCOPE_REVIEW_AUDIT: g('assurance', 10),
  ATTEST_REVIEW: g('assurance', 20),
  ATTEST_AUDIT: g('assurance', 30),
  ATTEST_WC_INS_AUDIT: g('assurance', 40),

  // Advisory: COO services.
  COO_UNIT: g('advisory', 10),
  SPEC_TAX_PLANNING: g('advisory', 20, 'not named in the ruled list; specialized CPA advisory work'),
  SPEC_FORECASTING_BUDGETING: g('advisory', 30, 'not named in the ruled list; specialized CPA advisory work'),
  SPEC_LOAN_DUE_DILIGENCE: g('advisory', 40, 'not named in the ruled list; specialized CPA advisory work'),
  SPEC_CPA_CONFIRMATION_LETTERS: g('advisory', 50, 'not named in the ruled list; specialized CPA advisory work'),
  IND_CPA_LETTER: g('advisory', 60, 'not named in the ruled list; CPA letters and tax planning for an individual, closest to the advisory work'),
  IND_SPECIALIZED_HOURLY: g('advisory', 70, 'not named in the ruled list; specialized hourly work for an individual, closest to the advisory work'),
  RES_PENALTY_ABATEMENT: g('advisory', 80, 'fits none: tax resolution work under the specialized CPA line; closest to advisory'),
  RES_INSTALLMENT_AGREEMENT: g('advisory', 90, 'fits none: tax resolution work under the specialized CPA line; closest to advisory'),
  LATE_FEE_MONTHLY: g('advisory', 900, 'fits none: a rate on past-due balances, never offered on a quote; filed with its service line (specialized CPA)'),

  // Recurring services: the accounting plans, payroll and sales tax, and what stands them up.
  ACCT_WEEKLY: g('recurring', 10),
  ACCT_MONTHLY: g('recurring', 20),
  ACCT_QUARTERLY: g('recurring', 30),
  ACCT_SEMI_ANNUAL: g('recurring', 40),
  SCOPE_FULLMGMT_PAYROLL: g('recurring', 50),
  SCOPE_FULLMGMT_SALES_TAX: g('recurring', 60),
  SALES_TAX_ST1_FILING: g('recurring', 70),
  SCOPE_REG_SETUP: g('recurring', 80),
  SCOPE_ADMIN_TRAINING: g('recurring', 90),
  SETUP_QBO: g('recurring', 100, 'not named in the ruled list; stands up the recurring accounting stack'),
  SETUP_PAYROLL: g('recurring', 110, 'not named in the ruled list; stands up the recurring payroll stack'),
  PASS_QBO: g('recurring', 120, 'not named in the ruled list; a monthly software pass-through billed alongside the recurring plan'),
  PASS_QBO_PAYROLL: g('recurring', 130, 'not named in the ruled list; a monthly software pass-through billed alongside the recurring plan'),
  ACCT_CATCHUP_HOURLY: g('recurring', 140, 'fits none: one-time bookkeeping catch-up, hourly; closest to the recurring accounting it precedes'),
  RES_BOOKS_RECONSTRUCTION: g('recurring', 150, 'fits none: one-time books reconstruction for a resolution year; closest to the recurring accounting it precedes'),
  ACCT_PREP_WEEKLY: g('recurring', 900, 'fits none: a derivation component, never offered on a quote (display_on_quote false)'),
  ACCT_PREP_MONTHLY: g('recurring', 910, 'fits none: a derivation component, never offered on a quote (display_on_quote false)'),
  ACCT_PREP_QUARTERLY: g('recurring', 920, 'fits none: a derivation component, never offered on a quote (display_on_quote false)'),
  ACCT_PREP_SEMI_ANNUAL: g('recurring', 930, 'fits none: a derivation component, never offered on a quote (display_on_quote false)'),
  CPA_SESSION: g('recurring', 940, 'fits none: a derivation component, never offered on a quote (display_on_quote false)'),
};

/** The group and sort position for an item code; throws on a code this file does not know. */
export function groupFor(itemCode) {
  const entry = ITEM_GROUPS[itemCode];
  if (!entry) throw new Error(`price_book_groups: no group for ${itemCode} — add it to ITEM_GROUPS`);
  return entry;
}
