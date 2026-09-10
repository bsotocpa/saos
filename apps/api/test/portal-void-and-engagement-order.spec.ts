// E and F (2026-09-09, Brian's rulings after the iPhone walk).
//
// E: the client was emailed that SA-2026-0002 was cancelled, and the portal hid it. The
//    portal now lists a void invoice — Cancelled (Anulada), sorted last, and there is no
//    checkout for it.
// F: engagements list active first, then on hold, then closed; newest first in each group.
//
// Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { generateToken } from '../src/crypto.ts';
import { createTestConfig, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { closeEngagement } from '../src/modules/engagements/close.ts';
import { pauseEngagement } from '../src/modules/engagements/pause.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff & { token: string };
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

async function makeClient(last: string, email: string): Promise<{ contactId: string; token: string }> {
  const contact = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, language, soto_status) VALUES ('Synthetic', $1, $2, 'en', 'active') RETURNING id`,
    [last, email]
  );
  const user = await app.db.query<{ id: string }>(`INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`, [contact.rows[0]!.id, email]);
  const { token, hash } = generateToken();
  await app.db.query(`INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [user.rows[0]!.id, hash]);
  return { contactId: contact.rows[0]!.id, token };
}

let seq = 0;
async function invoice(contactId: string, status: string, ageDays: number): Promise<{ id: string; number: string }> {
  seq += 1;
  const number = `SYN-EF-${String(seq).padStart(4, '0')}`;
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents, amount_paid_cents, sent_at, created_at)
     VALUES ($1, $2, $3::invoice_status, 10000, 10000, 0, now() - ($4 || ' days')::interval, now() - ($4 || ' days')::interval)
     RETURNING id`,
    [number, contactId, status, String(ageDays)]
  );
  return { id: rows[0]!.id, number };
}

const actor = () => ({ id: ceo.id, email: ceo.email, fullName: 'Synthetic CEO', roleKey: 'ceo' as const, permissions: ['*'], sessionId: 'test' });

before(async () => {
  config = await createTestConfig('portalvoid');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  ceo = await staffWithToken('ceo-portalvoid@example.test', 'ceo');
});

after(async () => {
  await app.close();
});

test('E: the portal lists a void invoice, after every live one, and refuses to check it out', async () => {
  const pia = await makeClient('Portalvoid', 'portalvoid@example.test');
  const oldVoid = await invoice(pia.contactId, 'void', 10); // the oldest row, and void
  const newVoid = await invoice(pia.contactId, 'void', 1); // the NEWEST row, and void
  const open = await invoice(pia.contactId, 'sent', 5);
  const paid = await invoice(pia.contactId, 'paid', 3);

  const list = await app.inject({ method: 'GET', url: '/portal/invoices', headers: auth(pia) });
  assert.equal(list.statusCode, 200, list.body);
  const rows = list.json().invoices as Array<{ id: string; status: string; invoice_number: string }>;
  assert.equal(rows.length, 4, 'void invoices are listed, not hidden');
  assert.deepEqual(
    rows.map((r) => r.id),
    [paid.id, open.id, newVoid.id, oldVoid.id],
    'live invoices newest first, then void newest first — a void row never sorts above a live one'
  );

  const checkout = await app.inject({ method: 'POST', url: `/portal/invoices/${newVoid.id}/checkout`, headers: auth(pia) });
  assert.equal(checkout.statusCode, 409, checkout.body);
  assert.equal(checkout.json().error, 'not_payable');
  const still = await app.db.query<{ s: string; cs: string | null }>(`SELECT status::text AS s, stripe_checkout_session_id AS cs FROM invoices WHERE id = $1`, [newVoid.id]);
  assert.equal(still.rows[0]!.s, 'void');
  assert.equal(still.rows[0]!.cs, null, 'no checkout session was created for a cancelled invoice');
});

test('E: the portal copy for a void invoice exists in both languages and says Cancelled, not void', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../portal/lib/i18n.ts', import.meta.url), 'utf8');
  const m = src.match(/inv_void:\s*\['([^']+)',\s*'([^']+)'\]/);
  assert.ok(m, 'inv_void is defined');
  assert.equal(m![1], 'Cancelled');
  assert.equal(m![2], 'Anulada');
});

test('F: engagements list active, then on hold, then closed — newest first within each group', async () => {
  const c = await makeClient('Engorder', 'engorder@example.test');
  const mk = async (title: string, line: 'tax' | 'bookkeeping' | 'payroll' | 'advisory', createdDaysAgo: number) => {
    const e = await createEngagement(app, actor(), { contactId: c.contactId, serviceLine: line, title, status: 'active' }, {});
    await app.db.query(`UPDATE engagements SET created_at = now() - ($2 || ' days')::interval, price_lock_expires_on = CURRENT_DATE + 30 WHERE id = $1`, [e.id, String(createdDaysAgo)]);
    return e.id;
  };
  const closedNew = await mk('closed, newest of all', 'tax', 1);
  const activeOld = await mk('active, old', 'bookkeeping', 20);
  const held = await mk('on hold', 'payroll', 10);
  const activeNew = await mk('active, new', 'advisory', 2);
  const closedOld = await mk('closed, old', 'tax', 30);
  await closeEngagement(app, closedNew, { outcome: 'completed' }, { type: 'system', label: 'test' });
  await closeEngagement(app, closedOld, { outcome: 'withdrawn', reason: 'order test' }, { type: 'system', label: 'test' });
  await pauseEngagement(app, held, { reason: 'order test' }, { type: 'system', label: 'test' });

  const list = await app.inject({ method: 'GET', url: `/engagements?contactId=${c.contactId}`, headers: auth(ceo) });
  assert.equal(list.statusCode, 200, list.body);
  const ids = (list.json().engagements as Array<{ id: string }>).map((e) => e.id);
  assert.deepEqual(ids, [activeNew, activeOld, held, closedNew, closedOld]);
});
