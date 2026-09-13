/*
 * THE DUPLICATE CONTACT SCAN (2026-09-12 night, Brian's ruling 1).
 *
 *   Same-name records sharing a phone merge into the one holding the most; records sharing
 *   nothing get a note and stay; a protected name is planned first and never merged by the
 *   scan; a test record is outside the scan, neither merged nor noted.
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
import { sameNameGroups, applyDuplicatePlan } from '../src/modules/crm/duplicates.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });
const actor = () => ({ id: brian.id, email: brian.email, fullName: `${brian.fullName} (ruled 2026-09-12, applied by script)` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

before(async () => {
  config = await createTestConfig('dupscan');
  app = buildServer(config);
  await app.ready();
  brian = await staffWithToken('brian-dupscan@example.test', 'ceo');
});
after(async () => { await app.close(); });

async function twin(last: string, n: number, extra: { phone?: string; isTest?: boolean; first?: string } = {}): Promise<string> {
  const c = await makeContact(app.db, { firstName: extra.first ?? 'Synthetic', lastName: last, email: `${last.toLowerCase()}-${n}@example.test` });
  await app.db.query(`UPDATE contacts SET phone = $2, is_test = $3, test_note = CASE WHEN $3 THEN 'Synthetic test record for the duplicate scan spec' END WHERE id = $1`, [c.id, extra.phone ?? null, extra.isTest ?? false]);
  return c.id;
}

test('the scan plans from shared identifiers: a shared phone merges into the record holding the most, a name alone gets a note, a protected name is held first', async () => {
  // Sharing a phone; the second holds a business, so it wins.
  const a1 = await twin('Twinphone', 1, { phone: '(312) 555-0301' });
  const a2 = await twin('Twinphone', 2, { phone: '+1 312 555 0301' });
  const biz = await app.inject({ method: 'POST', url: `/contacts/${a2}/businesses`, headers: auth(brian), payload: { name: 'Synthetic Twinphone LLC', entityType: 'llc' } });
  assert.equal(biz.statusCode, 201, biz.body);
  // Sharing nothing.
  const b1 = await twin('Nameonly', 1);
  const b2 = await twin('Nameonly', 2);
  // A protected name, sharing a phone.
  const p1 = await twin('Flores', 1, { first: 'Jackson', phone: '312-555-0302' });
  const p2 = await twin('Flores', 2, { first: 'Jackson', phone: '312-555-0302' });
  // A test record beside a real one, sharing a phone.
  const t1 = await twin('Tester', 1, { phone: '312-555-0303' });
  const t2 = await twin('Tester', 2, { phone: '312-555-0303', isTest: true });

  const groups = await sameNameGroups(app);
  assert.equal(groups[0]!.name, 'Jackson Flores', 'the protected name sorts first');
  assert.equal(groups[0]!.protectedName, true);
  assert.deepEqual(groups[0]!.merges.map((m) => [m.winnerId, m.loserIds]), [[p1, [p2]]], 'the route would merge them; the plan says so');

  const twins = groups.find((g) => g.name === 'Synthetic Twinphone')!;
  assert.deepEqual(twins.merges.map((m) => [m.winnerId, m.loserIds]), [[a2, [a1]]], 'the record with the business wins');
  assert.deepEqual(Object.values(twins.merges[0]!.shared), [['phone']]);
  assert.deepEqual(twins.noteIds, []);

  const nameOnly = groups.find((g) => g.name === 'Synthetic Nameonly')!;
  assert.deepEqual(nameOnly.merges, [], 'a name alone never merges');
  assert.deepEqual(new Set(nameOnly.noteIds), new Set([b1, b2]));

  assert.equal(groups.find((g) => g.name === 'Synthetic Tester'), undefined, 'a test record is outside the scan; its real twin stands alone');
  assert.equal((await app.db.query<{ notes: string | null }>(`SELECT notes FROM contacts WHERE id = $1`, [t1])).rows[0]!.notes, null);
  void t2;

  // Apply: merges through the route's function, notes on the rest, the protected merge held.
  const results = await applyDuplicatePlan(app, groups, actor(), { dateIso: '2026-09-12', reason: 'The same person imported twice from the old systems; the records share a phone and nothing on either side is open' });
  const flores = results.find((r) => r.name === 'Jackson Flores')!;
  assert.equal(flores.merged.length, 0);
  assert.equal(flores.held.length, 1);
  assert.equal((await app.db.query<{ is_archived: boolean }>(`SELECT is_archived FROM contacts WHERE id = $1`, [p2])).rows[0]!.is_archived, false, 'nothing touched the protected record');

  const merged = results.find((r) => r.name === 'Synthetic Twinphone')!;
  assert.deepEqual(merged.merged, [{ winnerId: a2, loserIds: [a1] }]);
  const loser = await app.db.query<{ is_archived: boolean; merged_into_contact_id: string }>(`SELECT is_archived, merged_into_contact_id FROM contacts WHERE id = $1`, [a1]);
  assert.equal(loser.rows[0]!.is_archived, true);
  assert.equal(loser.rows[0]!.merged_into_contact_id, a2);
  const audit = await app.db.query<{ actor_label: string; details: { shared_identifiers: string[] } }>(`SELECT actor_label, details FROM audit_log WHERE action = 'contact.merged' AND object_id = $1`, [a1]);
  assert.match(audit.rows[0]!.actor_label, /applied by script\)$/, 'the row names the script');
  assert.deepEqual(audit.rows[0]!.details.shared_identifiers, ['phone']);

  const noted = results.find((r) => r.name === 'Synthetic Nameonly')!;
  assert.deepEqual(new Set(noted.noted), new Set([b1, b2]));
  for (const id of [b1, b2]) {
    const n = (await app.db.query<{ notes: string }>(`SELECT notes FROM contacts WHERE id = $1`, [id])).rows[0]!.notes;
    assert.match(n, /^Possible duplicate: same name as Synthetic Nameonly \(native, added \d{4}-\d{2}-\d{2}\); no shared email, phone or address, so not merged \(duplicate scan, 2026-09-12\)\.$/);
    assert.equal((await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'contact.updated' AND object_id = $1 AND details->'fields' ? 'notes'`, [id])).rows.length, 1);
  }
  // A protected merge runs when a person names the losing record; with the wrong id named, it still waits.
  const wrongId = await applyDuplicatePlan(app, await sameNameGroups(app), actor(), { dateIso: '2026-09-12', reason: 'The same person imported twice from the old systems; the records share a phone and nothing on either side is open', approvedLoserIds: new Set([p1]) });
  assert.equal(wrongId.find((r) => r.name === 'Jackson Flores')!.held.length, 1, 'naming the winner is not naming the loser');
  const approved = await applyDuplicatePlan(app, await sameNameGroups(app), actor(), { dateIso: '2026-09-12', reason: 'The same person imported twice from the old systems; the records share a phone and nothing on either side is open', approvedLoserIds: new Set([p2]) });
  assert.deepEqual(approved.find((r) => r.name === 'Jackson Flores')!.merged, [{ winnerId: p1, loserIds: [p2] }]);
  assert.equal((await app.db.query<{ merged_into_contact_id: string }>(`SELECT merged_into_contact_id FROM contacts WHERE id = $1`, [p2])).rows[0]!.merged_into_contact_id, p1);

  // Running it again adds nothing: the twins are merged, the notes are already there.
  const again = await applyDuplicatePlan(app, await sameNameGroups(app), actor(), { dateIso: '2026-09-12', reason: 'The same person imported twice from the old systems; the records share a phone and nothing on either side is open' });
  assert.equal(again.reduce((n, r) => n + r.merged.length + r.noted.length, 0), 0);
});

test('two identical empty records pick the same winner on every run: the id breaks the tie', async () => {
  const x1 = await twin('Tiebreak', 1, { phone: '312-555-0304' });
  const x2 = await twin('Tiebreak', 2, { phone: '312-555-0304' });
  await app.db.query(`UPDATE contacts SET created_at = '2026-07-07T12:00:00Z' WHERE id = ANY($1::uuid[])`, [[x1, x2]]);
  const first = (await sameNameGroups(app)).find((g) => g.name === 'Synthetic Tiebreak')!.merges[0]!;
  const second = (await sameNameGroups(app)).find((g) => g.name === 'Synthetic Tiebreak')!.merges[0]!;
  assert.equal(first.winnerId, second.winnerId);
  assert.equal(first.winnerId, [x1, x2].sort()[0], 'the lower id wins a dead tie');
});
