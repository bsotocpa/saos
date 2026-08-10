// Sending a packet: SAOS generates the document, Docuseal signs THAT.
//
// The shape being prevented, permanently: one pre-built Docuseal template holding
// the Master + all five Schedules + BOTH §7216 consent forms, signed once. That
// would have a tax-only client accept bookkeeping terms the database says they
// never accepted, and capture §7216 consent with the signature that engages the
// service — the conditioning §7216 forbids.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, auditRows, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { createPacket } from '../src/modules/engagements/packet.ts';
import type { AuthedStaff } from '../src/types.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let ceo: AuthedStaff;

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
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

async function packetFor(name: string, lines: string[]): Promise<{ contactId: string; packetId: string }> {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: name, email: `${name.toLowerCase()}@example.test`,
  });
  for (const line of lines) {
    await createEngagement(app, ceo, { contactId: c.id, serviceLine: line as 'tax', status: 'active' }, {});
  }
  const packet = await createPacket(app, c.id, ceo);
  return { contactId: c.id, packetId: packet.packetId };
}

before(async () => {
  config = await createTestConfig('packetsend');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  brian = await staffWithToken('brian-ps@example.test', 'ceo');
  ceo = { id: brian.id, email: brian.email, permissions: ['*'], roleKey: 'ceo' } as AuthedStaff;
});

after(async () => {
  await app.close();
});

test('the send path uses the GENERATED document, not a Docuseal template', async () => {
  const { packetId } = await packetFor('SendsGenerated', ['tax']);
  const res = await app.inject({
    method: 'POST', url: `/packets/${packetId}/send`, headers: auth(brian), payload: {},
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as {
    submissionId: string;
    sections: Array<{ kind: string; code: string | null }>;
    excludedConsents: string[];
  };

  // The stub distinguishes the two paths by submission id prefix, so this asserts
  // WHICH path ran rather than merely that something was sent.
  assert.match(body.submissionId, /^stub-doc-/, 'the generated-document path ran');
  assert.deepEqual(body.sections.map((s) => s.code), [null, 'A'], 'Master + Schedule A only');
  assert.deepEqual(
    body.excludedConsents.sort(), ['consent_7216_disclose', 'consent_7216_use'],
    'both consents reported as excluded from the signing document'
  );
});

test('the envelope is marked a packet envelope, and the DB refuses to template it', async () => {
  const { packetId } = await packetFor('GuardedEnvelope', ['bookkeeping']);
  await app.inject({ method: 'POST', url: `/packets/${packetId}/send`, headers: auth(brian), payload: {} });

  const env = await app.db.query<{ id: string; is_packet_envelope: boolean; docuseal_template_id: string | null }>(
    `SELECT se.id, se.is_packet_envelope, se.docuseal_template_id
     FROM signature_envelopes se JOIN engagement_packets p ON p.envelope_id = se.id
     WHERE p.id = $1`,
    [packetId]
  );
  assert.equal(env.rows[0]!.is_packet_envelope, true);
  assert.equal(env.rows[0]!.docuseal_template_id, null, 'no template id, ever');

  // THE GUARD: pointing this envelope at a Docuseal template is unrepresentable.
  await assert.rejects(
    app.db.query(
      `UPDATE signature_envelopes SET docuseal_template_id = '1' WHERE id = $1`,
      [env.rows[0]!.id]
    ),
    /signature_envelopes_packet_never_templated/,
    'the old all-in-one-template shape cannot come back'
  );
});

test('the audit row records exactly what the client was asked to sign', async () => {
  const { packetId } = await packetFor('AuditedSend', ['bookkeeping', 'entity']);
  await app.inject({ method: 'POST', url: `/packets/${packetId}/send`, headers: auth(brian), payload: {} });

  const audit = await app.db.query<{ details: Record<string, unknown> }>(
    `SELECT details FROM audit_log WHERE action = 'packet.sent' AND details->>'packet_id' = $1`,
    [packetId]
  );
  assert.equal(audit.rows.length, 1);
  const d = audit.rows[0]!.details as {
    sections: Array<{ kind: string; code: string | null; key: string; version: number }>;
    excluded_consents: string[];
  };
  assert.deepEqual(d.sections.map((s) => s.code), [null, 'C', 'E']);
  for (const s of d.sections) assert.ok(s.version >= 1, `${s.key} version recorded`);
  assert.equal(d.excluded_consents.length, 2, 'the omission is on the record too');
  assert.ok((await auditRows(app.db, 'packet.sent')) >= 1);
});

test('a failed send does not strand a second envelope, and does not mark the packet sent', async () => {
  const { packetId } = await packetFor('RetrySend', ['bookkeeping']);
  // Break the document: put its schedule back under review.
  await app.db.query(`UPDATE templates SET is_placeholder = true WHERE schedule_code = 'C'`);
  const failed = await app.inject({
    method: 'POST', url: `/packets/${packetId}/send`, headers: auth(brian), payload: {},
  });
  assert.equal(failed.statusCode, 409, failed.body);
  assert.equal(failed.json().error, 'schedule_not_final');

  const after = await app.db.query<{ status: string; envelope_id: string | null }>(
    `SELECT status, envelope_id FROM engagement_packets WHERE id = $1`, [packetId]
  );
  assert.equal(after.rows[0]!.status, 'draft', 'not marked sent on a failed send');
  const envelopeId = after.rows[0]!.envelope_id;
  assert.ok(envelopeId, 'the envelope was created and kept for reuse');

  // Fix it and retry: the SAME envelope is reused rather than a second created.
  await app.db.query(`UPDATE templates SET is_placeholder = false WHERE schedule_code = 'C'`);
  const ok = await app.inject({
    method: 'POST', url: `/packets/${packetId}/send`, headers: auth(brian), payload: {},
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().envelopeReused, true);
  assert.equal(ok.json().envelopeId, envelopeId);

  const count = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM signature_envelopes se
     JOIN contacts c ON c.id = se.contact_id
     WHERE c.last_name = 'RetrySend'`
  );
  assert.equal(count.rows[0]!.n, 1, 'exactly one envelope for the whole story');
});

test('signing the generated packet records acceptance of exactly its schedules', async () => {
  const { contactId, packetId } = await packetFor('SignsGenerated', ['advisory']);
  const sent = await app.inject({
    method: 'POST', url: `/packets/${packetId}/send`, headers: auth(brian), payload: {},
  });
  assert.equal(sent.statusCode, 200, sent.body);

  const { recordMasterSignature } = await import('../src/modules/engagements/packet.ts');
  await recordMasterSignature(app, packetId);

  const acceptances = await app.db.query<{ schedule_code: string; via: string }>(
    `SELECT schedule_code, via::text AS via FROM schedule_acceptances WHERE contact_id = $1`,
    [contactId]
  );
  assert.deepEqual(acceptances.rows.map((r) => r.schedule_code), ['D']);
  assert.equal(acceptances.rows[0]!.via, 'master_signature');

  // And nothing was recorded for a schedule that was never in the document.
  for (const code of ['A', 'B', 'C', 'E', 'F']) {
    assert.ok(
      !acceptances.rows.some((r) => r.schedule_code === code),
      `Schedule ${code} was not in the document, so it must not be accepted`
    );
  }
});
