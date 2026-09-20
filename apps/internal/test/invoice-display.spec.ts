// The Ops invoice card, as text (2026-09-09, Brian's ruling): one client with paid, void,
// refunded and partially refunded invoices, each reading correctly. The page has no render
// harness; the formatter is pure and this is what the page prints.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badgeToneFor, invoiceStatusLine } from '../lib/invoice-display.ts';

const fmt = { money: (c: number) => `$${(c / 100).toFixed(2)}`, date: (iso: string) => iso.slice(0, 10) };

test('paid reads paid, with the ok badge', () => {
  const line = invoiceStatusLine({ invoice_number: 'SX-1', status: 'paid', total_cents: 2000, amount_paid_cents: 2000 }, fmt);
  assert.equal(line, 'paid');
  assert.equal(badgeToneFor('paid'), 'ok');
});

test('void reads "void · reason · actor · date"', () => {
  const line = invoiceStatusLine(
    { invoice_number: 'SX-2', status: 'void', total_cents: 20000, amount_paid_cents: 0, void_reason: 'testing testing testing', voided_by: 'brian@sotoaccounting.com', voided_at: '2026-09-09T08:56:14.294Z' },
    fmt
  );
  assert.equal(line, 'void · testing testing testing · brian@sotoaccounting.com · 2026-09-09');
  assert.equal(badgeToneFor('void'), '');
});

test('refunded reads the refunded amount and date', () => {
  const line = invoiceStatusLine(
    { invoice_number: 'SX-3', status: 'refunded', total_cents: 2000, amount_paid_cents: 2000, amount_refunded_cents: 2000, refunded_at: '2026-09-09T09:07:57.126Z' },
    fmt
  );
  assert.equal(line, 'refunded · $20.00 · 2026-09-09');
  assert.equal(badgeToneFor('refunded'), 'warn');
});

test('partially refunded reads "$X of $Y"', () => {
  const line = invoiceStatusLine(
    { invoice_number: 'SX-4', status: 'partially_refunded', total_cents: 2000, amount_paid_cents: 2000, amount_refunded_cents: 500, refunded_at: '2026-09-09T09:07:57.126Z' },
    fmt
  );
  assert.equal(line, 'partially refunded $5.00 of $20.00 · 2026-09-09');
});

test('a void row with nothing recorded says so instead of printing blanks', () => {
  const line = invoiceStatusLine({ invoice_number: 'SX-5', status: 'void', total_cents: 100, amount_paid_cents: 0 }, fmt);
  // No money record reads "unknown" (2026-09-10): an unrecorded actor says where to look.
  assert.equal(line, 'void · (no reason recorded) · actor not recorded — see the audit log · (date unknown)');
});

// R29 (2026-09-20): a refund made through the Ops door reads like a void — amount, reason, actor,
// date — and a refund that arrived FROM Stripe carries neither reason nor actor and must not print
// a blank or an "unknown" where the person would be.
test('a refund made in Ops reads the amount, the reason and the person', () => {
  const line = invoiceStatusLine(
    {
      invoice_number: 'SX-6', status: 'partially_refunded', total_cents: 20000, amount_paid_cents: 20000,
      amount_refunded_cents: 5000, refunded_at: '2026-09-20T14:02:00.000Z',
      refund_reason: 'the client cancelled the quarter before it started',
      refunded_by: 'Synthetic Rene',
    },
    fmt
  );
  assert.equal(line, 'partially refunded $50.00 of $200.00 · the client cancelled the quarter before it started · Synthetic Rene · 2026-09-20');
  assert.doesNotMatch(line, /@/, 'a name, never an email');
});

test('a refund that came from Stripe leaves the reason and the actor out rather than printing blanks', () => {
  const line = invoiceStatusLine(
    {
      invoice_number: 'SX-7', status: 'refunded', total_cents: 2000, amount_paid_cents: 2000,
      amount_refunded_cents: 2000, refunded_at: '2026-09-20T14:02:00.000Z',
      refund_reason: 'requested_by_customer', refunded_by: null,
    },
    fmt
  );
  // Stripe's own enum is the only "reason" a dashboard refund has, and there is no person at all.
  assert.equal(line, 'refunded · $20.00 · requested_by_customer · 2026-09-20');
});
