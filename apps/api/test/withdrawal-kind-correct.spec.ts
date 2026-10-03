// Batch 17 (Brian, 2026-10-02): R118, correcting a withdrawal's kind. The CEO alone, with a standalone
// reason, audited with the kind before and after; "our own record" hides the return from the portal and
// "the client's work ended" shows it again. Synthetic data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff & { token: string };
let preparer: TestStaff & { token: string };
const as = (s: { token: string }) => ({ authorization: `Bearer ${s.token}` });

async function signedIn(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const s = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-1234567`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: s.email, password: s.password, totp: code } });
  assert.equal(r.statusCode, 200, r.body);
  return { ...s, token: r.json().token as string };
}

before(async () => {
  config = await createTestConfig('withdrawalkindfix');
  app = buildServer(config);
  await app.ready();
  ceo = await signedIn('ceo-wkf@example.test', 'ceo');
  preparer = await signedIn('prep-wkf@example.test', 'tax_preparer');
});
after(async () => { await app.close(); });

async function client(name: string) {
  const email = `${name.toLowerCase()}@example.test`;
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: name, email });
  await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [c.id]);
  const pu = await app.db.query<{ id: string }>(`INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`, [c.id, email]);
  const token = randomBytes(32).toString('base64url');
  await app.db.query(`INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
    [pu.rows[0]!.id, createHash('sha256').update(token).digest('hex')]);
  return { contactId: c.id, cookie: { cookie: `saos_portal_session=${token}` } };
}
async function withdrawnReturn(contactId: string, taxYear: number, kind: 'client' | 'firm_record'): Promise<string> {
  const te = (await app.inject({ method: 'POST', url: '/tax-engagements', headers: as(ceo), payload: { contactId, taxYear, returnType: '1040', clientType: 'individual', reason: 'Synthetic: a return.' } })).json().id as string;
  const w = await app.inject({ method: 'POST', url: `/tax-engagements/${te}/transition`, headers: as(ceo), payload: { toStage: 'withdrawn', withdrawalKind: kind, note: 'Synthetic: withdrawn for the R118 spec.' } });
  assert.equal(w.statusCode, 200, w.body);
  return te;
}
const onPortal = async (cookie: { cookie: string }, te: string) =>
  ((await app.inject({ method: 'GET', url: '/portal/engagements', headers: cookie })).json().engagements as Array<{ tax_engagement_id: string | null }>)
    .some((r) => r.tax_engagement_id === te);
const correct = (te: string, kind: string, reason: string, who = ceo) =>
  app.inject({ method: 'POST', url: `/tax-engagements/${te}/withdrawal-kind`, headers: as(who), payload: { kind, reason } });

test('R118: the CEO corrects the kind both ways; the portal follows; each correction is audited with before and after', async () => {
  const c = await client('Kindfixapi');
  const te = await withdrawnReturn(c.contactId, 2023, 'firm_record');
  assert.equal(await onPortal(c.cookie, te), false, 'our own record: not on the portal');

  const toClient = await correct(te, 'client', 'Synthetic: the client did withdraw this one; pressed the wrong button.');
  assert.equal(toClient.statusCode, 200, toClient.body);
  assert.deepEqual([toClient.json().before, toClient.json().after], ['firm_record', 'client']);
  assert.equal(await onPortal(c.cookie, te), true, "the client's work ended: on the portal again");

  const again = await correct(te, 'client', 'Synthetic: asking for the kind it already has.');
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(again.json().error, 'unchanged');

  const back = await correct(te, 'firm_record', 'Synthetic: on a second look it was a duplicate after all.');
  assert.equal(back.statusCode, 200, back.body);
  assert.equal(await onPortal(c.cookie, te), false, 'our own record again: off the portal');

  const audit = await app.db.query<{ details: { before: string; after: string; reason: string }; actor_id: string }>(
    `SELECT details, actor_id FROM audit_log WHERE action = 'tax_engagement.withdrawal_kind_corrected' AND object_id = $1 ORDER BY id`, [te]);
  assert.deepEqual(audit.rows.map((r) => [r.details.before, r.details.after]), [['firm_record', 'client'], ['client', 'firm_record']], 'two corrections, each before and after; the refused one is not there');
  assert.equal(audit.rows[0]!.details.reason, 'Synthetic: the client did withdraw this one; pressed the wrong button.');
  assert.equal(audit.rows[0]!.actor_id, ceo.id);
});

test('R118: only the CEO, only with a reason, only on a withdrawal a person chose', async () => {
  const c = await client('Kindfixrefusals');
  const te = await withdrawnReturn(c.contactId, 2022, 'firm_record');

  const prep = await correct(te, 'client', 'Synthetic: a preparer trying the CEO door.', preparer);
  assert.equal(prep.statusCode, 403, prep.body);
  const short = await correct(te, 'client', 'oops');
  assert.equal(short.statusCode, 400, short.body);
  const bad = await correct(te, 'change_order', 'Synthetic: a kind no person chooses.');
  assert.equal(bad.statusCode, 400, bad.body);
  assert.equal((await app.db.query<{ withdrawal_kind: string }>(`SELECT withdrawal_kind FROM tax_engagements WHERE id = $1`, [te])).rows[0]!.withdrawal_kind, 'firm_record', 'nothing moved');

  const live = (await app.inject({ method: 'POST', url: '/tax-engagements', headers: as(ceo), payload: { contactId: c.contactId, taxYear: 2021, returnType: '1040', clientType: 'individual', reason: 'Synthetic: a live return.' } })).json().id as string;
  const notWithdrawn = await correct(live, 'firm_record', 'Synthetic: a live return has no withdrawal kind.');
  assert.equal(notWithdrawn.statusCode, 409, notWithdrawn.body);
  assert.equal(notWithdrawn.json().error, 'not_withdrawn');

  const co = await withdrawnReturn(c.contactId, 2020, 'client');
  await app.db.query(`UPDATE tax_engagements SET withdrawal_kind = 'change_order' WHERE id = $1`, [co]);
  const byAgreement = await correct(co, 'firm_record', 'Synthetic: a change order set this kind.');
  assert.equal(byAgreement.statusCode, 409, byAgreement.body);
  assert.equal(byAgreement.json().error, 'set_by_change_order');
});
