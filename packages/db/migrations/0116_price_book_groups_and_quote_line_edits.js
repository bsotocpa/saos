/**
 * 0116 — The quote builder redesign (Brian, 2026-09-20): catalog groups on the price-book item,
 * and quote lines that can be priced off the book or written by hand.
 *
 * 1. GROUPS ARE PRESENTATION METADATA ON THE ITEM, NOT A PRICE-BOOK VERSION CHANGE. A group and a
 *    sort position say how the builder lays the book out for a person; they say nothing about a
 *    price. So this migration writes group_key and sort_order onto EVERY version's row for each
 *    item_code — a quote pinned to v1 and one written under the version in force lay out the same
 *    way — and no new price_book_versions row is created here or by the seed. The mapping below is
 *    a frozen copy of packages/db/seeds/data/price_book_groups.mjs as it stood the day this ran; the
 *    seed keeps the live copy for fresh rows, and a later re-grouping is its own data migration.
 *
 * 2. A QUOTE LINE MAY CARRY A PRICE THAT IS NOT THE BOOK'S. unit_cents already held a copy of the
 *    book price; it may now differ from it, and the book price is read back by joining the quote's
 *    pinned version on item_code (never stored twice). The reason for the difference is one text on
 *    the quote for all its lines, and the audit row `quote.prices_changed` lists each changed line.
 *
 * 3. A CUSTOM LINE has no item in the book: is_custom marks it, service_line names the work it
 *    belongs to (the engagement derivation reads it where the book's classification would have
 *    been), and its item_code is a CUSTOM_ prefix plus a random suffix so it can never collide with
 *    a book code.
 *
 * Every statement runs through pgm.db.query in order (lesson of 2026-09-13: pgm.sql is queued until
 * the function returns, so a data UPDATE after a queued ADD COLUMN finds no column).
 */

const GROUP_KEYS = ['business_returns', 'business_addons', 'individual_returns', 'individual_forms', 'entity_compliance', 'information_returns', 'assurance', 'advisory', 'recurring'];

// item_code, group_key, sort_order — frozen from price_book_groups.mjs on 2026-09-20.
const PLACEMENTS = [
    ['BIZ_1120S', 'business_returns', 10],
    ['BIZ_1120', 'business_returns', 20],
    ['BIZ_1065', 'business_returns', 30],
    ['BIZ_990', 'business_returns', 40],
    ['BIZ_1120C', 'business_returns', 50],
    ['BIZ_1120F', 'business_returns', 60],
    ['BIZ_1120H', 'business_returns', 70],
    ['BIZ_1120POL', 'business_returns', 80],
    ['BIZ_SCH_C', 'business_returns', 90],
    ['DEPOSIT_BUSINESS_TAX', 'business_returns', 900],
    ['BIZ_ADDL_STATE', 'business_addons', 10],
    ['BIZ_AMENDMENT', 'business_addons', 20],
    ['BIZ_NOTICE_SUPPORT', 'business_addons', 30],
    ['SCORP_CONVERSION_2553', 'business_addons', 40],
    ['IND_BASE_SINGLE', 'individual_returns', 10],
    ['IND_BASE_MFJ', 'individual_returns', 20],
    ['IND_BASE_MFS', 'individual_returns', 30],
    ['IND_BASE_HOH', 'individual_returns', 40],
    ['DEPOSIT_1040', 'individual_returns', 900],
    ['IND_ADDL_STATE', 'individual_forms', 10],
    ['IND_SCH_C', 'individual_forms', 20],
    ['IND_SCH_A', 'individual_forms', 30],
    ['IND_SCH_B_D', 'individual_forms', 40],
    ['IND_SCH_E_RENTAL', 'individual_forms', 50],
    ['IND_SCH_E_K1', 'individual_forms', 60],
    ['IND_SCH_H', 'individual_forms', 70],
    ['IND_SCH_EIC', 'individual_forms', 80],
    ['IND_F8863', 'individual_forms', 90],
    ['IND_F8995', 'individual_forms', 100],
    ['IND_F4562', 'individual_forms', 110],
    ['IND_F2441', 'individual_forms', 120],
    ['IND_F8812', 'individual_forms', 130],
    ['IND_F5695', 'individual_forms', 140],
    ['IND_F8949_121', 'individual_forms', 150],
    ['IND_F8936', 'individual_forms', 160],
    ['IND_NOL', 'individual_forms', 170],
    ['IND_W7_ITIN', 'individual_forms', 180],
    ['IND_W7_ITIN_ADDL', 'individual_forms', 190],
    ['PRIOR_YEAR_SURCHARGE', 'individual_forms', 200],
    ['IND_AMENDMENT_1040X', 'individual_forms', 210],
    ['IND_NOTICE_SUPPORT', 'individual_forms', 220],
    ['IND_AUDIT_DEFENSE', 'individual_forms', 230],
    ['ENTITY_FORMATION_EIN', 'entity_compliance', 10],
    ['ENTITY_501C3_1023', 'entity_compliance', 20],
    ['ENTITY_ANNUAL_REPORT', 'entity_compliance', 30],
    ['ENTITY_AMENDMENT', 'entity_compliance', 40],
    ['ENTITY_DBA', 'entity_compliance', 50],
    ['ENTITY_BOI', 'entity_compliance', 60],
    ['FILING_1099_W2_BASE', 'information_returns', 10],
    ['FILING_1099_W2_PER_FORM', 'information_returns', 20],
    ['SCOPE_REVIEW_AUDIT', 'assurance', 10],
    ['ATTEST_REVIEW', 'assurance', 20],
    ['ATTEST_AUDIT', 'assurance', 30],
    ['ATTEST_WC_INS_AUDIT', 'assurance', 40],
    ['COO_UNIT', 'advisory', 10],
    ['SPEC_TAX_PLANNING', 'advisory', 20],
    ['SPEC_FORECASTING_BUDGETING', 'advisory', 30],
    ['SPEC_LOAN_DUE_DILIGENCE', 'advisory', 40],
    ['SPEC_CPA_CONFIRMATION_LETTERS', 'advisory', 50],
    ['IND_CPA_LETTER', 'advisory', 60],
    ['IND_SPECIALIZED_HOURLY', 'advisory', 70],
    ['RES_PENALTY_ABATEMENT', 'advisory', 80],
    ['RES_INSTALLMENT_AGREEMENT', 'advisory', 90],
    ['LATE_FEE_MONTHLY', 'advisory', 900],
    ['ACCT_WEEKLY', 'recurring', 10],
    ['ACCT_MONTHLY', 'recurring', 20],
    ['ACCT_QUARTERLY', 'recurring', 30],
    ['ACCT_SEMI_ANNUAL', 'recurring', 40],
    ['SCOPE_FULLMGMT_PAYROLL', 'recurring', 50],
    ['SCOPE_FULLMGMT_SALES_TAX', 'recurring', 60],
    ['SALES_TAX_ST1_FILING', 'recurring', 70],
    ['SCOPE_REG_SETUP', 'recurring', 80],
    ['SCOPE_ADMIN_TRAINING', 'recurring', 90],
    ['SETUP_QBO', 'recurring', 100],
    ['SETUP_PAYROLL', 'recurring', 110],
    ['PASS_QBO', 'recurring', 120],
    ['PASS_QBO_PAYROLL', 'recurring', 130],
    ['ACCT_CATCHUP_HOURLY', 'recurring', 140],
    ['RES_BOOKS_RECONSTRUCTION', 'recurring', 150],
    ['ACCT_PREP_WEEKLY', 'recurring', 900],
    ['ACCT_PREP_MONTHLY', 'recurring', 910],
    ['ACCT_PREP_QUARTERLY', 'recurring', 920],
    ['ACCT_PREP_SEMI_ANNUAL', 'recurring', 930],
    ['CPA_SESSION', 'recurring', 940],
];

exports.up = async (pgm) => {
  const q = (sql, params) => pgm.db.query(sql, params);

  await q(`ALTER TABLE price_book_items ADD COLUMN group_key text`);
  const known = GROUP_KEYS.map((k) => `'${k}'`).join(', ');
  await q(`ALTER TABLE price_book_items ADD CONSTRAINT price_book_items_group_key_known
             CHECK (group_key IS NULL OR group_key IN (${known}))`);
  await q(`COMMENT ON COLUMN price_book_items.group_key IS
    'Catalog group for the quote builder (2026-09-20). Presentation metadata, written onto every version''s row for the item_code; never a reason for a new price-book version. Keys: ${GROUP_KEYS.join(', ')}.'`);
  await q(`COMMENT ON COLUMN price_book_items.sort_order IS
    'Position inside group_key (2026-09-20). Presentation metadata, written onto every version''s row for the item_code, exactly like group_key.'`);

  // Every version's row for each code: a quote pinned to an old version lays out the same way.
  for (const [code, group, sort] of PLACEMENTS) {
    await q(`UPDATE price_book_items SET group_key = $1, sort_order = $2 WHERE item_code = $3`, [group, sort, code]);
  }

  await q(`ALTER TABLE quote_line_items
             ADD COLUMN is_custom boolean NOT NULL DEFAULT false,
             ADD COLUMN service_line price_service_line`);
  await q(`ALTER TABLE quote_line_items ADD CONSTRAINT quote_line_items_custom_names_its_line
             CHECK (NOT is_custom OR service_line IS NOT NULL)`);
  await q(`ALTER TABLE quote_line_items ADD CONSTRAINT quote_line_items_custom_code_prefix
             CHECK (is_custom = (item_code LIKE 'CUSTOM_%'))`);
  await q(`COMMENT ON COLUMN quote_line_items.is_custom IS
    'A line written by hand on the quote (2026-09-20): no price-book item behind it, its amount typed by staff under the quote''s price_change_reason, its service_line naming the work.'`);
  await q(`COMMENT ON COLUMN quote_line_items.service_line IS
    'The service line of a custom line. NULL on a book line, whose service line is the book''s at the quote''s pinned version.'`);

  await q(`ALTER TABLE quotes ADD COLUMN price_change_reason text`);
  await q(`COMMENT ON COLUMN quotes.price_change_reason IS
    'One standalone reason for every line on this quote priced off the book, including custom lines (2026-09-20). NULL when every line is at its book price. The audit row quote.prices_changed lists the lines.'`);
};

exports.down = async (pgm) => {
  const q = (sql) => pgm.db.query(sql);
  await q(`ALTER TABLE quotes DROP COLUMN IF EXISTS price_change_reason`);
  await q(`ALTER TABLE quote_line_items DROP CONSTRAINT IF EXISTS quote_line_items_custom_code_prefix`);
  await q(`ALTER TABLE quote_line_items DROP CONSTRAINT IF EXISTS quote_line_items_custom_names_its_line`);
  await q(`ALTER TABLE quote_line_items DROP COLUMN IF EXISTS service_line, DROP COLUMN IF EXISTS is_custom`);
  await q(`ALTER TABLE price_book_items DROP CONSTRAINT IF EXISTS price_book_items_group_key_known`);
  await q(`ALTER TABLE price_book_items DROP COLUMN IF EXISTS group_key`);
};
