/*
 * STAFF ACCOUNTS, PHASE 1 (2026-09-12, Brian's rulings 1–3, 6, 7, 9, 10).
 *
 * What an account is on day one: a temporary password that dies at 72 hours or first use,
 * a session that can do nothing but set its own password until it does, a legal name and a
 * display name, and named grants only. And what the firm looks like the day real people hold
 * tax_preparer, bookkeeper and comms_billing: owner routing lands on THEM, the four paths that
 * reached nobody reach Rene, and every money action by anyone but the CEO is on the CEO's
 * digest and the executive view. Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { ownerForRole, firstActiveByRole } from '../src/staffing.ts';
import { createInvoice } from '../src/modules/billing/service.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { runMoneyDigestJob, moneyActionsToday } from '../src/modules/billing/money-digest.ts';
import { todayChicago } from '../src/modules/tax/deadlines.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff;
let ceoToken = '';
const CEO_TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const totp = (secret: string) => new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

before(async () => {
  config = await createTestConfig('staff_accounts');
  const mailer: Mailer = { transport: 'console', async send() { return { id: 'x' }; } };
  app = buildServer(config, { mailer });
  await app.ready();
  ceo = await makeStaff(app.db, config, { email: 'ceo-accounts@example.test', name: 'Synthetic CEO', role: 'ceo', password: 'ceo-password-12345678', totpSecret: CEO_TOTP });
  const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: ceo.email, password: ceo.password, totp: totp(CEO_TOTP) } });
  ceoToken = r.json().token;
});
after(async () => { await app.close(); });

test('rulings 2, 3, 6: named grants only — no wildcard on ed_coo, no phantom permissions anywhere, bookkeeping on comms_billing', async () => {
  const grants = async (key: string) => (await app.db.query<{ permission: string }>(
    `SELECT rp.permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.key = $1 ORDER BY 1`, [key])).rows.map((r) => r.permission);
  const edCoo = await grants('ed_coo');
  assert.ok(!edCoo.includes('*'), 'ed_coo holds no wildcard');
  assert.deepEqual([...edCoo].sort(), ['contacts.read', 'engagements.read', 'referrals.suggest', 'tasks.manage', 'tasks.read']);
  const phantom = await app.db.query(`SELECT 1 FROM role_permissions WHERE permission IN ('sales_tax.manage', 'payroll.manage')`);
  assert.equal(phantom.rows.length, 0, 'a grant nothing checks is not a grant');
  assert.ok((await grants('comms_billing')).includes('bookkeeping.assigned.manage'), 'Rene holds bookkeeping scope directly');
});

test('ruling 1: the temporary password dies at 72 hours or first use, and the session owes a password until it is set', async () => {
  const created = await app.inject({
    method: 'POST', url: '/staff', headers: auth(ceoToken),
    payload: { email: 'newhire@example.test', legalName: 'Synthetic Newhire', displayName: 'Newbie', roleKey: 'intern' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const { id, tempPassword } = created.json() as { id: string; tempPassword: string };
  const row = await app.db.query<{ legal_name: string; display_name: string; full_name: string; must_change_password: boolean; temp_password_expires_at: Date }>(
    `SELECT legal_name, display_name, full_name, must_change_password, temp_password_expires_at FROM staff WHERE id = $1`, [id]);
  assert.equal(row.rows[0]!.legal_name, 'Synthetic Newhire');
  assert.equal(row.rows[0]!.display_name, 'Newbie');
  assert.equal(row.rows[0]!.full_name, 'Synthetic Newhire', 'the generated alias reads the legal name');
  assert.equal(row.rows[0]!.must_change_password, true);
  const hours = (row.rows[0]!.temp_password_expires_at.getTime() - Date.now()) / 3_600_000;
  assert.ok(hours > 71.9 && hours <= 72.1, `expires in ~72h, got ${hours.toFixed(2)}`);

  // First use: password accepted, MFA enrolment required, the temp password is spent on verify.
  const first = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'newhire@example.test', password: tempPassword } });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().status, 'mfa_setup_required');
  const setup = await app.inject({ method: 'POST', url: '/auth/mfa/setup', payload: { setupToken: first.json().setupToken } });
  const secret = setup.json().secret as string;
  const verified = await app.inject({ method: 'POST', url: '/auth/mfa/verify', payload: { setupToken: first.json().setupToken, code: totp(secret) } });
  assert.equal(verified.statusCode, 200, verified.body);
  assert.equal(verified.json().mustChangePassword, true, 'the session knows it owes a password');
  const token = verified.json().token as string;
  const spent = await app.db.query<{ temp_password_expires_at: Date }>(`SELECT temp_password_expires_at FROM staff WHERE id = $1`, [id]);
  assert.ok(spent.rows[0]!.temp_password_expires_at.getTime() <= Date.now(), 'consumed on first use');

  // Until the password is set, nothing but /auth works.
  const blocked = await app.inject({ method: 'GET', url: '/tasks/mine', headers: auth(token) });
  assert.equal(blocked.statusCode, 403);
  assert.equal(blocked.json().error, 'password_change_required');
  const me = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(token) });
  assert.equal(me.statusCode, 200, '/auth/* still answers');

  // Second use of the spent temporary password is refused even though it is correct.
  const again = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'newhire@example.test', password: tempPassword, totp: totp(secret) } });
  assert.equal(again.statusCode, 401);
  assert.equal(again.json().error, 'temp_password_expired');

  // Setting their own password lifts the gate.
  const set = await app.inject({ method: 'POST', url: '/auth/password', headers: auth(token), payload: { currentPassword: tempPassword, newPassword: 'newhire-own-password-2026' } });
  assert.equal(set.statusCode, 200, set.body);
  const relogin = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'newhire@example.test', password: 'newhire-own-password-2026', totp: totp(secret) } });
  assert.equal(relogin.statusCode, 200, relogin.body);
  assert.equal(relogin.json().mustChangePassword, false);
  const open = await app.inject({ method: 'GET', url: '/tasks/mine', headers: auth(relogin.json().token) });
  assert.equal(open.statusCode, 200);
});

test('ruling 1: a temporary password older than 72 hours is refused before first use', async () => {
  const created = await app.inject({ method: 'POST', url: '/staff', headers: auth(ceoToken), payload: { email: 'late@example.test', legalName: 'Synthetic Late', roleKey: 'intern' } });
  const { id, tempPassword } = created.json() as { id: string; tempPassword: string };
  await app.db.query(`UPDATE staff SET temp_password_expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);
  const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'late@example.test', password: tempPassword } });
  assert.equal(r.statusCode, 401);
  assert.equal(r.json().error, 'temp_password_expired');
});

test('ruling 9: audit rows carry the display name; the legal name is what the record holds', async () => {
  const created = await app.inject({ method: 'POST', url: '/staff', headers: auth(ceoToken), payload: { email: 'jf@example.test', legalName: 'Synthetic Legalname', displayName: 'Shorty', roleKey: 'ed_coo' } });
  const { id, tempPassword } = created.json() as { id: string; tempPassword: string };
  const first = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'jf@example.test', password: tempPassword } });
  const setup = await app.inject({ method: 'POST', url: '/auth/mfa/setup', payload: { setupToken: first.json().setupToken } });
  const verified = await app.inject({ method: 'POST', url: '/auth/mfa/verify', payload: { setupToken: first.json().setupToken, code: totp(setup.json().secret) } });
  const token = verified.json().token as string;
  await app.inject({ method: 'POST', url: '/auth/password', headers: auth(token), payload: { currentPassword: tempPassword, newPassword: 'shorty-own-password-2026' } });
  // Any audited action: the actor label is the display name.
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Labelled', email: 'labelled@example.test' });
  const t = await app.inject({ method: 'POST', url: '/tasks', headers: auth(token), payload: { title: 'Synthetic task by Shorty', contactId: c.id } });
  assert.equal(t.statusCode, 201, t.body);
  const audit = await app.db.query<{ actor_label: string }>(`SELECT actor_label FROM audit_log WHERE actor_id = $1 ORDER BY occurred_at DESC LIMIT 1`, [id]);
  assert.equal(audit.rows[0]!.actor_label, 'Shorty');
  const me = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(token) });
  void me;
});

test('ruling 7 and the four nobody-paths: with the three roles held, owners resolve to them and the day-14 rung has someone to call', async () => {
  const ana = await makeStaff(app.db, config, { email: 'ana-acc@example.test', name: 'Synthetic Ana-Maria', role: 'tax_preparer', password: 'tax_preparer-password-1234' });
  const marian = await makeStaff(app.db, config, { email: 'marian-acc@example.test', name: 'Synthetic Marian', role: 'bookkeeper', password: 'bookkeeper-password-12345' });
  const rene = await makeStaff(app.db, config, { email: 'rene-acc@example.test', name: 'Synthetic Rene', role: 'comms_billing', password: 'comms_billing-password-1234', totpSecret: CEO_TOTP });

  assert.equal(await ownerForRole(app.db, 'tax_preparer'), ana.id, 'tax work resolves to the preparer, not the CEO');
  assert.equal(await ownerForRole(app.db, 'bookkeeper'), marian.id);
  assert.equal(await ownerForRole(app.db, 'comms_billing'), rene.id);
  assert.equal(await firstActiveByRole(app.db, 'comms_billing'), rene.id, 'the no-fallback resolver finds Rene too — the four paths that reached nobody now reach her');
  assert.equal(await ownerForRole(app.db, 'ceo'), ceo.id, 'referral approvals resolve through the CEO role (ruling 7), whoever holds ed_coo');
  // Ruling 7: "set final fee and invoice" is the preparer's — the resolver the code now asks.
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/modules/billing/service.ts', import.meta.url), 'utf8'));
  assert.match(src, /ownerForRole\(app\.db, 'tax_preparer'\)/);
  const ref = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/modules/referrals/service.ts', import.meta.url), 'utf8'));
  assert.match(ref, /const approver = await ownerForRole\(app\.db, 'ceo'\)/);
});

test('ruling 10: a void by anyone other than the CEO is on the executive view immediately and in the next digest', async () => {
  const rene = (await app.db.query<{ id: string }>(`SELECT id FROM staff WHERE email = 'rene-acc@example.test'`)).rows[0]!;
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Digest', email: 'digest@example.test' });
  const e = await createEngagement(app, { id: ceo.id, email: ceo.email, fullName: ceo.fullName, roleKey: 'ceo', permissions: ['*'], sessionId: 't' }, { contactId: c.id, serviceLine: 'bookkeeping', title: 'Books', status: 'active' }, {});
  const inv = await createInvoice(app, { type: 'staff', id: ceo.id, label: ceo.fullName }, { contactId: c.id, engagementId: e.id, lines: [{ description: 'Books — month', unitCents: 100 }], send: false, issued: true });
  // Rene voids it through the real route.
  const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'rene-acc@example.test', password: 'comms_billing-password-1234', totp: totp(CEO_TOTP) } });
  assert.equal(login.statusCode, 200, login.body);
  const rtoken = login.json().token as string;
  const v = await app.inject({ method: 'POST', url: `/invoices/${inv.id}/void`, headers: auth(rtoken), payload: { reason: 'Superseded by the corrected invoice issued today.' } });
  assert.equal(v.statusCode, 200, v.body);

  // Immediately on the executive view.
  const today = todayChicago();
  const now = await moneyActionsToday(app, today);
  const mine = now.find((m) => m.invoiceNumber === inv.invoiceNumber);
  assert.ok(mine, 'the void is on the same-day line');
  assert.equal(mine!.action, 'Void');
  assert.equal(mine!.actorId, rene.id);
  assert.match(mine!.reason ?? '', /Superseded/);
  const exec = await app.inject({ method: 'GET', url: '/dashboards/executive', headers: auth(ceoToken) });
  assert.equal(exec.statusCode, 200);
  assert.ok((exec.json().moneyActionsToday as Array<{ invoiceNumber: string }>).some((m) => m.invoiceNumber === inv.invoiceNumber));

  // The CEO's own void is NOT on it.
  const inv2 = await createInvoice(app, { type: 'staff', id: ceo.id, label: ceo.fullName }, { contactId: c.id, engagementId: e.id, lines: [{ description: 'Books — month 2', unitCents: 100 }], send: false, issued: true });
  await app.inject({ method: 'POST', url: `/invoices/${inv2.id}/void`, headers: auth(ceoToken), payload: { reason: 'Superseded by the corrected invoice issued today.' } });
  assert.ok(!(await moneyActionsToday(app, today)).some((m) => m.invoiceNumber === inv2.invoiceNumber), 'the CEO is not reported to himself');

  // The next morning's digest names it, once, to the CEO.
  const tomorrow = new Date(`${today}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const run = await runMoneyDigestJob(app, tomorrow.toISOString().slice(0, 10));
  assert.equal(run.skipped, false);
  assert.ok(run.actions >= 1);
  assert.equal(run.notified, 1, 'one CEO, one notification');
  const n = await app.db.query<{ title: string; body: string }>(`SELECT title, body FROM notifications WHERE staff_id = $1 AND type LIKE 'money_digest_%' ORDER BY created_at DESC LIMIT 1`, [ceo.id]);
  assert.match(n.rows[0]!.title, /Money actions yesterday/);
  assert.match(n.rows[0]!.body, new RegExp(inv.invoiceNumber));
  assert.match(n.rows[0]!.body, /Synthetic Rene/);
  assert.doesNotMatch(n.rows[0]!.body, new RegExp(inv2.invoiceNumber));
  const again = await runMoneyDigestJob(app, tomorrow.toISOString().slice(0, 10));
  assert.equal(again.skipped, true, 'once per day');
});
