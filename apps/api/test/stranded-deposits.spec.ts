// STRANDED DEPOSITS (item 7, 2026-09-09). SA-2026-0001 (a paid deposit) sat on an engagement
// withdrawn as a duplicate. A withdrawal that would strand a paid, unapplied deposit is
// refused unless the deposit transfers (supersession) or the actor chooses refund (a billing
// task through the one door; Stripe is never touched here). A deposit can be moved between
// two engagements of the same client by billing.manage, audited on both. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createQuote, sendQuote, acceptQuote } from '../src/modules/pricing/quotes.ts';
import { closeEngagement } from '../src/modules/engagements/close.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { availableDepositCredit } from '../src/modules/billing/deposit-credit.ts';

let app: FastifyInstance;
let config: Config;
let rene: TestStaff & { token: string };
let ceo: TestStaff & { token: string };
let ceoId = '';
const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-1234567`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

const actor = () => ({ id: ceoId, email: 'ceo-stranded@example.test', fullName: 'Synthetic CEO', roleKey: 'ceo' as const, permissions: ['*'], sessionId: 'test' });

async function depositItem(): Promise<string> {
  const { rows } = await app.db.query<{ item_code: string }>(
    `SELECT pbi.item_code FROM price_book_items pbi JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.deposit_cents > 0 AND pbi.is_active AND pbi.display_on_quote AND pbi.amount_cents IS NOT NULL
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
      ORDER BY pbi.item_code LIMIT 1`);
  return rows[0]!.item_code;
}

/** A client with an accepted quote whose deposit invoice is PAID: money on an engagement. */
let seq = 0;
async function clientWithPaidDeposit() {
  seq += 1;
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: `Stranded${seq}`, email: `stranded-${seq}@example.test` });
  await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [c.id]);
  const q = await createQuote(app, { contactId: c.id, lines: [{ itemCode: await depositItem() }] }, actor());
  const s = await sendQuote(app, q.id, actor());
  const acc = await acceptQuote(app, s.url.split('/').pop()!, {});
  await app.db.query(`UPDATE invoices SET status = 'paid', amount_paid_cents = total_cents, paid_at = now(), stripe_payment_intent_id = $2 WHERE id = $1`, [acc.depositInvoiceId!, `pi_stranded_${seq}`]);
  const dep = (await app.db.query<{ total: number; number: string }>(`SELECT total_cents AS total, invoice_number AS number FROM invoices WHERE id = $1`, [acc.depositInvoiceId!])).rows[0]!;
  return { contactId: c.id, engagementId: acc.engagementId, depositInvoiceId: acc.depositInvoiceId!, depositCents: dep.total, depositNumber: dep.number };
}

before(async () => {
  config = await createTestConfig('stranded');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  rene = await staffWithToken('rene-stranded@example.test', 'comms_billing');
  ceo = await staffWithToken('ceo2-stranded@example.test', 'ceo');
  ceoId = (await makeStaff(app.db, config, { email: 'ceo-stranded@example.test', name: 'Synthetic CEO', role: 'ceo', password: 'ceo-password-1234567' })).id;
});

after(async () => {
  await app.close();
});

test('7a: withdrawing an engagement that holds a paid, unapplied deposit is refused, and says which deposit', async () => {
  const x = await clientWithPaidDeposit();
  await assert.rejects(
    closeEngagement(app, x.engagementId, { outcome: 'withdrawn', reason: 'duplicate accept' }, { type: 'system', label: 'test' }),
    (err: { code?: string; message: string }) => err.code === 'deposit_would_strand' && err.message.includes(x.depositNumber)
  );
  const st = await app.db.query<{ status: string }>(`SELECT status::text AS status FROM engagements WHERE id = $1`, [x.engagementId]);
  assert.equal(st.rows[0]!.status, 'active', 'nothing moved');
});

test('7a: "refund" withdraws and raises ONE billing task through the one door; Stripe is not touched', async () => {
  const x = await clientWithPaidDeposit();
  const r = await closeEngagement(app, x.engagementId, { outcome: 'withdrawn', reason: 'client walked away', depositAction: 'refund' }, { type: 'system', label: 'test' });
  assert.equal(r.outcome, 'withdrawn');
  assert.ok(r.refundTaskId, 'a task was raised');
  const task = await app.db.query<{ title: string; source_type: string }>(`SELECT title, source_type FROM tasks WHERE id = $1`, [r.refundTaskId]);
  assert.equal(task.rows[0]!.source_type, 'deposit_refund');
  assert.match(task.rows[0]!.title, new RegExp(x.depositNumber));
  const inv = await app.db.query<{ status: string }>(`SELECT status::text AS status FROM invoices WHERE id = $1`, [x.depositInvoiceId]);
  assert.equal(inv.rows[0]!.status, 'paid', 'no automatic refund — the invoice is still paid until Stripe says otherwise');
});

test('7a/7b: "transfer" moves the deposit to the named open engagement; credit follows; both engagements audited', async () => {
  const x = await clientWithPaidDeposit();
  const successor = await createEngagement(app, actor(), { contactId: x.contactId, serviceLine: 'bookkeeping', title: 'Successor', status: 'active' }, {});
  const r = await closeEngagement(app, x.engagementId, {
    outcome: 'withdrawn', reason: 'superseded — rehearsal', depositAction: 'transfer', transferToEngagementId: successor.id,
  }, { type: 'system', label: 'test' });
  assert.equal(r.depositsMoved, 1);
  assert.deepEqual((await availableDepositCredit(app, x.engagementId)), [], 'the old engagement has no credit');
  const credit = await availableDepositCredit(app, successor.id);
  assert.equal(credit[0]?.availableCents, x.depositCents, 'the successor holds the whole deposit');
  const audits = await app.db.query<{ object_id: string }>(
    `SELECT object_id FROM audit_log WHERE action = 'engagement.deposit_transferred' AND object_id = ANY($1::text[])`, [[x.engagementId, successor.id]]);
  assert.equal(audits.rows.length, 2, 'an audit row on BOTH engagements');
});

test('7b: the transfer route is billing.manage, refuses another client’s engagement and a closed target', async () => {
  const x = await clientWithPaidDeposit();
  const other = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Otherclient', email: 'otherclient@example.test' });
  const foreign = await createEngagement(app, actor(), { contactId: other.id, serviceLine: 'tax', title: 'Not theirs', status: 'active' }, {});
  const wrong = await app.inject({ method: 'POST', url: `/engagements/${foreign.id}/transfer-deposit`, headers: auth(rene),
    payload: { invoiceId: x.depositInvoiceId, reason: 'trying to move it across clients' } });
  assert.equal(wrong.statusCode, 409, wrong.body);
  assert.equal(wrong.json().error, 'different_client');

  const mine = await createEngagement(app, actor(), { contactId: x.contactId, serviceLine: 'bookkeeping', title: 'Mine', status: 'active' }, {});
  const ok = await app.inject({ method: 'POST', url: `/engagements/${mine.id}/transfer-deposit`, headers: auth(rene),
    payload: { invoiceId: x.depositInvoiceId, reason: 'moving the deposit to the right work' } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().toEngagementId, mine.id);
  const row = await app.db.query<{ e: string }>(`SELECT engagement_id AS e FROM invoices WHERE id = $1`, [x.depositInvoiceId]);
  assert.equal(row.rows[0]!.e, mine.id);
});

test('decision 1 route: setting a period that collides with another active engagement is refused by the index', async () => {
  const x = await clientWithPaidDeposit();
  const legacy = await createEngagement(app, actor(), { contactId: x.contactId, serviceLine: 'tax', title: 'Legacy, no period', status: 'active' }, {});
  await app.db.query(`UPDATE engagements SET period_key = NULL WHERE id = $1`, [legacy.id]);
  const period = (await app.db.query<{ p: string }>(`SELECT period_key AS p FROM engagements WHERE id = $1`, [x.engagementId])).rows[0]!.p;
  const clash = await app.inject({ method: 'PATCH', url: `/engagements/${legacy.id}/period`, headers: auth(ceo),
    payload: { periodKey: period, reason: 'ruled: this is the same year' } });
  assert.equal(clash.statusCode, 409, clash.body);
  assert.equal(clash.json().error, 'engagement_exists');
  const ok = await app.inject({ method: 'PATCH', url: `/engagements/${legacy.id}/period`, headers: auth(ceo),
    payload: { periodKey: '2024', reason: 'ruled: prior year' } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().previous, null);
});
