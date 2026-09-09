// CALENDAR DAYS ARE NOT INSTANTS (2026-09-09, Brian's ruling after "started Sep 9 · ended Sep 8").
//
// A DATE column left the database as a JS Date at the server's midnight, was serialised as
// "…T00:00:00.000Z", and a formatter that treats that as an instant rendered the evening
// before in Chicago. The driver now returns DATE as the 'YYYY-MM-DD' it stored; every API
// response carries the day, and the Ops/portal helpers never shift it. Also here: the pause
// duration is measured on ONE clock (the database's), which is decision 6's root cause.
//
// Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { closeEngagement } from '../src/modules/engagements/close.ts';
import { pauseEngagement, resumeEngagement } from '../src/modules/engagements/pause.ts';

let app: FastifyInstance;
let config: Config;
let staffId = '';
const RAW_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const CALENDAR = /^\d{4}-\d{2}-\d{2}$/;

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };

before(async () => {
  config = await createTestConfig('caldates');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  staffId = (await makeStaff(app.db, config, { email: 'ceo-caldates@example.test', name: 'Synthetic CEO', role: 'ceo', password: 'ceo-password-1234567' })).id;
});

after(async () => {
  await app.close();
});

const actor = () => ({ id: staffId, email: 'ceo-caldates@example.test', fullName: 'Synthetic CEO', roleKey: 'ceo' as const, permissions: ['*'], sessionId: 'test' });

test('the driver returns a DATE column as the calendar day it stored — text, not a midnight instant', async () => {
  const { rows } = await app.db.query<{ today: unknown; fixed: unknown }>(`SELECT CURRENT_DATE AS today, DATE '2026-08-16' AS fixed`);
  assert.equal(typeof rows[0]!.today, 'string');
  assert.equal(rows[0]!.fixed, '2026-08-16');
  assert.doesNotMatch(String(rows[0]!.fixed), RAW_TIMESTAMP);
});

test('an engagement closed today carries ended_on >= started_on as calendar days on the API, and no ISO-T anywhere', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Calendar', email: 'calendar@example.test' });
  const eng = await createEngagement(app, actor(), { contactId: c.id, serviceLine: 'tax', title: 'Synthetic day test', status: 'active' }, {});
  await app.db.query(`UPDATE engagements SET started_on = DATE '2026-09-09' WHERE id = $1`, [eng.id]);
  await closeEngagement(app, eng.id, { outcome: 'withdrawn', reason: 'calendar test', endedOn: '2026-09-09' }, { type: 'system', label: 'test' });

  const { rows } = await app.db.query<{ started_on: string; ended_on: string }>(`SELECT started_on, ended_on FROM engagements WHERE id = $1`, [eng.id]);
  assert.equal(rows[0]!.started_on, '2026-09-09');
  assert.equal(rows[0]!.ended_on, '2026-09-09');
  assert.ok(rows[0]!.ended_on >= rows[0]!.started_on, 'ended is never before started');

  // What the Ops page fetches: the same days, as days.
  const token = await (async () => {
    const OTPAuth = await import('otpauth');
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    const s = await makeStaff(app.db, config, { email: 'ceo2-caldates@example.test', name: 'Synthetic CEO 2', role: 'ceo', password: 'ceo-password-1234567', totpSecret: secret });
    const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: s.email, password: s.password, totp: code } });
    return res.json().token as string;
  })();
  const list = await app.inject({ method: 'GET', url: `/engagements?contactId=${c.id}`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(list.statusCode, 200, list.body);
  const row = (list.json().engagements as Array<{ id: string; started_on: string | null; ended_on: string | null }>).find((e) => e.id === eng.id)!;
  assert.match(row.started_on!, CALENDAR);
  assert.match(row.ended_on!, CALENDAR);
  assert.doesNotMatch(list.body, /"(started_on|ended_on|price_lock_expires_on)":"\d{4}-\d{2}-\d{2}T/, 'DATE columns are days on the wire');
});

test('decision 6: the pause is measured on the database clock, so six backdated days are six days, every run', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Oneclock', email: 'oneclock@example.test' });
  await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [c.id]);
  const eng = await createEngagement(app, actor(), { contactId: c.id, serviceLine: 'bookkeeping', title: 'Synthetic clock', status: 'active' }, {});
  await app.db.query(`UPDATE engagements SET price_lock_expires_on = CURRENT_DATE + 20 WHERE id = $1`, [eng.id]);
  await pauseEngagement(app, eng.id, { reason: 'clock test' }, { type: 'system', label: 'test' });
  for (let i = 0; i < 5; i++) {
    await app.db.query(`UPDATE engagements SET work_paused_at = now() - interval '6 days' WHERE id = $1`, [eng.id]);
    const r = await resumeEngagement(app, eng.id, { type: 'system', label: 'test' });
    assert.equal(r.pausedDays, 6, `run ${i + 1}: one clock, six days`);
    await pauseEngagement(app, eng.id, { reason: 'clock test again' }, { type: 'system', label: 'test' });
  }
});
