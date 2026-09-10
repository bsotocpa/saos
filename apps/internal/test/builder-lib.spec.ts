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
  assert.deepEqual(picked, [{ itemCode: 'IND_1040', quantity: 1, isOptional: false }]);
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
  assert.deepEqual(builderSummary(picked, catalog), { lineCount: 0, committedCents: 0, committedMinCents: 0, committedMaxCents: 0, hasRange: false, depositCents: null });
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
