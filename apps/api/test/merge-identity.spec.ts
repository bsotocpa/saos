/*
 * THE MERGE IDENTITY RULE (2026-09-12 evening, Brian).
 *
 *   Two records merge on a shared email, phone or address; a name alone never does without a
 *   reason on the record.
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
import { deriveLifecycle } from '../src/modules/crm/lifecycle.ts';

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
  config = await createTestConfig('merge_identity');
  app = buildServer(config);
  await app.ready();
  brian = await staffWithToken('brian-mergeid@example.test', 'ceo');
  ana = await staffWithToken('ana-mergeid@example.test', 'tax_preparer');
});
after(async () => { await app.close(); });

async function status(contactId: string): Promise<{ contact_status: string; soto_status: string }> {
  return (await app.db.query<{ contact_status: string; soto_status: string }>(`SELECT contact_status::text AS contact_status, soto_status::text AS soto_status FROM contacts WHERE id = $1`, [contactId])).rows[0]!;
}


// ── The merge identity rule ─────────────────────────────────────────────────────────────────

test('merge: a shared email, phone or address merges; a name alone never does without a reason on the record', async () => {
  const a = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Samename', email: 'samename-a@example.test' });
  const b = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Samename', email: 'samename-b@example.test' });
  const nameOnly = await app.inject({ method: 'POST', url: `/contacts/${a.id}/merge`, headers: auth(brian), payload: { loserIds: [b.id], reason: 'Two records for one person from the import' } });
  assert.equal(nameOnly.statusCode, 409, nameOnly.body);
  assert.equal(nameOnly.json().error, 'no_shared_identifier');
  assert.equal((await app.db.query<{ is_archived: boolean }>(`SELECT is_archived FROM contacts WHERE id = $1`, [b.id])).rows[0]!.is_archived, false, 'nothing moved');

  const overridden = await app.inject({
    method: 'POST', url: `/contacts/${a.id}/merge`, headers: auth(brian),
    payload: { loserIds: [b.id], reason: 'Two records for one person from the import', identityOverrideReason: 'The client confirmed on the phone that both records are theirs; the second email is their spouse\'s' },
  });
  assert.equal(overridden.statusCode, 200, overridden.body);
  const merged = await app.db.query<{ details: { shared_identifiers: string[]; identity_override_reason: string | null } }>(`SELECT details FROM audit_log WHERE action = 'contact.merged' AND object_id = $1`, [b.id]);
  assert.deepEqual(merged.rows[0]!.details.shared_identifiers, []);
  assert.match(merged.rows[0]!.details.identity_override_reason ?? '', /confirmed on the phone/);

  // A shared phone is enough on its own, and the audit row says which identifier it was.
  const p1 = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Phoneshare', email: 'phoneshare-1@example.test' });
  const p2 = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Phoneshare', email: 'phoneshare-2@example.test' });
  await app.db.query(`UPDATE contacts SET phone = '(312) 555-0177' WHERE id = $1`, [p1.id]);
  await app.db.query(`UPDATE contacts SET phone = '+13125550177' WHERE id = $1`, [p2.id]);
  const byPhone = await app.inject({ method: 'POST', url: `/contacts/${p1.id}/merge`, headers: auth(brian), payload: { loserIds: [p2.id], reason: 'Two records for one person from the import' } });
  assert.equal(byPhone.statusCode, 200, byPhone.body);
  const phoneAudit = await app.db.query<{ details: { shared_identifiers: string[]; identity_override_reason: string | null } }>(`SELECT details FROM audit_log WHERE action = 'contact.merged' AND object_id = $1`, [p2.id]);
  assert.deepEqual(phoneAudit.rows[0]!.details.shared_identifiers, ['phone']);
  assert.equal(phoneAudit.rows[0]!.details.identity_override_reason, null);
});
