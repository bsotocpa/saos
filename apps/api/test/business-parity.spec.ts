/*
 * BUSINESS PARITY WITH CONTACTS (2026-09-12 evening, Brian's ruling 3).
 *
 *   Archive (never delete), test flag with note, merge, one primary per contact at the
 *   database; archiving the primary clears the flag and promotes nothing.
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
import type { AuthedStaff } from '../src/types.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { businessReferences } from '../src/modules/crm/businesses.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let ana: TestStaff & { token: string };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });
const actorOf = (t: TestStaff): AuthedStaff => ({ id: t.id, email: t.email, fullName: t.fullName, roleKey: 'ceo', permissions: ['*'], sessionId: 'spec' });
const WHY = 'The client engaged by phone this morning; the quote follows tomorrow';

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

before(async () => {
  config = await createTestConfig('business_parity');
  app = buildServer(config);
  await app.ready();
  brian = await staffWithToken('brian-bizparity@example.test', 'ceo');
  ana = await staffWithToken('ana-bizparity@example.test', 'tax_preparer');
});
after(async () => { await app.close(); });

async function status(contactId: string): Promise<{ contact_status: string; soto_status: string }> {
  return (await app.db.query<{ contact_status: string; soto_status: string }>(`SELECT contact_status::text AS contact_status, soto_status::text AS soto_status FROM contacts WHERE id = $1`, [contactId])).rows[0]!;
}


// ── 3. Businesses ───────────────────────────────────────────────────────────────────────────

async function addBusiness(contactId: string, name: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `/contacts/${contactId}/businesses`, headers: auth(brian), payload: { name, entityType: 'llc' } });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
}
async function pageBusinesses(contactId: string): Promise<Array<{ id: string; is_primary: boolean; is_test: boolean }>> {
  const res = await app.inject({ method: 'GET', url: `/contacts/${contactId}`, headers: auth(brian) });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().businesses;
}

test('3: exactly one primary business per contact, at the database; archiving the primary clears the flag and promotes nothing', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Owner', email: 'owner-bizparity@example.test' });
  const first = await addBusiness(c.id, 'Synthetic First LLC');
  const second = await addBusiness(c.id, 'Synthetic Second LLC');
  let page = await pageBusinesses(c.id);
  assert.deepEqual(page.map((b) => [b.id, b.is_primary]), [[first, true], [second, false]], 'the first business is primary, the second is not');

  await assert.rejects(
    app.db.query(`UPDATE business_members SET is_primary = true WHERE contact_id = $1 AND business_id = $2`, [c.id, second]),
    (e: { code?: string; message?: string }) => e.code === '23514' && /^one_primary_business:/.test(e.message ?? ''),
    'a second primary is refused at the database'
  );

  // A person chooses; the previous primary is cleared in the same breath.
  const chosen = await app.inject({ method: 'POST', url: `/contacts/${c.id}/primary-business`, headers: auth(brian), payload: { businessId: second } });
  assert.equal(chosen.statusCode, 200, chosen.body);
  page = await pageBusinesses(c.id);
  assert.deepEqual(page.map((b) => [b.id, b.is_primary]), [[second, true], [first, false]]);

  // A person can also clear the primary outright: nothing is promoted.
  const cleared = await app.inject({ method: 'POST', url: `/contacts/${c.id}/primary-business`, headers: auth(brian), payload: { businessId: null } });
  assert.equal(cleared.statusCode, 200, cleared.body);
  page = await pageBusinesses(c.id);
  assert.deepEqual(page.map((b) => b.is_primary), [false, false], 'no primary business set');
  const rechosen = await app.inject({ method: 'POST', url: `/contacts/${c.id}/primary-business`, headers: auth(brian), payload: { businessId: second } });
  assert.equal(rechosen.statusCode, 200, rechosen.body);

  // Archiving the primary: the flag clears, nothing is promoted, the page says so.
  const noNote = await app.inject({ method: 'POST', url: `/businesses/${second}/archive`, headers: auth(brian), payload: { reason: 'Dissolved with the state last year; no filings remain', isTest: true } });
  assert.equal(noNote.statusCode, 400, noNote.body);
  const archived = await app.inject({ method: 'POST', url: `/businesses/${second}/archive`, headers: auth(brian), payload: { reason: 'Dissolved with the state last year; no filings remain' } });
  assert.equal(archived.statusCode, 200, archived.body);
  assert.equal(archived.json().primaryCleared, 1);
  page = await pageBusinesses(c.id);
  assert.deepEqual(page.map((b) => [b.id, b.is_primary]), [[first, false]], 'the archived business leaves the page; the remaining one is NOT promoted');
  const row = await app.db.query<{ is_archived: boolean; archived_reason: string; is_primary: boolean }>(
    `SELECT b.is_archived, b.archived_reason, m.is_primary FROM businesses b JOIN business_members m ON m.business_id = b.id WHERE b.id = $1`, [second]);
  assert.equal(row.rows[0]!.is_archived, true);
  assert.equal(row.rows[0]!.is_primary, false);
  assert.equal((await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'business.primary_cleared' AND object_id = $1 AND details->>'reason' = 'archived'`, [second])).rows.length, 1);
  assert.equal((await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'business.archived' AND object_id = $1`, [second])).rows.length, 1);
  const twice = await app.inject({ method: 'POST', url: `/businesses/${second}/archive`, headers: auth(brian), payload: { reason: 'Dissolved with the state last year; no filings remain' } });
  assert.equal(twice.statusCode, 409);
  const picker = await app.inject({ method: 'GET', url: '/businesses?search=Synthetic%20Second', headers: auth(brian) });
  assert.equal(picker.json().businesses.length, 0, 'archived businesses leave every picker');

  // Test residue carries its note; a business holding active work does not archive.
  const test = await app.inject({ method: 'POST', url: `/businesses/${first}/archive`, headers: auth(brian), payload: { reason: 'Created while trying the business form; not a real entity', isTest: true, testNote: 'Trying the business form on 2026-09-12; no real entity.' } });
  assert.equal(test.statusCode, 200, test.body);
  const flagged = await app.db.query<{ is_test: boolean; test_note: string }>(`SELECT is_test, test_note FROM businesses WHERE id = $1`, [first]);
  assert.equal(flagged.rows[0]!.is_test, true);
  assert.match(flagged.rows[0]!.test_note, /Trying the business form/);

  const w = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Working', email: 'working-bizparity@example.test' });
  const busy = await addBusiness(w.id, 'Synthetic Busy LLC');
  await createEngagement(app, actorOf(brian), { contactId: w.id, businessId: busy, serviceLine: 'bookkeeping', status: 'active', periodKey: 'ongoing', origin: { via: 'staff', reason: WHY } }, {});
  const refused = await app.inject({ method: 'POST', url: `/businesses/${busy}/archive`, headers: auth(brian), payload: { reason: 'Dissolved with the state last year; no filings remain' } });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().error, 'business_has_active_work');
});

test('3: two businesses merge the way two contacts do: rows move, one audit row per object, the loser archived pointing at the winner, nothing left behind', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Twice', email: 'twice-bizparity@example.test' });
  const winner = await addBusiness(c.id, 'Synthetic Incorporated');
  const loser = await addBusiness(c.id, 'synthetic incorporated');
  const eng = await createEngagement(app, actorOf(brian), { contactId: c.id, businessId: loser, serviceLine: 'bookkeeping', status: 'active', periodKey: 'ongoing', origin: { via: 'staff', reason: WHY } }, {});
  await app.db.query(`INSERT INTO documents (contact_id, business_id, category, filename, minio_bucket, minio_key, uploaded_by_type) VALUES ($1, $2, 'business_records', 'articles.pdf', 'saos-documents', 'test/articles.pdf', 'staff')`, [c.id, loser]);

  const merged = await app.inject({ method: 'POST', url: `/businesses/${winner}/merge`, headers: auth(brian), payload: { loserIds: [loser], reason: 'The same company entered twice on the same day; one EIN, one entity' } });
  assert.equal(merged.statusCode, 200, merged.body);
  assert.deepEqual(merged.json().losers[0].moved, { engagements: 1, documents: 1 }, 'the shared membership collapsed rather than moved');

  assert.equal((await app.db.query<{ business_id: string }>(`SELECT business_id FROM engagements WHERE id = $1`, [eng.id])).rows[0]!.business_id, winner);
  const lost = await app.db.query<{ is_archived: boolean; merged_into_business_id: string; archived_reason: string }>(`SELECT is_archived, merged_into_business_id, archived_reason FROM businesses WHERE id = $1`, [loser]);
  assert.equal(lost.rows[0]!.is_archived, true);
  assert.equal(lost.rows[0]!.merged_into_business_id, winner);
  assert.match(lost.rows[0]!.archived_reason, /^Merged into Synthetic Incorporated:/);
  assert.deepEqual(await businessReferences(app, loser), {}, 'nothing left on the loser');
  const members = await app.db.query<{ business_id: string; is_primary: boolean }>(`SELECT business_id, is_primary FROM business_members WHERE contact_id = $1`, [c.id]);
  assert.deepEqual(members.rows, [{ business_id: winner, is_primary: true }], 'one membership, still primary');
  assert.equal((await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'business.merged' AND object_id = $1`, [loser])).rows.length, 1);
  assert.equal((await app.db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'business.merged_object' AND details->>'from' = $1`, [loser])).rows[0]!.n, 2, 'one audit row per moved object');
  assert.equal((await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'business.merged_duplicate_membership' AND object_id = $1`, [winner])).rows.length, 1);
  const page = await pageBusinesses(c.id);
  assert.deepEqual(page.map((b) => b.id), [winner]);
});
