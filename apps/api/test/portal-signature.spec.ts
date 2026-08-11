// Portal-native E-SIGN / UETA signature for engagement packets (Option 2).
//
// The claim being tested is not "a signature was stored". It is that this is a
// DEFENSIBLE signature: intent, consent, attribution from the session, an immutable
// retained copy, and — the load-bearing one — that a client can never be bound to
// text other than what they read.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { createPacket } from '../src/modules/engagements/packet.ts';
import type { AuthedStaff } from '../src/types.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let ceo: AuthedStaff;

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${role}`, role, password: `${role}-password-1234567`, totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

async function portalSession(contactId: string, email: string): Promise<string> {
  const pu = await app.db.query<{ id: string }>(
    `INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`,
    [contactId, email]
  );
  const token = randomBytes(32).toString('base64url');
  await app.db.query(
    `INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '1 hour')`,
    [pu.rows[0]!.id, createHash('sha256').update(token).digest('hex')]
  );
  return token;
}

/** A client with a packet ready to sign, plus a portal cookie. */
async function ready(name: string, lines: string[]) {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: name, email: `${name.toLowerCase()}@example.test`,
  });
  for (const line of lines) {
    await createEngagement(app, ceo, { contactId: c.id, serviceLine: line as 'tax', status: 'active' }, {});
  }
  const packet = await createPacket(app, c.id, ceo);
  const cookie = { cookie: `saos_portal_session=${await portalSession(c.id, `${name.toLowerCase()}@example.test`)}` };
  return { contactId: c.id, packetId: packet.packetId, cookie };
}

const SIGN = { signedName: 'Synthetic Signer', intentAffirmed: true, esignConsentAck: true };

before(async () => {
  config = await createTestConfig('portalsig');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  brian = await staffWithToken('brian-sig@example.test', 'ceo');
  ceo = { id: brian.id, email: brian.email, permissions: ['*'], roleKey: 'ceo' } as AuthedStaff;
});

after(async () => {
  await app.close();
});

test('the client is shown the document and the hash their signature must carry', async () => {
  const { cookie } = await ready('PresentsDoc', ['tax']);
  const res = await app.inject({ method: 'GET', url: '/portal/packet', headers: cookie });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as {
    html: string; documentSha256: string; scheduleCodes: string[];
    sections: Array<{ code: string | null }>; alreadySigned: boolean;
    affirmations: { intent: string; esignConsent: string };
  };
  assert.match(body.documentSha256, /^[0-9a-f]{64}$/);
  assert.equal(body.documentSha256, createHash('sha256').update(body.html, 'utf8').digest('hex'));
  assert.deepEqual(body.scheduleCodes, ['A']);
  assert.equal(body.alreadySigned, false);
  // The affirmation wording is server-supplied so the portal cannot invent its own.
  assert.match(body.affirmations.intent, /intend to be bound/i);
  assert.match(body.affirmations.esignConsent, /paper copy/i);
});

test('a signature records intent, consent, attribution, the hash, and a retained copy', async () => {
  const { contactId, packetId, cookie } = await ready('SignsIt', ['bookkeeping']);
  const presented = (await app.inject({ method: 'GET', url: '/portal/packet', headers: cookie })).json() as
    { documentSha256: string };

  const res = await app.inject({
    method: 'POST', url: '/portal/packet/sign', headers: cookie,
    payload: { ...SIGN, documentSha256: presented.documentSha256 },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().accepted, ['C']);

  const sig = await app.db.query<{
    signed_name: string; intent_affirmed: boolean; esign_consent_ack: boolean;
    document_sha256: string; document_object_key: string; portal_user_id: string;
    ip: string | null; section_versions: Array<{ code: string | null; templateVersion: number }>;
  }>(`SELECT * FROM packet_signatures WHERE packet_id = $1`, [packetId]);
  const s = sig.rows[0]!;
  assert.equal(s.signed_name, 'Synthetic Signer');
  assert.equal(s.intent_affirmed, true);
  assert.equal(s.esign_consent_ack, true);
  assert.equal(s.document_sha256, presented.documentSha256);
  assert.match(s.document_object_key, /^packet-signatures\//, 'the exact bytes signed are retained');
  assert.ok(s.portal_user_id, 'attribution comes from the session');
  assert.ok(s.section_versions.length >= 2, 'which template versions were signed is recorded');

  // Downstream is unchanged: acceptance rows, letter status, late-fee stamp.
  const packet = await app.db.query<{ status: string; signature_method: string }>(
    `SELECT status, signature_method FROM engagement_packets WHERE id = $1`, [packetId]
  );
  assert.equal(packet.rows[0]!.status, 'signed');
  assert.equal(packet.rows[0]!.signature_method, 'portal_esign');
  const contact = await app.db.query<{ engagement_letter_status: string; late_fee_disclosure_signed_at: string | null }>(
    `SELECT engagement_letter_status, late_fee_disclosure_signed_at FROM contacts WHERE id = $1`, [contactId]
  );
  assert.equal(contact.rows[0]!.engagement_letter_status, 'signed');
  assert.ok(
    contact.rows[0]!.late_fee_disclosure_signed_at,
    'the Master carries the disclosure, so signing it stamps the late-fee gate'
  );
});

test('THE INTEGRITY CHECK: a document that changed since it was read cannot be signed', async () => {
  const { packetId, cookie } = await ready('ChangedDoc', ['bookkeeping']);
  const presented = (await app.inject({ method: 'GET', url: '/portal/packet', headers: cookie })).json() as
    { documentSha256: string };

  // The terms change while the client has the page open — an admin copy edit.
  await app.db.query(
    `UPDATE templates SET body_en = body_en || E'\\n\\nADDED AFTER THEY READ IT.', version = version + 1
     WHERE schedule_code = 'C'`
  );

  const res = await app.inject({
    method: 'POST', url: '/portal/packet/sign', headers: cookie,
    payload: { ...SIGN, documentSha256: presented.documentSha256 },
  });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error, 'document_changed');
  assert.match(res.json().message, /will not bind you to text you did not see/i);

  const none = await app.db.query(`SELECT 1 FROM packet_signatures WHERE packet_id = $1`, [packetId]);
  assert.equal(none.rows.length, 0, 'nothing was recorded');
  const packet = await app.db.query<{ status: string }>(
    `SELECT status FROM engagement_packets WHERE id = $1`, [packetId]
  );
  assert.notEqual(packet.rows[0]!.status, 'signed');

  // Re-reading gives a new hash, and that one signs.
  const again = (await app.inject({ method: 'GET', url: '/portal/packet', headers: cookie })).json() as
    { documentSha256: string };
  assert.notEqual(again.documentSha256, presented.documentSha256, 'the hash moved with the text');
  const ok = await app.inject({
    method: 'POST', url: '/portal/packet/sign', headers: cookie,
    payload: { ...SIGN, documentSha256: again.documentSha256 },
  });
  assert.equal(ok.statusCode, 200, ok.body);
});

test('intent and e-sign consent are each required, and each refusal says why', async () => {
  const { cookie } = await ready('NeedsAffirm', ['tax']);
  const presented = (await app.inject({ method: 'GET', url: '/portal/packet', headers: cookie })).json() as
    { documentSha256: string };

  for (const [payload, code] of [
    [{ ...SIGN, intentAffirmed: false }, 'intent_required'],
    [{ ...SIGN, esignConsentAck: false }, 'esign_consent_required'],
  ] as const) {
    const res = await app.inject({
      method: 'POST', url: '/portal/packet/sign', headers: cookie,
      payload: { ...payload, documentSha256: presented.documentSha256 },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error, code);
  }
});

test('a packet cannot be signed twice, and an unauthenticated caller cannot sign at all', async () => {
  const { cookie } = await ready('SignsOnce', ['entity']);
  const presented = (await app.inject({ method: 'GET', url: '/portal/packet', headers: cookie })).json() as
    { documentSha256: string };
  const first = await app.inject({
    method: 'POST', url: '/portal/packet/sign', headers: cookie,
    payload: { ...SIGN, documentSha256: presented.documentSha256 },
  });
  assert.equal(first.statusCode, 200, first.body);

  const second = await app.inject({
    method: 'POST', url: '/portal/packet/sign', headers: cookie,
    payload: { ...SIGN, documentSha256: presented.documentSha256 },
  });
  assert.equal(second.statusCode, 409, second.body);
  assert.equal(second.json().error, 'already_signed');
  assert.match(second.json().message, /accepted per-schedule, not by signing again/i);

  const anon = await app.inject({
    method: 'POST', url: '/portal/packet/sign',
    payload: { ...SIGN, documentSha256: presented.documentSha256 },
  });
  assert.equal(anon.statusCode, 401, 'no session, no signature');
});

test('the §7216 consents appear only AFTER this signature, never inside it', async () => {
  const { cookie } = await ready('ConsentAfter', ['tax']);

  // Before signing: nothing offered, because the Master is not signed yet.
  const before = (await app.inject({ method: 'GET', url: '/portal/consents', headers: cookie })).json() as
    { masterSigned: boolean; offers: Array<{ kind: string }> };
  assert.equal(before.masterSigned, false);
  assert.deepEqual(before.offers, []);

  const presented = (await app.inject({ method: 'GET', url: '/portal/packet', headers: cookie })).json() as
    { documentSha256: string; html: string };
  // And the consent text is not in the document they are signing.
  assert.doesNotMatch(presented.html, /CONSENT TO USE OF TAX RETURN INFORMATION/i);

  await app.inject({
    method: 'POST', url: '/portal/packet/sign', headers: cookie,
    payload: { ...SIGN, documentSha256: presented.documentSha256 },
  });

  const after = (await app.inject({ method: 'GET', url: '/portal/consents', headers: cookie })).json() as
    { masterSigned: boolean; offers: Array<{ kind: string }> };
  assert.equal(after.masterSigned, true);
  assert.deepEqual(after.offers.map((o) => o.kind), ['7216_use'], 'offered after, separately, optionally');
});
