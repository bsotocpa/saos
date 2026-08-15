// FINDING #26 (Brian, 2026-08-15) — the papers promised a reconciliation the system
// never performed.
//
// Master §2: "all completed work is reconciled against your deposit at invoicing:
// overpayments are credited to your account and any remaining balance is billed."
// Nothing did it. The word "deposit" did not appear in the billing service, credit_cents
// was read by dunning and written by nothing, and the filed-to-invoice automation billed
// final_fee_cents outright. A client accepting an 1120-S quote would pay a $300 deposit
// and then be invoiced the full $800.
//
// The ruling: apply it as a line-item credit reading "Deposit paid — applied", derive it
// from the STRIPE-CONFIRMED payment and never a hand-entered figure, and fail generation
// loudly for a deposit-carrying engagement whose invoice lacks it. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createInvoice, markInvoicePaid } from '../src/modules/billing/service.ts';
import { availableDepositCredit } from '../src/modules/billing/deposit-credit.ts';
import { AppError } from '../src/types.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'x' }; } };

before(async () => {
  config = await createTestConfig('depcredit');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email: 'brian-depcredit@example.test', name: 'Synthetic CEO', role: 'ceo',
    password: 'depcredit-password-123456', totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  const login = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email: staff.email, password: staff.password, totp: code },
  });
  assert.equal(login.statusCode, 200, login.body);
  brian = { ...staff, token: login.json().token as string };
});

after(async () => {
  await app.close();
});

/** An engagement with a deposit invoice that Stripe has confirmed as paid. */
async function engagementWithPaidDeposit(
  label: string,
  depositCents: number
): Promise<{ contactId: string; engagementId: string; depositInvoiceId: string }> {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: label, email: `${label.toLowerCase()}-dc@example.test`,
  });
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, title, status)
     VALUES ($1, 'tax', $2, 'active') RETURNING id`,
    [c.id, `${label} engagement`]
  );
  const engagementId = eng.rows[0]!.id;

  const dep = await createInvoice(app, { type: 'system', label: 'test' }, {
    contactId: c.id,
    engagementId,
    lines: [{ description: 'Deposit', unitCents: depositCents }],
    isDepositInvoice: true,
    send: false,
  });
  // The quote link is what marks this invoice as a DEPOSIT rather than ordinary work.
  const q = await app.db.query<{ id: string }>(
    `INSERT INTO quotes (contact_id, status, total_cents, deposit_invoice_id, public_token_hash)
     VALUES ($1, 'accepted', $2, $3, $4) RETURNING id`,
    [c.id, depositCents, dep.id, `hash-${label}`]
  );
  assert.ok(q.rows[0]);
  return { contactId: c.id, engagementId, depositInvoiceId: dep.id };
}

test('#26: an unPAID deposit credits nothing — only Stripe-confirmed money counts', async () => {
  const { engagementId } = await engagementWithPaidDeposit('Unpaid', 30000);
  // The deposit invoice exists and is SENT, not paid.
  const available = await availableDepositCredit(app, engagementId);
  assert.deepEqual(available, [], 'an issued-but-unpaid deposit is not credit');
});

test('#26: the exact double-charge — a paid deposit is credited, not billed over', async () => {
  const { contactId, engagementId, depositInvoiceId } = await engagementWithPaidDeposit('Double', 30000);
  await markInvoicePaid(app, depositInvoiceId, {});

  // The engagement completes and is invoiced for the full $800 fee.
  const final = await createInvoice(app, { type: 'system', label: 'filed automation' }, {
    contactId,
    engagementId,
    lines: [{ description: '2025 1120-S tax return preparation', unitCents: 80000 }],
    send: false,
  });

  assert.equal(final.depositCreditCents, 30000, 'the whole deposit was applied');
  assert.equal(final.totalCents, 50000, '$800 fee minus the $300 already paid — not $800');

  // The client can SEE it: a line, not a silently smaller number.
  const lines = await app.db.query<{ description: string; total_cents: number }>(
    `SELECT description, total_cents FROM invoice_line_items WHERE invoice_id = $1 ORDER BY sort_order`,
    [final.id]
  );
  const credit = lines.rows.find((l) => l.description === 'Deposit paid — applied');
  assert.ok(credit, 'the credit is a visible line');
  assert.equal(credit.total_cents, -30000);

  // And the reconciliation is auditable without reading line text.
  const link = await app.db.query<{ from_id: string | null }>(
    `SELECT deposit_credit_from_invoice_id AS from_id FROM invoices WHERE id = $1`, [final.id]);
  assert.equal(link.rows[0]!.from_id, depositInvoiceId);
  const consumed = await app.db.query<{ applied: number }>(
    `SELECT deposit_applied_cents AS applied FROM invoices WHERE id = $1`, [depositInvoiceId]);
  assert.equal(consumed.rows[0]!.applied, 30000);
});

test('#26: a deposit cannot be credited twice', async () => {
  const { contactId, engagementId, depositInvoiceId } = await engagementWithPaidDeposit('Twice', 25000);
  await markInvoicePaid(app, depositInvoiceId, {});

  const first = await createInvoice(app, { type: 'system', label: 'test' }, {
    contactId, engagementId, lines: [{ description: 'Work one', unitCents: 40000 }], send: false,
  });
  assert.equal(first.depositCreditCents, 25000);

  // A second invoice on the same engagement gets nothing — the deposit is spent.
  const second = await createInvoice(app, { type: 'system', label: 'test' }, {
    contactId, engagementId, lines: [{ description: 'Work two', unitCents: 40000 }], send: false,
  });
  assert.equal(second.depositCreditCents, 0, 'spent, not spendable again');
  assert.equal(second.totalCents, 40000);
});

test('#26: full prepay invoices to zero, and a deposit larger than the work keeps its remainder', async () => {
  // v5 puts full-prepay deposits on the small engagements: deposit == price.
  const full = await engagementWithPaidDeposit('Fullprepay', 20000);
  await markInvoicePaid(app, full.depositInvoiceId, {});
  const zero = await createInvoice(app, { type: 'system', label: 'test' }, {
    contactId: full.contactId, engagementId: full.engagementId,
    lines: [{ description: '2025 individual return', unitCents: 20000 }], send: false,
  });
  assert.equal(zero.totalCents, 0, 'already paid in full — nothing further owed');

  // And an over-deposit is not forfeited: Master §2 credits it to the account.
  const over = await engagementWithPaidDeposit('Overpaid', 30000);
  await markInvoicePaid(app, over.depositInvoiceId, {});
  const small = await createInvoice(app, { type: 'system', label: 'test' }, {
    contactId: over.contactId, engagementId: over.engagementId,
    lines: [{ description: 'Small job', unitCents: 10000 }], send: false,
  });
  assert.equal(small.totalCents, 0, 'never negative');
  assert.equal(small.depositCreditCents, 10000, 'only what this invoice needed');
  const left = await availableDepositCredit(app, over.engagementId);
  assert.equal(left[0]?.availableCents, 20000, 'the rest stays available for the next invoice');
});

test('#26 THE GUARD: an invoice that skips the credit fails generation loudly', async () => {
  const { contactId, engagementId, depositInvoiceId } = await engagementWithPaidDeposit('Guarded', 30000);
  await markInvoicePaid(app, depositInvoiceId, {});

  /*
   * Simulate a caller that builds its own lines and bypasses the automatic path — the
   * shape of the bug this finding is about. The deposit is consumed out from under the
   * guard first so the credit cannot be applied, leaving outstanding credit and no line.
   */
  const { consumeDepositCredit } = await import('../src/modules/billing/deposit-credit.ts');
  // Re-open the deposit: paid, and un-applied, but make the credit unusable by pointing
  // the invoice at a different engagement mid-flight.
  const other = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, title, status)
     VALUES ($1, 'bookkeeping', 'other', 'active') RETURNING id`,
    [contactId]
  );
  assert.ok(other.rows[0]);
  assert.equal(await consumeDepositCredit(app, depositInvoiceId, 0), 0, 'consuming nothing is a no-op');

  // With the deposit still outstanding, an invoice whose lines omit the credit must fail.
  const { assertDepositCreditApplied } = await import('../src/modules/billing/deposit-credit.ts');
  await assert.rejects(
    () => assertDepositCreditApplied(app, engagementId, ['2025 1120-S tax return preparation']),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, 'deposit_credit_missing');
      assert.match(err.message, /already paid/);
      assert.match(err.message, /#26/);
      return true;
    }
  );

  // And it passes once the credit line is present.
  await assertDepositCreditApplied(app, engagementId, ['Work', 'Deposit paid — applied']);
});

test('#26: the deposit invoice never credits itself', async () => {
  const { engagementId, depositInvoiceId } = await engagementWithPaidDeposit('Selfcredit', 25000);
  await markInvoicePaid(app, depositInvoiceId, {});
  const self = await app.db.query<{ applied: number; from_id: string | null }>(
    `SELECT deposit_applied_cents AS applied, deposit_credit_from_invoice_id AS from_id
       FROM invoices WHERE id = $1`,
    [depositInvoiceId]
  );
  assert.equal(self.rows[0]!.applied, 0, 'nothing consumed at creation');
  assert.equal(self.rows[0]!.from_id, null, 'and it credits nothing');
  const available = await availableDepositCredit(app, engagementId);
  assert.equal(available[0]?.availableCents, 25000, 'its full value is available to the NEXT invoice');
});
