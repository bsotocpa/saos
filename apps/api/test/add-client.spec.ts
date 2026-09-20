/*
 * ADD A CLIENT, AND THE DUPLICATE CHECK IN FRONT OF IT (Brian, ruling R14, 2026-09-20).
 *
 *   the check answers with the record's id and WHY it is a likely duplicate — the same normalized
 *   name, the same email, the same phone in any spelling (the merge's own ten-digit rule);
 *   an archived record is not offered (nobody can open it), a test record is out on a name alone
 *   and in when it shares an email or a phone (then the twin being typed is the rehearsal);
 *   creating anyway is recorded on the creation's audit row, so a merge later knows the twin was
 *   seen; and a role without contacts.write is refused at both doors.
 *
 * Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let marian: TestStaff & { token: string };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

interface Duplicate {
  id: string; firstName: string; lastName: string; email: string | null; phone: string | null;
  isTest: boolean; reasons: string[]; reason: string;
}

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

/** The route, not an INSERT: this is the door the screen uses. */
async function addClient(payload: Record<string, unknown>): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/contacts', headers: auth(brian), payload });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
}

async function checkFor(q: Record<string, string>, who: { token: string } = brian): Promise<Duplicate[]> {
  const res = await app.inject({ method: 'GET', url: `/contacts/duplicate-check?${new URLSearchParams(q)}`, headers: auth(who) });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().duplicates as Duplicate[];
}

before(async () => {
  config = await createTestConfig('addclient');
  app = buildServer(config);
  await app.ready();
  brian = await staffWithToken('brian-addclient@example.test', 'ceo');
  marian = await staffWithToken('marian-addclient@example.test', 'bookkeeper');
});
after(async () => { await app.close(); });

test('the duplicate check answers with the record and why: the same normalized name, the same email, the same phone in another spelling', async () => {
  const id = await addClient({
    firstName: 'Synthetic', lastName: 'Checkname', email: 'checkname@example.test', phone: '(312) 555-0401', language: 'en',
  });

  // The name as typed, spelled differently: extra spaces and other case are one name.
  const byName = await checkFor({ firstName: '  synthetic ', lastName: 'CHECKNAME' });
  assert.equal(byName.length, 1, JSON.stringify(byName));
  assert.equal(byName[0]!.id, id);
  assert.deepEqual(byName[0]!.reasons, ['name']);
  assert.equal(byName[0]!.reason, 'the same name');

  // A different person's name, the same email: still the same person.
  const byEmail = await checkFor({ firstName: 'Synthetic', lastName: 'Elsewhere', email: 'CheckName@Example.Test' });
  assert.equal(byEmail.length, 1);
  assert.equal(byEmail[0]!.id, id);
  assert.deepEqual(byEmail[0]!.reasons, ['email']);

  // The phone with a country code and no punctuation — the merge's ten-digit comparison.
  const byPhone = await checkFor({ firstName: 'Synthetic', lastName: 'Elsewhere', phone: '+1 3125550401' });
  assert.equal(byPhone.length, 1);
  assert.equal(byPhone[0]!.id, id);
  assert.deepEqual(byPhone[0]!.reasons, ['phone']);

  // Everything at once: the reasons stack and the sentence reads as one.
  const all = await checkFor({ firstName: 'Synthetic', lastName: 'Checkname', email: 'checkname@example.test', phone: '312-555-0401' });
  assert.equal(all.length, 1);
  assert.deepEqual(all[0]!.reasons, ['name', 'email', 'phone']);
  assert.equal(all[0]!.reason, 'the same name, the same email address and the same phone number');

  // A partial phone is not a number yet, and a name nobody holds is nobody.
  assert.deepEqual(await checkFor({ phone: '555-0401' }), []);
  assert.deepEqual(await checkFor({ firstName: 'Synthetic', lastName: 'Nobodyhere' }), []);
  // A first name with no last name is not a name: the check asks a real question or none.
  assert.deepEqual(await checkFor({ firstName: 'Synthetic' }), []);
  assert.deepEqual(await checkFor({}), []);
});

test('an archived record is not offered; a test record is out on a name alone and in when it shares a phone', async () => {
  const archived = await addClient({ firstName: 'Synthetic', lastName: 'Gonearchived', email: 'gonearchived@example.test' });
  const res = await app.inject({
    method: 'POST', url: `/contacts/${archived}/archive`, headers: auth(brian),
    payload: { reason: 'Synthetic record archived by the add-a-client spec to prove the check skips it.' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(await checkFor({ firstName: 'Synthetic', lastName: 'Gonearchived' }), []);
  assert.deepEqual(await checkFor({ firstName: 'Synthetic', lastName: 'Gonearchived', email: 'gonearchived@example.test' }), []);

  const rehearsal = await addClient({ firstName: 'Synthetic', lastName: 'Rehearsal', phone: '312-555-0402' });
  await app.db.query(
    `UPDATE contacts SET is_test = true, test_note = 'Synthetic rehearsal record for the add-a-client spec' WHERE id = $1`,
    [rehearsal]
  );
  // A name alone: rehearsal residue is not a person.
  assert.deepEqual(await checkFor({ firstName: 'Synthetic', lastName: 'Rehearsal' }), []);
  // The same phone: now the thing being typed IS the rehearsal, and the check says so.
  const shared = await checkFor({ firstName: 'Synthetic', lastName: 'Rehearsal', phone: '(312) 555-0402' });
  assert.equal(shared.length, 1);
  assert.equal(shared[0]!.id, rehearsal);
  assert.equal(shared[0]!.isTest, true);
  assert.deepEqual(shared[0]!.reasons, ['name', 'phone']);
});

test('created anyway: the acknowledgement lands on the creation audit row, and a plain creation carries no such claim', async () => {
  const first = await addClient({ firstName: 'Synthetic', lastName: 'Anyway', email: 'anyway-1@example.test' });
  const found = await checkFor({ firstName: 'Synthetic', lastName: 'Anyway' });
  assert.equal(found.length, 1);
  assert.equal(found[0]!.id, first);

  const second = await addClient({
    firstName: 'Synthetic', lastName: 'Anyway', email: 'anyway-2@example.test',
    duplicateAcknowledged: true, duplicateIds: [first],
  });
  const { rows } = await app.db.query<{ details: { duplicate_acknowledged?: boolean; duplicateIds?: string[] } | null }>(
    `SELECT details FROM audit_log WHERE action = 'contact.created' AND object_id = $1`, [second]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.details?.duplicate_acknowledged, true);
  assert.deepEqual(rows[0]!.details?.duplicateIds, [first]);

  const plain = await app.db.query<{ details: Record<string, unknown> | null }>(
    `SELECT details FROM audit_log WHERE action = 'contact.created' AND object_id = $1`, [first]
  );
  assert.equal(plain.rows.length, 1);
  assert.equal(plain.rows[0]!.details?.['duplicate_acknowledged'], undefined);

  // Both records are in the book, and the check now offers the pair to whoever types the name next.
  const both = await checkFor({ firstName: 'Synthetic', lastName: 'Anyway' });
  assert.equal(both.length, 2);
  assert.deepEqual([...both.map((d) => d.id)].sort(), [first, second].sort());
});

test('the bookkeeper holds no contacts.write: both doors refuse her', async () => {
  const check = await app.inject({
    method: 'GET', url: '/contacts/duplicate-check?firstName=Synthetic&lastName=Checkname', headers: auth(marian),
  });
  assert.equal(check.statusCode, 403, check.body);
  const create = await app.inject({
    method: 'POST', url: '/contacts', headers: auth(marian),
    payload: { firstName: 'Synthetic', lastName: 'Refusedbookkeeper' },
  });
  assert.equal(create.statusCode, 403, create.body);
});
