/*
 * EDIT A BUSINESS AFTER CREATE (Brian, 2026-09-20).
 *
 *   PATCH /businesses/:id opens for the same grants as Add (contacts.write or businesses.write) and
 *   refuses a role holding neither; a formation date and an industry skipped at creation are filled
 *   in by editing, with the same provenance the create route stamps; an EIN is stored in one
 *   spelling and a change to it gets an audit row naming the field and never the number; a
 *   duplicate EIN warns and does not refuse (R54, 2026-09-26): Add and Edit both go through with a
 *   standalone reason, audited beside the other business's id, and are refused by that business's
 *   name without one; the Missing line's business gaps are computed from the primary business and
 *   follow a change of primary.
 *
 * Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let laura: TestStaff & { token: string };
let marian: TestStaff & { token: string };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

async function addBusiness(contactId: string, payload: Record<string, unknown>, who: { token: string } = brian): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `/contacts/${contactId}/businesses`, headers: auth(who), payload });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
}

before(async () => {
  config = await createTestConfig('business_edit');
  app = buildServer(config);
  await app.ready();
  brian = await staffWithToken('brian-bizedit@example.test', 'ceo');
  laura = await staffWithToken('laura-bizedit@example.test', 'va_entity');
  marian = await staffWithToken('marian-bizedit@example.test', 'bookkeeper');
});
after(async () => { await app.close(); });

test('the entity VA fills in a formation date and an industry skipped at creation; the bookkeeper is refused and nothing moves', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Editbiz', email: 'editbiz@example.test' });
  const id = await addBusiness(c.id, { name: 'Synthetic Edit LLC', entityType: 'llc', state: 'IL' });

  const refused = await app.inject({ method: 'PATCH', url: `/businesses/${id}`, headers: auth(marian), payload: { industry: 'food_beverage' } });
  assert.equal(refused.statusCode, 403, refused.body);
  assert.match(refused.json().message, /contacts\.write or businesses\.write/);

  const edited = await app.inject({ method: 'PATCH', url: `/businesses/${id}`, headers: auth(laura), payload: { formationDate: '2019-06-03', industry: 'food_beverage' } });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.deepEqual(edited.json().fields.sort(), ['formation_date', 'formation_date_recorded_at', 'formation_date_source', 'industry']);

  const row = await app.db.query<{ formation_date: string; formation_date_source: string; industry: string }>(
    `SELECT formation_date::text AS formation_date, formation_date_source::text AS formation_date_source, industry FROM businesses WHERE id = $1`, [id]);
  assert.equal(row.rows[0]!.formation_date, '2019-06-03');
  assert.equal(row.rows[0]!.formation_date_source, 'staff_verified', 'the same provenance the create route stamps');
  assert.equal(row.rows[0]!.industry, 'food_beverage');

  // The record reads it back with the date, for the card.
  const detail = await app.inject({ method: 'GET', url: `/contacts/${c.id}`, headers: auth(brian) });
  const biz = (detail.json().businesses as Array<{ id: string; formation_date: string | null; industry: string | null }>).find((b) => b.id === id)!;
  assert.equal(biz.formation_date, '2019-06-03', 'a DATE column leaves as a calendar day');

  const future = await app.inject({ method: 'PATCH', url: `/businesses/${id}`, headers: auth(laura), payload: { formationDate: '2999-01-01' } });
  assert.equal(future.statusCode, 400, future.body);
  assert.equal(future.json().error, 'formation_date_in_future');
  assert.equal(future.json().message, 'A formation date is a thing that already happened.');
});

test('an EIN is stored in one spelling and its change is audited by name without the number', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Einedit', email: 'einedit@example.test' });
  const first = await addBusiness(c.id, { name: 'Synthetic First EIN LLC', entityType: 'llc', state: 'IL' });

  const set = await app.inject({ method: 'PATCH', url: `/businesses/${first}`, headers: auth(brian), payload: { ein: '987654321' } });
  assert.equal(set.statusCode, 200, set.body);
  const stored = await app.db.query<{ ein: string }>(`SELECT ein FROM businesses WHERE id = $1`, [first]);
  assert.equal(stored.rows[0]!.ein, '98-7654321', 'the hyphenated spelling, whatever was typed');

  const audit = await app.db.query<{ details: Record<string, unknown>; actor_label: string; contact_id: string }>(
    `SELECT details, actor_label, contact_id FROM audit_log WHERE action = 'business.ein_changed' AND object_id = $1`, [first]);
  assert.equal(audit.rows.length, 1, 'one row for the change');
  assert.equal(audit.rows[0]!.details.field, 'ein');
  assert.equal(audit.rows[0]!.details.previously_on_file, false);
  assert.equal(audit.rows[0]!.contact_id, c.id);
  assert.equal(audit.rows[0]!.actor_label, brian.fullName);
  assert.ok(!JSON.stringify(audit.rows[0]!.details).includes('7654321'), 'the number is not in the row');

  // Re-saving the same EIN on the same business is not a change and not a duplicate.
  const same = await app.inject({ method: 'PATCH', url: `/businesses/${first}`, headers: auth(brian), payload: { ein: '98-7654321', industry: 'retail' } });
  assert.equal(same.statusCode, 200, same.body);
  const again = await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE action = 'business.ein_changed' AND object_id = $1`, [first]);
  assert.equal(Number(again.rows[0]!.n), 1, 'no second change row for the same number');
});

/**
 * R54 (Brian, 2026-09-26): a duplicate EIN WARNS and does not refuse. The check endpoint names the
 * business holding the number and its owner (for the warning's link); Add and Edit go through with a
 * standalone reason and are audited beside the other business's id; without the reason they are refused
 * by the other business's name. The number itself is in no response, no message and no audit row.
 */
test('R54 the EIN check names the holder and its owner; Add a business with the same EIN needs a reason and is audited', async () => {
  const owner = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Einholder', email: 'einholder@example.test' });
  const holder = await addBusiness(owner.id, { name: 'Synthetic Holder EIN LLC', entityType: 'llc', state: 'IL', ein: '98-1112223' });

  // The question the form asks as the number is typed: either spelling, the holder and its owner.
  const check = await app.inject({ method: 'GET', url: '/businesses/ein-check?ein=981112223', headers: auth(brian) });
  assert.equal(check.statusCode, 200, check.body);
  assert.deepEqual(check.json().duplicate, {
    businessId: holder, name: 'Synthetic Holder EIN LLC', ownerContactId: owner.id, ownerName: 'Synthetic Einholder',
  });
  assert.ok(!check.body.includes('1112223'), 'the answer carries the holder, never the number');
  const free = await app.inject({ method: 'GET', url: '/businesses/ein-check?ein=98-1112224', headers: auth(brian) });
  assert.equal(free.statusCode, 200);
  assert.equal(free.json().duplicate, null);
  const badShape = await app.inject({ method: 'GET', url: '/businesses/ein-check?ein=12', headers: auth(brian) });
  assert.equal(badShape.statusCode, 400);
  // Laura holds businesses.write and asks the same question at the same door; the bookkeeper is refused.
  assert.equal((await app.inject({ method: 'GET', url: '/businesses/ein-check?ein=981112223', headers: auth(laura) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/businesses/ein-check?ein=981112223', headers: auth(marian) })).statusCode, 403);

  // Add a business with the same number and no reason: refused, naming the holder, never the number.
  const other = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Einsecond', email: 'einsecond@example.test' });
  const noReason = await app.inject({ method: 'POST', url: `/contacts/${other.id}/businesses`, headers: auth(brian),
    payload: { name: 'Synthetic Second Holder LLC', entityType: 'llc', state: 'IL', ein: '981112223' } });
  assert.equal(noReason.statusCode, 409, noReason.body);
  assert.equal(noReason.json().error, 'ein_in_use');
  assert.match(noReason.json().message, /Synthetic Holder EIN LLC/);
  assert.match(noReason.json().message, /create anyway/);
  assert.ok(!noReason.json().message.includes('1112223'), 'the refusal names the business, never the number');
  const tooShort = await app.inject({ method: 'POST', url: `/contacts/${other.id}/businesses`, headers: auth(brian),
    payload: { name: 'Synthetic Second Holder LLC', entityType: 'llc', state: 'IL', ein: '981112223', duplicateReason: 'because' } });
  assert.equal(tooShort.statusCode, 400, 'a reason is a sentence, not a word');
  assert.equal(tooShort.json().issues[0].path, 'duplicateReason');

  // With the reason: created, and audited beside the holder's id.
  const withReason = await app.inject({ method: 'POST', url: `/contacts/${other.id}/businesses`, headers: auth(brian),
    payload: { name: 'Synthetic Second Holder LLC', entityType: 'llc', state: 'IL', ein: '981112223',
      duplicateReason: 'The state issued the same number to a successor entity after the first was dissolved.' } });
  assert.equal(withReason.statusCode, 201, withReason.body);
  const audit = await app.db.query<{ details: Record<string, unknown>; actor_label: string; contact_id: string }>(
    `SELECT details, actor_label, contact_id FROM audit_log WHERE action = 'business.ein_duplicate_accepted' AND object_id = $1`, [withReason.json().id]);
  assert.equal(audit.rows.length, 1, 'one acceptance row');
  assert.equal(audit.rows[0]!.details.field, 'ein');
  assert.equal(audit.rows[0]!.details.other_business_id, holder);
  assert.match(String(audit.rows[0]!.details.reason), /successor entity/);
  assert.equal(audit.rows[0]!.contact_id, other.id);
  assert.equal(audit.rows[0]!.actor_label, brian.fullName);
  assert.ok(!JSON.stringify(audit.rows[0]!.details).includes('1112223'), 'the number is not in the row');

  // A number nobody else holds needs no reason, and a reason sent with it writes no acceptance row.
  const plain = await app.inject({ method: 'POST', url: `/contacts/${other.id}/businesses`, headers: auth(brian),
    payload: { name: 'Synthetic Third Holder LLC', entityType: 'llc', state: 'IL', ein: '981112225', duplicateReason: 'A reason nobody asked for, ten words long.' } });
  assert.equal(plain.statusCode, 201, plain.body);
  const none = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'business.ein_duplicate_accepted' AND object_id = $1`, [plain.json().id]);
  assert.equal(none.rows[0]!.n, 0);
});

test('R54 Edit follows the same rule: the check excludes the business being edited; a duplicate saves only with a reason, audited', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Eineditdup', email: 'eineditdup@example.test' });
  const first = await addBusiness(c.id, { name: 'Synthetic Edit First LLC', entityType: 'llc', state: 'IL', ein: '98-2223334' });
  const second = await addBusiness(c.id, { name: 'Synthetic Edit Second LLC', entityType: 'llc', state: 'IL' });

  // Asked from the first business's own Edit form, its own number is not a duplicate.
  const self = await app.inject({ method: 'GET', url: `/businesses/ein-check?ein=982223334&exceptBusinessId=${first}`, headers: auth(brian) });
  assert.equal(self.json().duplicate, null);
  const fromSecond = await app.inject({ method: 'GET', url: `/businesses/ein-check?ein=982223334&exceptBusinessId=${second}`, headers: auth(brian) });
  assert.equal(fromSecond.json().duplicate.businessId, first);
  assert.equal(fromSecond.json().duplicate.ownerContactId, c.id);

  const noReason = await app.inject({ method: 'PATCH', url: `/businesses/${second}`, headers: auth(brian), payload: { ein: '98-2223334' } });
  assert.equal(noReason.statusCode, 409, noReason.body);
  assert.equal(noReason.json().error, 'ein_in_use');
  assert.match(noReason.json().message, /Synthetic Edit First LLC/);
  assert.match(noReason.json().message, /save anyway/);
  assert.ok(!noReason.json().message.includes('2223334'));
  const unchanged = await app.db.query<{ ein: string | null }>(`SELECT ein FROM businesses WHERE id = $1`, [second]);
  assert.equal(unchanged.rows[0]!.ein, null, 'the refused save wrote nothing');

  const withReason = await app.inject({ method: 'PATCH', url: `/businesses/${second}`, headers: auth(brian),
    payload: { ein: '982223334', duplicateReason: 'Both entities are the same taxpayer under one number; the record is being aligned.' } });
  assert.equal(withReason.statusCode, 200, withReason.body);
  assert.deepEqual(withReason.json().fields, ['ein']);
  const saved = await app.db.query<{ ein: string | null }>(`SELECT ein FROM businesses WHERE id = $1`, [second]);
  assert.equal(saved.rows[0]!.ein, '98-2223334');
  const accepted = await app.db.query<{ details: Record<string, unknown> }>(
    `SELECT details FROM audit_log WHERE action = 'business.ein_duplicate_accepted' AND object_id = $1`, [second]);
  assert.equal(accepted.rows.length, 1);
  assert.equal(accepted.rows[0]!.details.other_business_id, first);
  assert.match(String(accepted.rows[0]!.details.reason), /same taxpayer/);
  assert.ok(!JSON.stringify(accepted.rows[0]!.details).includes('2223334'));
  const changed = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'business.ein_changed' AND object_id = $1`, [second]);
  assert.equal(changed.rows[0]!.n, 1, 'the change row is written as for any EIN change');
});

test('the Missing line is computed from the primary business and follows a change of primary', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Primarygaps', email: 'primarygaps@example.test' });
  await app.db.query(`UPDATE contacts SET phone = '+13125550199' WHERE id = $1`, [c.id]);
  const complete = await addBusiness(c.id, { name: 'Synthetic Complete LLC', entityType: 'llc', state: 'IL', ein: '11-2233445', industry: 'retail' });
  const partial = await addBusiness(c.id, { name: 'Synthetic Partial LLC', entityType: 'llc', state: 'IL' });

  const gaps = async () => (await app.inject({ method: 'GET', url: `/contacts/${c.id}`, headers: auth(brian) })).json().enrichmentGaps as string[];
  assert.deepEqual(await gaps(), [], 'the first business is primary and complete: the second one\'s gaps are not on the line');

  const swap = await app.inject({ method: 'POST', url: `/contacts/${c.id}/primary-business`, headers: auth(brian), payload: { businessId: partial } });
  assert.equal(swap.statusCode, 200, swap.body);
  assert.deepEqual(await gaps(), ['business:ein', 'business:industry'], 'the line follows the primary');

  const fill = await app.inject({ method: 'PATCH', url: `/businesses/${partial}`, headers: auth(brian), payload: { ein: '55-6677889', industry: 'consulting' } });
  assert.equal(fill.statusCode, 200, fill.body);
  assert.deepEqual(await gaps(), [], 'editing the primary clears its gaps');

  const archived = await app.inject({ method: 'POST', url: `/businesses/${partial}/archive`, headers: auth(brian), payload: { reason: 'Entered twice while onboarding; the other row is the company' } });
  assert.equal(archived.statusCode, 200, archived.body);
  assert.deepEqual(await gaps(), [], 'no primary set: no business gap is asserted about a business nobody chose');
  assert.ok(complete, 'the complete business is still on the record');
});
