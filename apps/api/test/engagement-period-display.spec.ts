// AUDIT ITEM 1 (2026-09-09, Brian's ruling): an engagement row shows its period, and when
// none is recorded a "period not recorded" badge opens the set-period control — billing.manage,
// not a link to a decision list. The API carries period_key on the wire and the route is
// billing's. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';

let app: FastifyInstance;
let config: Config;
let rene: TestStaff & { token: string };
let preparer: TestStaff & { token: string };
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
const actor = () => ({ id: ceoId, email: 'ceo-period@example.test', fullName: 'Synthetic CEO', roleKey: 'ceo' as const, permissions: ['*'], sessionId: 'test' });

before(async () => {
  config = await createTestConfig('perioddisplay');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  rene = await staffWithToken('rene-period@example.test', 'comms_billing');
  preparer = await staffWithToken('prep-period@example.test', 'tax_preparer');
  ceo = await staffWithToken('ceo2-period@example.test', 'ceo');
  ceoId = (await makeStaff(app.db, config, { email: 'ceo-period@example.test', name: 'Synthetic CEO', role: 'ceo', password: 'ceo-password-1234567' })).id;
});

after(async () => {
  await app.close();
});

test('the engagement list carries period_key; the set-period route is billing.manage; a preparer is refused', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Perioddisplay', email: 'perioddisplay@example.test' });
  const e = await createEngagement(app, actor(), { contactId: c.id, serviceLine: 'tax', title: 'Legacy, no period', status: 'active' }, {});
  await app.db.query(`UPDATE engagements SET period_key = NULL WHERE id = $1`, [e.id]);

  const before = await app.inject({ method: 'GET', url: `/engagements?contactId=${c.id}`, headers: auth(ceo) });
  assert.equal(before.statusCode, 200, before.body);
  const row = (before.json().engagements as Array<{ id: string; period_key: string | null }>).find((x) => x.id === e.id)!;
  assert.equal(row.period_key, null, 'on the wire, so the page can say "period not recorded"');

  const refused = await app.inject({ method: 'PATCH', url: `/engagements/${e.id}/period`, headers: auth(preparer), payload: { periodKey: '2025', reason: 'Recorded on the client page' } });
  assert.equal(refused.statusCode, 403, 'a preparer does not hold billing.manage');

  const set = await app.inject({ method: 'PATCH', url: `/engagements/${e.id}/period`, headers: auth(rene), payload: { periodKey: '2025', reason: 'Recorded on the client page' } });
  assert.equal(set.statusCode, 200, set.body);
  const after = await app.inject({ method: 'GET', url: `/engagements?contactId=${c.id}`, headers: auth(ceo) });
  assert.equal((after.json().engagements as Array<{ id: string; period_key: string | null }>).find((x) => x.id === e.id)!.period_key, '2025');
});
