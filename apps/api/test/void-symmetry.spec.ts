// DECISION 3 (2026-09-09, Brian's ruling): void reverses issuance COMPLETELY.
//
// 6e474b1f read "deposit charged" with an amount under a void SA-2026-0002: the void reversed the
// invoice and the tax engagement's billing fields and left the engagement's deposit stamp.
// The stamp is now derived from the record. This spec diffs the rows field by field: after
// a void, the engagement's deposit fields are exactly what they were before acceptance
// stamped them (null), and the invoice differs from its pre-void self ONLY in the void
// fields. The restamp route corrects rows an earlier void left wrong. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createQuote, sendQuote, acceptQuote, overrideQuoteDeposit } from '../src/modules/pricing/quotes.ts';
import { voidInvoice } from '../src/modules/billing/void.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { transferDeposit } from '../src/modules/engagements/deposits.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff & { token: string };
let rene: TestStaff & { token: string };
const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

const DEPOSIT_FIELDS = ['deposit_treatment', 'deposit_standard_cents', 'deposit_charged_cents', 'deposit_override_reason', 'deposit_override_by_staff_id'] as const;
const VOID_FIELDS = new Set(['status', 'void_reason', 'voided_by_staff_id', 'voided_by_label', 'voided_at', 'stripe_checkout_session_id', 'pay_token_revoked_at', 'updated_at']);

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-1234567`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

const actor = () => ({ id: ceo.id, email: ceo.email, fullName: 'Synthetic CEO', roleKey: 'ceo' as const, permissions: ['*'], sessionId: 'test' });

async function depositItem(): Promise<string> {
  const { rows } = await app.db.query<{ item_code: string }>(
    `SELECT pbi.item_code FROM price_book_items pbi JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.deposit_cents > 0 AND pbi.is_active AND pbi.display_on_quote AND pbi.amount_cents IS NOT NULL
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
      ORDER BY pbi.item_code LIMIT 1`);
  return rows[0]!.item_code;
}

let seq = 0;
/** A client with an accepted quote: deposit invoice SENT (unpaid), engagement stamped. */
async function accepted() {
  seq += 1;
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: `Voidsym${seq}`, email: `voidsym-${seq}@example.test` });
  await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [c.id]);
  const q = await createQuote(app, { contactId: c.id, lines: [{ itemCode: await depositItem() }] }, actor());
  const s = await sendQuote(app, q.id, actor());
  const acc = await acceptQuote(app, s.url.split('/').pop()!, {});
  await app.db.query(`UPDATE invoices SET status = 'sent', sent_at = now() WHERE id = $1 AND status = 'draft'`, [acc.depositInvoiceId!]);
  return { contactId: c.id, engagementId: acc.engagementId, depositInvoiceId: acc.depositInvoiceId! };
}

async function row(table: string, id: string): Promise<Record<string, unknown>> {
  return (await app.db.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;
}

before(async () => {
  config = await createTestConfig('voidsym');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  ceo = await staffWithToken('ceo-voidsym@example.test', 'ceo');
  rene = await staffWithToken('rene-voidsym@example.test', 'comms_billing');
});

after(async () => {
  await app.close();
});

test('void is symmetric with issuance: the engagement deposit stamp returns to its pre-acceptance state, field by field', async () => {
  const x = await accepted();
  const stamped = await row('engagements', x.engagementId);
  assert.ok(Number(stamped.deposit_charged_cents) > 0, 'acceptance stamped a deposit');
  assert.ok(stamped.deposit_treatment, 'acceptance stamped a treatment');

  const invoiceBefore = await row('invoices', x.depositInvoiceId);
  const r = await voidInvoice(app, x.depositInvoiceId, { reason: 'symmetry test: client changed their mind' }, actor());
  assert.equal(r.invoiceNumber, invoiceBefore.invoice_number);

  // The engagement: every issuance stamp is back to null — the state before acceptance.
  const eng = await row('engagements', x.engagementId);
  for (const f of DEPOSIT_FIELDS) assert.equal(eng[f], null, `${f} reversed`);

  // The invoice: only the void fields moved. Everything else is the pre-void row.
  const invoiceAfter = await row('invoices', x.depositInvoiceId);
  const drifted = Object.keys(invoiceBefore).filter((k) => !VOID_FIELDS.has(k) && String(invoiceBefore[k]) !== String(invoiceAfter[k]));
  assert.deepEqual(drifted, [], `fields that changed on void beyond the void fields: ${drifted.join(', ')}`);
  assert.equal(invoiceAfter.status, 'void');
  assert.equal(invoiceAfter.stripe_checkout_session_id, null);

  // And the audit trail says the stamp was re-derived, with before and after.
  const audit = await app.db.query<{ details: { before: Record<string, unknown>; after: Record<string, unknown> } }>(
    `SELECT details FROM audit_log WHERE action = 'engagement.deposit_restamped' AND object_id = $1`, [x.engagementId]);
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0]!.details.before.deposit_charged_cents, stamped.deposit_charged_cents);
  assert.equal(audit.rows[0]!.details.after.deposit_charged_cents, null);
});

test('the restamp route corrects a row an earlier void left stamped (the 6e474b1f shape), and is a no-op when nothing is wrong', async () => {
  const x = await accepted();
  await voidInvoice(app, x.depositInvoiceId, { reason: 'restamp test' }, actor());
  // Recreate the defect: the stamp the old void used to leave behind.
  await app.db.query(`UPDATE engagements SET deposit_treatment = 'standard', deposit_standard_cents = 20000, deposit_charged_cents = 20000 WHERE id = $1`, [x.engagementId]);

  const fixed = await app.inject({ method: 'POST', url: `/engagements/${x.engagementId}/restamp-deposit`, headers: auth(rene) });
  assert.equal(fixed.statusCode, 200, fixed.body);
  assert.equal(fixed.json().changed, true);
  assert.equal(fixed.json().after.deposit_charged_cents, null);
  const eng = await row('engagements', x.engagementId);
  for (const f of DEPOSIT_FIELDS) assert.equal(eng[f], null, `${f} cleared`);

  const again = await app.inject({ method: 'POST', url: `/engagements/${x.engagementId}/restamp-deposit`, headers: auth(rene) });
  assert.equal(again.json().changed, false, 'nothing to change the second time');
});

test('a transferred deposit re-stamps both engagements from the record', async () => {
  const x = await accepted();
  await app.db.query(`UPDATE invoices SET status = 'paid', amount_paid_cents = total_cents, paid_at = now(), stripe_payment_intent_id = 'pi_voidsym' WHERE id = $1`, [x.depositInvoiceId]);
  const stampedCharge = (await row('engagements', x.engagementId)).deposit_charged_cents;
  const successor = await createEngagement(app, actor(), { contactId: x.contactId, serviceLine: 'bookkeeping', title: 'Successor', status: 'active' }, {});
  assert.equal((await row('engagements', successor.id)).deposit_charged_cents, null, 'successor starts unstamped');

  await transferDeposit(app, { invoiceId: x.depositInvoiceId, toEngagementId: successor.id, reason: 'symmetry: move the deposit' }, { type: 'system', label: 'test' });
  assert.equal((await row('engagements', x.engagementId)).deposit_charged_cents, null, 'the old engagement lost its stamp with its deposit');
  assert.equal((await row('engagements', successor.id)).deposit_charged_cents, stampedCharge, 'the successor carries the stamp the record supports');
});

test('a WAIVED deposit never issued an invoice: the stamp says waived, and a restamp keeps it — nothing was issued, so nothing is reversed', async () => {
  seq += 1;
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: `Waived${seq}`, email: `waived-${seq}@example.test` });
  await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [c.id]);
  const q = await createQuote(app, { contactId: c.id, lines: [{ itemCode: await depositItem() }] }, actor());
  await overrideQuoteDeposit(app, q.id, { amountCents: 0, reason: 'symmetry test: waived for a returning client' }, actor());
  const s = await sendQuote(app, q.id, actor());
  const acc = await acceptQuote(app, s.url.split('/').pop()!, {});
  assert.equal(acc.depositInvoiceId, null, 'a waived deposit issues no invoice');
  const before = await row('engagements', acc.engagementId);
  assert.equal(before.deposit_treatment, 'waived');
  const r = await app.inject({ method: 'POST', url: `/engagements/${acc.engagementId}/restamp-deposit`, headers: auth(rene) });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().changed, false, 'the waived stamp is the record, not an issuance');
  assert.equal((await row('engagements', acc.engagementId)).deposit_treatment, 'waived');
});
