/*
 * THE 8879 SENT FOR SIGNATURE (Brian, 2026-09-26, R53) — the API half.
 *
 *  · POST /tax-engagements/:id/8879-sent records how the form reached the client (Adobe Sign, in
 *    office, mailed) and the day, under engagements.tax.manage; a bookkeeper is refused 403;
 *  · refused by name before the return is delivered (client_review), after today, and once a signed
 *    8879 is on file; a refusal writes nothing;
 *  · a later record replaces the earlier one and the audit row names what it replaced;
 *  · GET /tax-engagements/:id exposes the record (with who recorded it) and the activity the stepper
 *    reads; the preparer queue reads the return as "awaiting signature (<method>, sent <day>)" until
 *    the signed scan is on file; the portal engagement read carries the method, the day and whether
 *    the 8879 is on file, for the R48 block;
 *  · the Trello import's declaration lands with no method and the declared_by_import flag, once.
 * Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, signed8879OnFile, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { addDays, todayChicago } from '../src/modules/tax/deadlines.ts';
import { generateToken } from '../src/crypto.ts';
import { PORTAL_SESSION_COOKIE } from '../src/cookies.ts';
import { declareImported8879Sent } from '../src/modules/tax/f8879-sent.ts';
import { stageFor } from '../scripts/trello-normalize.ts';

let app: FastifyInstance;
let config: Config;
let ana: TestStaff & { token: string };
let brian: TestStaff & { token: string };
let marian: TestStaff & { token: string };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });
const today = todayChicago();

async function staffWithToken(email: string, role: string, name: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

before(async () => {
  config = await createTestConfig('f8879_sent');
  const mailer: Mailer = { transport: 'console', async send() { return { id: 'x' }; } };
  app = buildServer(config, { mailer });
  await app.ready();
  ana = await staffWithToken('ana-8879sent@example.test', 'tax_preparer', 'Synthetic Preparer');
  brian = await staffWithToken('brian-8879sent@example.test', 'ceo', 'Synthetic CEO');
  marian = await staffWithToken('marian-8879sent@example.test', 'bookkeeper', 'Synthetic Bookkeeper');
});
after(async () => { await app.close(); });

let seq = 0;
/** A 2025 1040 at the given stage with the letter, the estimate lock and Ana assigned; no 8879. */
async function returnAt(stage: string): Promise<{ id: string; contactId: string; email: string }> {
  seq++;
  const email = `sent${seq}-8879sent@example.test`;
  const contactId = (await makeContact(app.db, { firstName: 'Synthetic', lastName: `Sent${seq}`, email })).id;
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, title, status, period_key) VALUES ($1, 'tax', '2025 1040', 'active', '2025') RETURNING id`,
    [contactId]
  );
  const te = await app.db.query<{ id: string }>(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, client_type, stage, preparer_id, engagement_letter_signed_at, estimate_locked_at)
     VALUES ($1, 2025, '1040', 'individual', $2::tax_stage, $3, now(), now()) RETURNING id`,
    [eng.rows[0]!.id, stage, ana.id]
  );
  return { id: te.rows[0]!.id, contactId, email };
}
const send = (id: string, payload: Record<string, unknown>, who: { token: string } = ana) =>
  app.inject({ method: 'POST', url: `/tax-engagements/${id}/8879-sent`, headers: auth(who), payload });
async function state(id: string) {
  const { rows } = await app.db.query<{ method: string | null; sent_on: string | null; by: string | null; at: Date | null; flagged: boolean }>(
    `SELECT f8879_sent_method::text AS method, f8879_sent_on::text AS sent_on, f8879_sent_recorded_by AS by, f8879_sent_recorded_at AS at,
            f8879_sent_declared_by_import AS flagged FROM tax_engagements WHERE id = $1`, [id]);
  return rows[0]!;
}
async function audits(id: string, action: string) {
  const { rows } = await app.db.query<{ actor_label: string; details: Record<string, unknown> }>(
    `SELECT actor_label, details FROM audit_log WHERE object_type = 'tax_engagement' AND object_id = $1 AND action = $2 ORDER BY id`, [id, action]);
  return rows;
}
async function queueRow(id: string) {
  const res = await app.inject({ method: 'GET', url: '/my-queue?all=1', headers: auth(brian) });
  assert.equal(res.statusCode, 200, res.body);
  const rows = (res.json() as { queue: Array<Record<string, unknown>> }).queue;
  return rows.find((r) => r.id === id);
}
/** "Sep 26, 2026" — the words the queue prints for a calendar day. */
const dayWords = (iso: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));

test('a bookkeeper is refused 403 and nothing is written', async () => {
  const te = await returnAt('client_review');
  const res = await send(te.id, { method: 'adobe_sign', sentOn: today }, marian);
  assert.equal(res.statusCode, 403, res.body);
  assert.equal((await state(te.id)).sent_on, null);
});

test('before the return is delivered the record is refused by name, and nothing is written', async () => {
  const te = await returnAt('in_preparation');
  const res = await send(te.id, { method: 'adobe_sign', sentOn: today });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error, 'f8879_sent_before_delivery');
  assert.match(res.json().message, /delivered to the client/);
  assert.equal((await state(te.id)).sent_on, null);
  assert.equal((await audits(te.id, 'tax_engagement.f8879_sent_recorded')).length, 0);
});

test('a day after today is refused; an unknown method is refused by the schema', async () => {
  const te = await returnAt('client_review');
  const future = await send(te.id, { method: 'mailed', sentOn: addDays(today, 1) });
  assert.equal(future.statusCode, 409, future.body);
  assert.equal(future.json().error, 'f8879_sent_in_future');
  assert.match(future.json().message, /is after today/);
  const odd = await send(te.id, { method: 'fax', sentOn: today });
  assert.equal(odd.statusCode, 400, odd.body);
  assert.equal((await state(te.id)).sent_on, null);
});

test('at client_review the record lands: the columns, the audit row, GET detail, and the queue reads awaiting signature', async () => {
  const te = await returnAt('client_review');
  const sentOn = addDays(today, -1);
  const res = await send(te.id, { method: 'adobe_sign', sentOn });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().f8879_sent.method, 'adobe_sign');
  assert.equal(res.json().f8879_sent.sentOn, sentOn);

  const s = await state(te.id);
  assert.equal(s.method, 'adobe_sign');
  assert.equal(s.sent_on, sentOn, 'a calendar day, as said');
  assert.equal(s.by, ana.id);
  assert.ok(s.at, 'recorded at is set');
  assert.equal(s.flagged, false);

  const rows = await audits(te.id, 'tax_engagement.f8879_sent_recorded');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.actor_label, ana.fullName);
  assert.deepEqual(rows[0]!.details, { method: 'adobe_sign', sent_on: sentOn, replaced: null });

  const detail = await app.inject({ method: 'GET', url: `/tax-engagements/${te.id}`, headers: auth(ana) });
  assert.equal(detail.statusCode, 200, detail.body);
  const d = detail.json() as { f8879_sent: Record<string, unknown>; activity: Array<{ action: string; actor_label: string }>; taxEngagement: Record<string, unknown> };
  assert.equal(d.f8879_sent.method, 'adobe_sign');
  assert.equal(d.f8879_sent.sent_on, sentOn);
  assert.equal(d.f8879_sent.recorded_by_name, ana.fullName, 'who recorded it, by name');
  assert.equal(d.f8879_sent.declared_by_import, false);
  assert.equal(d.taxEngagement.f8879_sent_on, sentOn, 'the raw column comes back as the day, not an instant');
  assert.ok(d.activity.some((a) => a.action === 'tax_engagement.f8879_sent_recorded' && a.actor_label === ana.fullName), 'the stepper can say who sent it');

  const q = await queueRow(te.id);
  assert.ok(q, 'the return is in the queue');
  assert.equal(q!.awaitingSignature, true);
  assert.equal(q!.awaitingSignatureText, `awaiting signature (Adobe Sign, sent ${dayWords(sentOn)})`);
});

test('a later record replaces the earlier one, and the audit row names what it replaced', async () => {
  const te = await returnAt('ready_to_file');
  const first = addDays(today, -3);
  assert.equal((await send(te.id, { method: 'mailed', sentOn: first })).statusCode, 200);
  const again = await send(te.id, { method: 'in_office', sentOn: today }, brian);
  assert.equal(again.statusCode, 200, again.body);
  const s = await state(te.id);
  assert.equal(s.method, 'in_office');
  assert.equal(s.sent_on, today);
  assert.equal(s.by, brian.id, 'the CEO holds the permission by wildcard');
  const rows = await audits(te.id, 'tax_engagement.f8879_sent_recorded');
  assert.equal(rows.length, 2, 'one row per record; the columns hold the state');
  assert.deepEqual(rows[1]!.details.replaced, { method: 'mailed', sent_on: first, declared_by_import: false });
  const q = await queueRow(te.id);
  assert.equal(q!.awaitingSignatureText, `awaiting signature (in office, sent ${dayWords(today)})`);
});

test('once the signed 8879 is on file the record is refused, and the queue stops saying awaiting signature', async () => {
  const te = await returnAt('client_review');
  assert.equal((await send(te.id, { method: 'adobe_sign', sentOn: today })).statusCode, 200);
  await signed8879OnFile(app, te.id, ana.id, today);
  const res = await send(te.id, { method: 'mailed', sentOn: today });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error, 'f8879_already_on_file');
  const s = await state(te.id);
  assert.equal(s.method, 'adobe_sign', 'the earlier record stands; nothing moved on the refusal');
  const q = await queueRow(te.id);
  assert.equal(q!.awaitingSignature, false);
  assert.equal(q!.awaitingSignatureText, null);
  assert.equal((q!.f8879Sent as { method: string }).method, 'adobe_sign', 'the record itself is still readable');
});

test('the portal engagement read carries the method, the day and whether the 8879 is on file (for R48)', async () => {
  const te = await returnAt('client_review');
  const sentOn = addDays(today, -2);
  assert.equal((await send(te.id, { method: 'adobe_sign', sentOn })).statusCode, 200);
  const user = await app.db.query<{ id: string }>(`INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`, [te.contactId, te.email]);
  const { token, hash } = generateToken();
  await app.db.query(`INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [user.rows[0]!.id, hash]);
  const res = await app.inject({ method: 'GET', url: '/portal/engagements', cookies: { [PORTAL_SESSION_COOKIE]: token } });
  assert.equal(res.statusCode, 200, res.body);
  const rows = (res.json() as { engagements: Array<Record<string, unknown>> }).engagements;
  const row = rows.find((r) => r.tax_year === 2025);
  assert.ok(row, `the tax engagement is on the client's read: ${res.body}`);
  assert.equal(row!.f8879_sent_method, 'adobe_sign');
  assert.equal(row!.f8879_sent_on, sentOn);
  assert.equal(row!.f8879_on_file, false);
});

test('R53 with R16: the Trello import declares the 8879 sent with no method and the flag, once; the map lands "awaiting signature" there', async () => {
  const mapping = stageFor('awaiting signature');
  assert.ok(mapping);
  assert.equal(mapping!.stage, 'client_review', 'awaiting signature is the return delivered, 8879 out');
  assert.equal(mapping!.postImport, 'f8879_sent_declared');

  const te = await returnAt('client_review');
  const asOf = addDays(today, -5);
  const got = await declareImported8879Sent(app, { staffId: null, label: 'trello import rehearsal (synthetic)' }, { taxEngagementId: te.id, trelloCardId: 'card-sig-1', asOf });
  assert.equal(got.method, null, 'the card said nothing about how, so nothing is said');
  assert.equal(got.declaredByImport, true);
  const s = await state(te.id);
  assert.equal(s.method, null);
  assert.equal(s.sent_on, asOf, 'the day the bundle was true, not today');
  assert.equal(s.flagged, true);
  assert.equal(s.by, null);
  const rows = await audits(te.id, 'tax_engagement.f8879_sent_declared_by_import');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.details.trello_card_id, 'card-sig-1');
  const q = await queueRow(te.id);
  assert.equal(q!.awaitingSignatureText, `awaiting signature (method not recorded, sent ${dayWords(asOf)})`);

  await assert.rejects(
    () => declareImported8879Sent(app, { staffId: null, label: 'x' }, { taxEngagementId: te.id, trelloCardId: 'card-sig-1', asOf }),
    /f8879_sent_already_recorded|already records/i,
    'declared once'
  );
  // A person then records how it really went: replaces the declaration, and the audit row says what it replaced.
  const person = await send(te.id, { method: 'in_office', sentOn: today }, ana);
  assert.equal(person.statusCode, 200, person.body);
  const after = await state(te.id);
  assert.equal(after.flagged, false);
  assert.equal(after.method, 'in_office');
  const rec = await audits(te.id, 'tax_engagement.f8879_sent_recorded');
  assert.deepEqual(rec[0]!.details.replaced, { method: null, sent_on: asOf, declared_by_import: true });
  // And the declaration is refused where a person would be: before delivery.
  const early = await returnAt('in_preparation');
  await assert.rejects(
    () => declareImported8879Sent(app, { staffId: null, label: 'x' }, { taxEngagementId: early.id, trelloCardId: 'card-sig-2', asOf }),
    /f8879_sent_before_delivery|delivered to the client/i
  );
});
