// Sending an engagement packet — PORTAL-NATIVE, permanently (Brian's Option 2
// decision, 2026-08-11). Docuseal self-hosted is reserved for Form 8879, where IRS
// Pub 1345 requires KBA and the vendor's identity trail is the point.
//
// What these tests pin down:
//   · sending creates NO signature envelope, and never touches Docuseal
//   · the document is BUILT before anything is sent, so every gate fires first
//   · a failed build sends nothing and marks nothing
//   · the client is emailed a PORTAL LINK, never an attachment
//   · signing in the portal accepts exactly the schedules in the document

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, auditRows, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { createPacket } from '../src/modules/engagements/packet.ts';
import type { AuthedStaff } from '../src/types.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let ceo: AuthedStaff;

const sentMail: MailMessage[] = [];
const capturingMailer: Mailer = {
  transport: 'console',
  async send(msg) {
    sentMail.push(msg);
    return { id: `captured-${sentMail.length}` };
  },
};
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

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

/** A client with portal access, an engagement, and a packet ready to send. */
async function readyToSend(name: string, lines: string[]) {
  const email = `${name.toLowerCase()}@example.test`;
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: name, email });
  for (const line of lines) {
    await createEngagement(app, ceo, { contactId: c.id, serviceLine: line as 'tax', status: 'active' }, {});
  }
  const pu = await app.db.query<{ id: string }>(
    `INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`,
    [c.id, email]
  );
  const token = randomBytes(32).toString('base64url');
  await app.db.query(
    `INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '1 hour')`,
    [pu.rows[0]!.id, createHash('sha256').update(token).digest('hex')]
  );
  const packet = await createPacket(app, c.id, ceo);
  return { contactId: c.id, packetId: packet.packetId, email, cookie: { cookie: `saos_portal_session=${token}` } };
}

before(async () => {
  config = await createTestConfig('packetsend');
  app = buildServer(config, { mailer: capturingMailer });
  await app.ready();
  brian = await staffWithToken('brian-ps@example.test', 'ceo');
  ceo = { id: brian.id, email: brian.email, permissions: ['*'], roleKey: 'ceo' } as AuthedStaff;
});

after(async () => {
  await app.close();
});

test('sending emails a PORTAL LINK and creates no signature envelope at all', async () => {
  const { packetId, email } = await readyToSend('PortalSend', ['tax']);
  sentMail.length = 0;

  const res = await app.inject({
    method: 'POST', url: `/packets/${packetId}/send`, headers: auth(brian), payload: {},
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as {
    emailedTo: string; scheduleCodes: string[];
    sections: Array<{ code: string | null }>; excludedConsents: string[];
  };
  assert.equal(body.emailedTo, email);
  assert.deepEqual(body.scheduleCodes, ['A']);
  assert.deepEqual(body.sections.map((s) => s.code), [null, 'A'], 'Master + Schedule A');
  assert.deepEqual(body.excludedConsents.sort(), ['consent_7216_disclose', 'consent_7216_use']);

  // NO envelope, and nothing on the packet pointing at a vendor.
  const envelopes = await app.db.query(
    `SELECT 1 FROM signature_envelopes WHERE contact_id = (SELECT contact_id FROM engagement_packets WHERE id = $1)`,
    [packetId]
  );
  assert.equal(envelopes.rows.length, 0, 'portal-native signing creates no envelope');
  const packet = await app.db.query<{ status: string; envelope_id: string | null }>(
    `SELECT status, envelope_id FROM engagement_packets WHERE id = $1`, [packetId]
  );
  assert.equal(packet.rows[0]!.status, 'sent');
  assert.equal(packet.rows[0]!.envelope_id, null);

  // The email carries a link, never the document itself.
  const mail = sentMail.find((m) => m.to === email);
  assert.ok(mail, 'the client was emailed');
  assert.match(mail.text, /\/sign/, 'points at the portal');
  assert.doesNotMatch(mail.text, /MASTER ENGAGEMENT AGREEMENT/, 'documents never travel by email');

  const audit = await app.db.query<{ details: { method: string } }>(
    `SELECT details FROM audit_log WHERE action = 'packet.sent' AND object_id = $1`, [packetId]
  );
  assert.equal(audit.rows[0]!.details.method, 'portal_esign');
  assert.ok((await auditRows(app.db, 'packet.sent')) >= 1);
});

test('a failed build sends nothing and marks nothing', async () => {
  const { packetId, email } = await readyToSend('BuildFails', ['bookkeeping']);
  sentMail.length = 0;
  await app.db.query(`UPDATE templates SET is_placeholder = true WHERE schedule_code = 'C'`);
  try {
    const res = await app.inject({
      method: 'POST', url: `/packets/${packetId}/send`, headers: auth(brian), payload: {},
    });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error, 'schedule_not_final');
    assert.equal(sentMail.filter((m) => m.to === email).length, 0, 'no email escaped');
    const packet = await app.db.query<{ status: string }>(
      `SELECT status FROM engagement_packets WHERE id = $1`, [packetId]
    );
    assert.equal(packet.rows[0]!.status, 'draft', 'not marked sent');
  } finally {
    await app.db.query(`UPDATE templates SET is_placeholder = false WHERE schedule_code = 'C'`);
  }
});

test('a client with no portal access cannot be sent a packet they could not sign', async () => {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'NoPortal', email: 'noportal@example.test',
  });
  await createEngagement(app, ceo, { contactId: c.id, serviceLine: 'entity', status: 'active' }, {});
  const packet = await createPacket(app, c.id, ceo);
  sentMail.length = 0;

  const res = await app.inject({
    method: 'POST', url: `/packets/${packet.packetId}/send`, headers: auth(brian), payload: {},
  });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error, 'no_portal_access');
  assert.match(res.json().message, /Grant access first/i, 'it says what to do');
  assert.equal(sentMail.length, 0, 'no dead-end email');
});

test('an already-signed packet cannot be sent again', async () => {
  const { packetId, cookie } = await readyToSend('SendOnce', ['advisory']);
  await app.inject({ method: 'POST', url: `/packets/${packetId}/send`, headers: auth(brian), payload: {} });

  const presented = (await app.inject({ method: 'GET', url: '/portal/packet', headers: cookie })).json() as
    { documentSha256: string };
  const signed = await app.inject({
    method: 'POST', url: '/portal/packet/sign', headers: cookie,
    payload: {
      signedName: 'Synthetic Signer', intentAffirmed: true, esignConsentAck: true,
      documentSha256: presented.documentSha256,
    },
  });
  assert.equal(signed.statusCode, 200, signed.body);

  const again = await app.inject({
    method: 'POST', url: `/packets/${packetId}/send`, headers: auth(brian), payload: {},
  });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, 'already_signed');
});

test('the whole path end to end: send, read, sign, and exactly those schedules accepted', async () => {
  const { contactId, packetId, cookie } = await readyToSend('EndToEnd', ['bookkeeping', 'entity']);
  const sent = await app.inject({
    method: 'POST', url: `/packets/${packetId}/send`, headers: auth(brian), payload: {},
  });
  assert.equal(sent.statusCode, 200, sent.body);
  assert.deepEqual(sent.json().scheduleCodes, ['C', 'E']);

  const presented = (await app.inject({ method: 'GET', url: '/portal/packet', headers: cookie })).json() as
    { documentSha256: string; scheduleCodes: string[]; html: string };
  assert.deepEqual(presented.scheduleCodes, ['C', 'E']);
  assert.doesNotMatch(presented.html, /SCHEDULE A —/i, 'no schedule the client did not engage');

  const signed = await app.inject({
    method: 'POST', url: '/portal/packet/sign', headers: cookie,
    payload: {
      signedName: 'Synthetic Signer', intentAffirmed: true, esignConsentAck: true,
      documentSha256: presented.documentSha256,
    },
  });
  assert.equal(signed.statusCode, 200, signed.body);
  assert.deepEqual((signed.json().accepted as string[]).sort(), ['C', 'E']);

  const acceptances = await app.db.query<{ schedule_code: string; via: string }>(
    `SELECT schedule_code, via::text AS via FROM schedule_acceptances WHERE contact_id = $1 ORDER BY schedule_code`,
    [contactId]
  );
  assert.deepEqual(acceptances.rows.map((r) => r.schedule_code), ['C', 'E']);
  for (const r of acceptances.rows) assert.equal(r.via, 'master_signature');

  const packet = await app.db.query<{ status: string; signature_method: string }>(
    `SELECT status, signature_method FROM engagement_packets WHERE id = $1`, [packetId]
  );
  assert.equal(packet.rows[0]!.status, 'signed');
  assert.equal(packet.rows[0]!.signature_method, 'portal_esign');

  // And the §7216 USE consent becomes available only now.
  const consents = (await app.inject({ method: 'GET', url: '/portal/consents', headers: cookie })).json() as
    { masterSigned: boolean; offers: Array<{ kind: string }> };
  assert.equal(consents.masterSigned, true);
  assert.deepEqual(consents.offers.map((o) => o.kind), ['7216_use']);
});
