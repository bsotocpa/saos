// R93 (Brian, 2026-09-29): PAST DEADLINES. A return whose derived deadline is before today, with no
// extension recorded and no filing, reads "Overdue since <date>" on the Ops row, the queue and the
// portal card, never a bare past date; recording an extension clears it. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { addDays, overdueSince, todayChicago } from '../src/modules/tax/deadlines.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff & { token: string };
const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

before(async () => {
  config = await createTestConfig('overdue');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email: 'ceo-overdue@example.test', name: 'Synthetic ceo', role: 'ceo', password: 'ceo-password-1234567', totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: staff.email, password: staff.password, totp: code } });
  ceo = { ...staff, token: res.json().token as string };
});
after(async () => { await app.close(); });

test('the rule: a passed deadline with no filing is overdue since that day; filed, completed or withdrawn never is', () => {
  const today = '2026-09-29';
  assert.equal(overdueSince('2026-04-15', today, { stage: 'intake_started' }), '2026-04-15');
  assert.equal(overdueSince('2026-09-29', today, { stage: 'intake_started' }), null, 'due today is not overdue');
  assert.equal(overdueSince('2026-10-15', today, { stage: 'in_preparation' }), null);
  for (const stage of ['filed', 'completed', 'withdrawn']) assert.equal(overdueSince('2026-04-15', today, { stage }), null, stage);
  assert.equal(overdueSince('2026-04-15', today, { stage: 'rejected', filedDate: '2026-04-10' }), null, 'a filing on record');
  assert.equal(overdueSince(null, today, { stage: 'intake_started' }), null);
});

test('the Ops row, the queue and the portal card read "overdue since"; recording an extension clears it', async () => {
  const today = todayChicago();
  const past = addDays(today, -20);
  const year = Number(today.slice(0, 4));
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Overdue', email: 'overdue@example.test' });
  const e = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status, title, period_key) VALUES ($1, 'tax', 'active', 'Tax — synthetic overdue', $2) RETURNING id`,
    [c.id, String(year)]
  );
  const te = await app.db.query<{ id: string }>(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, client_type, preparer_id, original_deadline)
     VALUES ($1, $2, '1040', 'individual', $3, $4::date) RETURNING id`,
    [e.rows[0]!.id, year, ceo.id, past]
  );
  const id = te.rows[0]!.id;
  const row = async () => (await app.inject({ method: 'GET', url: `/tax-engagements?contactId=${c.id}`, headers: auth(ceo) })).json().taxEngagements[0];
  assert.equal((await row()).overdue_since, past, 'the Ops row');
  const queue = await app.inject({ method: 'GET', url: '/my-queue?all=1', headers: auth(ceo) });
  assert.equal(queue.statusCode, 200, queue.body);
  const q = (queue.json().queue as Array<{ id: string; overdueSince: string | null }>).find((r) => r.id === id);
  assert.equal(q?.overdueSince, past, 'the queue');

  // The portal card.
  const pu = await app.db.query<{ id: string }>(`INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`, [c.id, c.email]);
  const token = randomBytes(32).toString('base64url');
  await app.db.query(`INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
    [pu.rows[0]!.id, createHash('sha256').update(token).digest('hex')]);
  const card = async () => (await app.inject({ method: 'GET', url: '/portal/engagements', headers: { cookie: `saos_portal_session=${token}` } }))
    .json().engagements.find((x: { id: string }) => x.id === e.rows[0]!.id);
  const before = await card();
  assert.equal(before.overdue_since, past, 'the portal card');
  assert.equal(before.deadline, null, 'never a bare past date beside it');

  // Recording the extension moves the deadline ahead, and the overdue reading clears everywhere.
  const ext = await app.inject({ method: 'POST', url: `/tax-engagements/${id}/extension/filed`, headers: auth(ceo) });
  assert.equal(ext.statusCode, 200, ext.body);
  const extended = await app.db.query<{ d: string }>(`SELECT extended_deadline::text AS d FROM tax_engagements WHERE id = $1`, [id]);
  assert.ok(extended.rows[0]!.d > today, `the extended deadline is ahead (${extended.rows[0]!.d})`);
  assert.equal((await row()).overdue_since, null, 'the Ops row clears');
  const q2 = ((await app.inject({ method: 'GET', url: '/my-queue?all=1', headers: auth(ceo) })).json().queue as Array<{ id: string; overdueSince: string | null }>).find((r) => r.id === id);
  assert.equal(q2?.overdueSince, null, 'the queue clears');
  assert.equal((await card()).overdue_since, null, 'the portal card clears');
});
