// ITEM 11 (2026-09-09, Brian's ruling): the actor on an audit row, an invoice card, an
// engagement row is a NAME, never an email. Staff routes write AuthedStaff.fullName; the
// Ops invoice list carries the voider's name. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { generateToken } from '../src/crypto.ts';

let app: FastifyInstance;
let config: Config;
let rene: TestStaff & { token: string };
let ceo: TestStaff & { token: string };
const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, name: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name, role, password: `${role}-password-1234567`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

before(async () => {
  config = await createTestConfig('actornames');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  rene = await staffWithToken('rene-actornames@example.test', 'Synthetic Rene Billing', 'comms_billing');
  ceo = await staffWithToken('ceo-actornames@example.test', 'Synthetic Brian Owner', 'ceo');
});

after(async () => {
  await app.close();
});

test('a staff action through a route is audited under the staff member\'s name; the void card carries the name', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Actornames', email: 'actornames@example.test' });
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents, amount_paid_cents, sent_at)
     VALUES ('SYN-ACT-0001', $1, 'sent', 10000, 10000, 0, now()) RETURNING id`, [c.id]);
  const invoiceId = rows[0]!.id;

  const voided = await app.inject({ method: 'POST', url: `/invoices/${invoiceId}/void`, headers: auth(rene), payload: { reason: 'actor-name test: duplicate' } });
  assert.equal(voided.statusCode, 200, voided.body);

  const audit = await app.db.query<{ actor_label: string }>(`SELECT actor_label FROM audit_log WHERE action = 'invoice.voided' AND object_id = $1`, [invoiceId]);
  assert.equal(audit.rows[0]!.actor_label, 'Synthetic Rene Billing');

  const list = await app.inject({ method: 'GET', url: `/invoices?contactId=${c.id}`, headers: auth(rene) });
  assert.equal(list.statusCode, 200, list.body);
  const inv = (list.json().invoices as Array<{ id: string; voided_by: string | null }>).find((i) => i.id === invoiceId)!;
  assert.equal(inv.voided_by, 'Synthetic Rene Billing', 'the Ops card names the person');
});

test('no staff-authored audit row in this database carries an email as its actor label', async () => {
  // A second staff action of a different kind, so the assertion below covers more than one writer.
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Actornames2', email: 'actornames2@example.test' });
  const actor = { id: ceo.id, email: ceo.email, fullName: 'Synthetic Brian Owner', roleKey: 'ceo', permissions: ['*'], sessionId: 'test' };
  const e = await createEngagement(app, actor, { contactId: c.id, serviceLine: 'bookkeeping', title: 'Actor test', status: 'active' }, {});
  const closed = await app.inject({ method: 'POST', url: `/engagements/${e.id}/close`, headers: auth(ceo), payload: { outcome: 'completed' } });
  assert.equal(closed.statusCode, 200, closed.body);

  const leaks = await app.db.query<{ action: string; actor_label: string }>(
    `SELECT action, actor_label FROM audit_log WHERE actor_type = 'staff' AND actor_label LIKE '%@%' LIMIT 5`);
  assert.deepEqual(leaks.rows, [], `staff audit rows with an email as the actor: ${JSON.stringify(leaks.rows)}`);
});

test('decision 2: a client actor is labelled by the contact\x27s display name, never the email', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Portalname', email: 'portalname@example.test' });
  const user = await app.db.query<{ id: string }>(`INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`, [c.id, 'portalname@example.test']);
  const { token, hash } = generateToken();
  await app.db.query(`INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [user.rows[0]!.id, hash]);
  const res = await app.inject({ method: 'PATCH', url: '/portal/me', headers: { authorization: `Bearer ${token}` }, payload: { preferredContactMethod: 'email' } });
  assert.equal(res.statusCode, 200, res.body);
  const audit = await app.db.query<{ actor_label: string }>(`SELECT actor_label FROM audit_log WHERE action = 'contact.self_updated' AND contact_id = $1`, [c.id]);
  assert.equal(audit.rows[0]!.actor_label, 'Synthetic Portalname');
  const leaks = await app.db.query(`SELECT action, actor_label FROM audit_log WHERE actor_type = 'client' AND actor_label LIKE '%@%' LIMIT 5`);
  assert.deepEqual(leaks.rows, [], 'client audit rows with an email as the actor');
});
