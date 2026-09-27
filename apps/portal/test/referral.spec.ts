// R75 (2026-09-27): the Hilo referral discount on the proposal. The server wrote it over the included
// lines; a ticked add-on it reaches takes it too, as acceptance recomputes it (one rounding over the sum).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { referralCentsWithTicks, referralRowText, type ReferralLine, type ReferralOnQuote } from '../lib/referral.ts';

const lines: ReferralLine[] = [
  { item_code: 'IND_1040', line_cents: 30001, is_optional: false, is_pass_through: false, referral_reached: true },
  { item_code: 'BK_MONTHLY', line_cents: 40000, is_optional: false, is_pass_through: false, referral_reached: false },
  { item_code: 'IND_ADDL_STATE', line_cents: 15001, is_optional: true, is_pass_through: false, referral_reached: true },
  { item_code: 'BK_CLEANUP', line_cents: 50000, is_optional: true, is_pass_through: false, referral_reached: false },
  { item_code: 'SW_QBO', line_cents: 9000, is_optional: true, is_pass_through: true, referral_reached: true },
];
const hilo: ReferralOnQuote = { labelEn: 'Hilo referral discount', labelEs: 'Descuento por referencia de Hilo', rate: 50, cents: 15001 };

test('no discount on the quote: nothing to show', () => {
  assert.equal(referralCentsWithTicks(lines, null, { IND_ADDL_STATE: true }), 0);
});

test('nothing ticked: the server\'s figure, untouched', () => {
  assert.equal(referralCentsWithTicks(lines, hilo, {}), 15001);
  assert.equal(referralCentsWithTicks(lines, hilo, { BK_CLEANUP: true, SW_QBO: true }), 15001, 'an add-on it does not reach, and a pass-through, change nothing');
});

test('a ticked add-on it reaches takes the rate, rounded once over the sum as acceptance does', () => {
  // round((30001 + 15001) × 0.5) = 22501, where adding round(15001 × 0.5) = 7501 would read 22502.
  assert.equal(referralCentsWithTicks(lines, hilo, { IND_ADDL_STATE: true }), 22501);
});

test('the row reads the book\'s label in the client\'s language, with the rate', () => {
  assert.equal(referralRowText(hilo, 'en'), 'Hilo referral discount (50%)');
  assert.equal(referralRowText(hilo, 'es'), 'Descuento por referencia de Hilo (50%)');
});
