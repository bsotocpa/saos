// Item 13 (2026-09-09): the quote builder's rules, tested as functions — a chip's state matches
// the line's presence; the summary bar's numbers follow every tap; the tax year is labelled
// "default" until chosen and "from interview" when the interview said so.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builderSummary, isPicked, taxYearLabel, taxYearOptions, togglePick, type CatalogLine, type PickedLine } from '../app/pipeline/builder-lib.ts';

const catalog: CatalogLine[] = [
  { item_code: 'IND_1040', amount_cents: 30000, price_min_cents: null, price_max_cents: null, deposit_cents: 10000, is_pass_through: false },
  { item_code: 'BIZ_1120S', amount_cents: null, price_min_cents: 70000, price_max_cents: 90000, deposit_cents: 25000, is_pass_through: false },
  { item_code: 'SOFTWARE', amount_cents: 5000, price_min_cents: null, price_max_cents: null, deposit_cents: null, is_pass_through: true },
];

test('a chip is filled exactly when its line is on the quote, and a tap toggles it', () => {
  let picked: PickedLine[] = [];
  assert.equal(isPicked(picked, 'IND_1040'), false);
  picked = togglePick(picked, 'IND_1040');
  assert.equal(isPicked(picked, 'IND_1040'), true, 'tap: added');
  assert.deepEqual(picked, [{ itemCode: 'IND_1040', quantity: 1, isOptional: false, unitCents: null }]);
  picked = togglePick(picked, 'BIZ_1120S');
  assert.equal(picked.length, 2);
  picked = togglePick(picked, 'IND_1040');
  assert.equal(isPicked(picked, 'IND_1040'), false, 'tap again: removed');
  assert.deepEqual(picked.map((p) => p.itemCode), ['BIZ_1120S']);
  // The invariant, for every item: chip state === line presence.
  for (const i of catalog) assert.equal(isPicked(picked, i.item_code), picked.some((p) => p.itemCode === i.item_code));
});

test('the summary bar follows every tap: deposit, committed total, line count', () => {
  let picked: PickedLine[] = [];
  assert.deepEqual(builderSummary(picked, catalog), { lineCount: 0, committedCents: 0, committedMinCents: 0, committedMaxCents: 0, hasRange: false, depositCents: null, offBook: [] });
  picked = togglePick(picked, 'IND_1040');
  let s = builderSummary(picked, catalog);
  assert.equal(s.lineCount, 1);
  assert.equal(s.committedCents, 30000);
  assert.equal(s.depositCents, 10000);
  picked = togglePick(picked, 'BIZ_1120S');
  s = builderSummary(picked, catalog);
  assert.equal(s.lineCount, 2);
  assert.equal(s.hasRange, true, 'a ranged line makes the committed figure a range');
  assert.equal(s.committedMinCents, 100000);
  assert.equal(s.committedMaxCents, 120000);
  assert.equal(s.depositCents, 35000, 'deposits sum per line, the same rule the server resolves');
  picked = togglePick(picked, 'SOFTWARE');
  s = builderSummary(picked, catalog);
  assert.equal(s.lineCount, 3);
  assert.equal(s.committedMaxCents, 120000, 'a pass-through is not a commitment');
  picked = picked.map((p) => (p.itemCode === 'IND_1040' ? { ...p, isOptional: true } : p));
  s = builderSummary(picked, catalog);
  assert.equal(s.committedMinCents, 70000, 'an optional line is not committed');
  assert.equal(s.depositCents, 35000, 'but its deposit still counts — the server sums every chosen line');
});

test('the tax year reads "default" until changed, the year alone once chosen, "from interview" when the interview said so', () => {
  assert.equal(taxYearLabel(2025, 'default'), '2025 (default)');
  assert.equal(taxYearLabel(2024, 'chosen'), '2024');
  assert.equal(taxYearLabel(2023, 'interview'), '2023 (from interview)');
  assert.deepEqual(taxYearOptions(2025), [2026, 2025, 2024, 2023, 2022, 2021]);
});

// ── THE REDESIGNED BUILDER (2026-09-20): grouped rows, the filter, the editable table's numbers ──
import {
  addCustomLine, addLine, builderSummary as summaryOf, isOffBook, lineTotals, matchesFilter, orderGroups,
  packageDiscountCents, parseDollars, quotedRange, showsQuantity, unitWords, type CatalogGroup,
} from '../app/pipeline/builder-lib.ts';

const groups: CatalogGroup[] = [
  { key: 'business_returns', label: 'Business returns', fits: 'business' },
  { key: 'individual_returns', label: 'Individual returns', fits: 'individual' },
  { key: 'advisory', label: 'Advisory', fits: 'both' },
  { key: 'recurring', label: 'Recurring services', fits: 'business' },
];
const rows: CatalogLine[] = [
  { item_code: 'BIZ_1120S', name_en: 'Form 1120-S — S corporation', amount_cents: 70000, price_min_cents: null, price_max_cents: null, deposit_cents: 30000, is_pass_through: false, unit: 'flat', group_key: 'business_returns' },
  { item_code: 'BIZ_ADDL_STATE', name_en: 'Additional state return (business)', amount_cents: 35000, price_min_cents: null, price_max_cents: null, deposit_cents: null, is_pass_through: false, unit: 'per_state', group_key: 'business_addons' },
  { item_code: 'IND_CPA_LETTER', name_en: 'CPA letters', amount_cents: null, price_min_cents: 25000, price_max_cents: 50000, deposit_cents: null, is_pass_through: false, unit: 'flat', group_key: 'advisory' },
];

test('the groups fitting the client type come first, then the rest, each in catalog order', () => {
  assert.deepEqual(orderGroups(groups, 'business').map((g) => g.key), ['business_returns', 'advisory', 'recurring', 'individual_returns']);
  assert.deepEqual(orderGroups(groups, 'individual').map((g) => g.key), ['individual_returns', 'advisory', 'business_returns', 'recurring']);
});

test('the filter matches the name, the form number with its punctuation ignored, the code, and the group', () => {
  const s = rows[0]!;
  assert.equal(matchesFilter(s, 'Business returns', ''), true, 'no filter: everything');
  assert.equal(matchesFilter(s, 'Business returns', '1120-S'), true);
  assert.equal(matchesFilter(s, 'Business returns', '1120s'), true, 'the form number, however typed');
  assert.equal(matchesFilter(s, 'Business returns', 'BIZ_1120S'), true, 'the code');
  assert.equal(matchesFilter(s, 'Business returns', 'corporation'), true, 'a word of the name');
  assert.equal(matchesFilter(s, 'Business returns', 'business ret'), true, 'the group');
  assert.equal(matchesFilter(s, 'Business returns', '1040'), false);
});

test('quantity shows for per-form and per-state units, not for flat or cadence units', () => {
  assert.equal(showsQuantity('per_state'), true);
  assert.equal(showsQuantity('per_form'), true);
  assert.equal(showsQuantity('flat'), false);
  assert.equal(showsQuantity('per_month'), false);
  assert.equal(showsQuantity(null), false);
  assert.equal(unitWords('per_state'), 'per state');
  assert.equal(unitWords('flat'), '');
});

test('dollars typed any which way become cents; nonsense is null', () => {
  assert.equal(parseDollars('400'), 40000);
  assert.equal(parseDollars('$1,250.50'), 125050);
  assert.equal(parseDollars(''), null);
  assert.equal(parseDollars('abc'), null);
});

test('Add puts the line on once at the book price; an amount that differs is off the book; blank puts the book back', () => {
  let picked = addLine([], 'BIZ_ADDL_STATE');
  picked = addLine(picked, 'BIZ_ADDL_STATE');
  assert.equal(picked.length, 1, 'a second Add is a no-op');
  assert.equal(isOffBook(picked[0]!, rows[1]), false, 'at the book');
  assert.deepEqual(lineTotals({ ...picked[0]!, quantity: 2 }, rows[1]), { exactCents: 70000, minCents: null, maxCents: null });
  const edited = { ...picked[0]!, quantity: 2, unitCents: 30000 };
  assert.equal(isOffBook(edited, rows[1]), true);
  assert.equal(lineTotals(edited, rows[1]).exactCents, 60000);
  assert.equal(isOffBook({ ...edited, unitCents: 35000 }, rows[1]), false, 'the book figure typed back is not a change');
  assert.equal(isOffBook({ ...edited, unitCents: null }, rows[1]), false, 'blank: the book stands');
  // A range-priced line: a range until an amount is set.
  const range = addLine([], 'IND_CPA_LETTER')[0]!;
  assert.deepEqual(lineTotals(range, rows[2]), { exactCents: null, minCents: 25000, maxCents: 50000 });
  assert.equal(lineTotals({ ...range, unitCents: 40000 }, rows[2]).exactCents, 40000);
});

test('the summary counts the off-book lines (the reason field shows exactly then) and custom lines are always off the book', () => {
  let picked = addLine([], 'BIZ_1120S');
  assert.equal(summaryOf(picked, rows).offBook.length, 0);
  picked = addCustomLine(picked, { name: 'Board minutes review', serviceLine: 'business_tax', unitCents: 12345 });
  const s = summaryOf(picked, rows);
  assert.equal(s.offBook.length, 1);
  assert.equal(s.committedCents, 70000 + 12345, 'the custom line is in the subtotal');
  assert.equal(s.depositCents, 30000, 'the deposit is the book line\'s');
  assert.match(picked[1]!.itemCode, /^CUSTOM_/);
});

test('the quoted range is the same arithmetic the server does, and a package rule applies to the live subtotal', () => {
  assert.deepEqual(quotedRange(100000, 15, true), { min: 100000, max: 115000 });
  assert.equal(quotedRange(100000, 15, false), null, 'recurring work quotes exact');
  assert.equal(packageDiscountCents({ kind: 'percent', value: 10 }, 100000), 10000);
  assert.equal(packageDiscountCents({ kind: 'fixed', value: 5000 }, 3000), 3000, 'never below zero');
  assert.equal(packageDiscountCents({ kind: 'override', value: 80000 }, 100000), 20000);
  assert.equal(packageDiscountCents({ kind: 'none', value: null }, 100000), 0);
});
