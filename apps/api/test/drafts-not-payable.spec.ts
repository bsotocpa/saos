// DECISION 5 (2026-09-09, Brian's ruling): drafts are not payable. The filing path and the
// acceptance path ISSUE the invoice (status sent) in their own transaction; the email is the
// outbox intent that follows, once. The portal checkout refuses a draft. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { generateToken } from '../src/crypto.ts';
import { createTestConfig, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createQuote, sendQuote, acceptQuote } from '../src/modules/pricing/quotes.ts';
import { drainOutbox } from '../src/outbox.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff & { token: string };
const sent: MailMessage[] = [];
const capturingMailer: Mailer = { transport: 'console', async send(m) { sent.push(m); return { id: `cap-${sent.length}` }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-1234567`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

async function makeClient(last: string, email: string): Promise<{ contactId: string; token: string }> {
  const contact = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, language, soto_status) VALUES ('Synthetic', $1, $2, 'en', 'active') RETURNING id`, [last, email]);
  const user = await app.db.query<{ id: string }>(`INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`, [contact.rows[0]!.id, email]);
  const { token, hash } = generateToken();
  await app.db.query(`INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [user.rows[0]!.id, hash]);
  return { contactId: contact.rows[0]!.id, token };
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

before(async () => {
  config = await createTestConfig('drafts');
  app = buildServer(config, { mailer: capturingMailer });
  await app.ready();
  ceo = await staffWithToken('ceo-drafts@example.test', 'ceo');
});

after(async () => {
  await app.close();
});

test('the portal checkout refuses a draft: nothing was issued', async () => {
  const pia = await makeClient('Draftpia', 'draftpia@example.test');
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents, amount_paid_cents)
     VALUES ('SYN-DRAFT-0001', $1, 'draft', 10000, 10000, 0) RETURNING id`, [pia.contactId]);
  const res = await app.inject({ method: 'POST', url: `/portal/invoices/${rows[0]!.id}/checkout`, headers: auth(pia) });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error, 'not_payable');
  assert.match(res.json().message, /not been issued/);
});

test('acceptance issues the deposit invoice in its own transaction: sent before the email, payable at once, emailed once', async () => {
  const pia = await makeClient('Draftacc', 'draftacc@example.test');
  const q = await createQuote(app, { contactId: pia.contactId, lines: [{ itemCode: await depositItem() }] }, actor());
  const s = await sendQuote(app, q.id, actor());
  sent.length = 0;
  const acc = await acceptQuote(app, s.url.split('/').pop()!, {});
  assert.ok(acc.depositInvoiceId, 'a deposit invoice exists');

  // Before the outbox runs: already issued.
  const before = (await app.db.query<{ status: string; sent_at: Date | null }>(`SELECT status::text AS status, sent_at FROM invoices WHERE id = $1`, [acc.depositInvoiceId])).rows[0]!;
  assert.equal(before.status, 'sent', 'issued with the acceptance, not a draft');
  assert.ok(before.sent_at, 'sent_at stamped in the same transaction');
  assert.equal(sent.filter((m) => m.to === 'draftacc@example.test' && /invoice|factura/i.test(m.subject)).length, 0, 'the email has not left yet');

  // Payable right now, through the logged-in portal.
  const checkout = await app.inject({ method: 'POST', url: `/portal/invoices/${acc.depositInvoiceId}/checkout`, headers: auth(pia) });
  assert.equal(checkout.statusCode, 200, checkout.body);

  // The email leaves once, and a second drain does not send it again.
  await drainOutbox(app);
  const first = sent.filter((m) => m.to === 'draftacc@example.test').length;
  assert.equal(first, 1, 'exactly one invoice email');
  await drainOutbox(app);
  assert.equal(sent.filter((m) => m.to === 'draftacc@example.test').length, first, 'no second email');
  const audits = await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE action = 'invoice.sent' AND object_id = $1`, [acc.depositInvoiceId]);
  assert.equal(Number(audits.rows[0]!.n), 1);
});
