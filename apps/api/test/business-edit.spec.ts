/*
 * EDIT A BUSINESS AFTER CREATE (Brian, 2026-09-20).
 *
 *   PATCH /businesses/:id opens for the same grants as Add (contacts.write or businesses.write) and
 *   refuses a role holding neither; a formation date and an industry skipped at creation are filled
 *   in by editing, with the same provenance the create route stamps; an EIN is stored in one
 *   spelling, refused when another open business already carries it, and a change to it gets an
 *   audit row naming the field and never the number; the Missing line's business gaps are computed
 *   from the primary business and follow a change of primary.
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

test('an EIN is stored in one spelling, its change is audited by name without the number, and a duplicate is refused on edit (create is unchanged)', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Einedit', email: 'einedit@example.test' });
  const first = await addBusiness(c.id, { name: 'Synthetic First EIN LLC', entityType: 'llc', state: 'IL' });
  const second = await addBusiness(c.id, { name: 'Synthetic Second EIN LLC', entityType: 'llc', state: 'IL' });

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

  // The same number typed onto ANOTHER business on an edit is a typo, refused by name, never by number.
  const dupEdit = await app.inject({ method: 'PATCH', url: `/businesses/${second}`, headers: auth(brian), payload: { ein: '98-7654321' } });
  assert.equal(dupEdit.statusCode, 409, dupEdit.body);
  assert.equal(dupEdit.json().error, 'ein_in_use');
  assert.match(dupEdit.json().message, /Synthetic First EIN LLC/);
  assert.ok(!dupEdit.json().message.includes('7654321'), 'the refusal names the business, never the number');
  // Add a business is unchanged: a duplicate EIN on CREATE is not refused today (a refusal there is a
  // new rule for Brian, in the shape of Add a client's likely-duplicate line); the number is normalized.
  const dupCreate = await app.inject({ method: 'POST', url: `/contacts/${c.id}/businesses`, headers: auth(brian), payload: { name: 'Synthetic Third EIN LLC', entityType: 'llc', state: 'IL', ein: '987654322' } });
  assert.equal(dupCreate.statusCode, 201, dupCreate.body);

  // Re-saving the same EIN on the same business is not a change and not a duplicate.
  const same = await app.inject({ method: 'PATCH', url: `/businesses/${first}`, headers: auth(brian), payload: { ein: '98-7654321', industry: 'retail' } });
  assert.equal(same.statusCode, 200, same.body);
  const again = await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE action = 'business.ein_changed' AND object_id = $1`, [first]);
  assert.equal(Number(again.rows[0]!.n), 1, 'no second change row for the same number');
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
