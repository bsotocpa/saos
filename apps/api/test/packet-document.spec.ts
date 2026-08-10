// The SAOS-generated packet document.
//
// This replaces the static Docuseal template, which was one PDF of the entire legal
// package — Master + all five Schedules + BOTH §7216 consent forms — with a single
// signature. Three things must be true of what we generate instead, and each one is
// a way a client could be wronged:
//
//   1. ONLY the schedules this client's services require. Otherwise a tax-only
//      client physically accepts bookkeeping terms the database says they never did.
//   2. NO §7216 consent, ever. A consent inside the document a client must sign to
//      be served is conditioned on service, which invalidates it.
//   3. Nothing unfilled. No {{variable}}, no ____ blank on a document being signed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { createAttestAddendum } from '../src/modules/engagements/attest-addendum.ts';
import { createPacket } from '../src/modules/engagements/packet.ts';
import { buildPacketDocument } from '../src/modules/engagements/packet-document.ts';
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

async function clientWithLines(name: string, lines: string[]): Promise<string> {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: name, email: `${name.toLowerCase()}@example.test`,
  });
  for (const line of lines) {
    await createEngagement(app, ceo, { contactId: c.id, serviceLine: line as 'tax', status: 'active' }, {});
  }
  return c.id;
}

before(async () => {
  config = await createTestConfig('packetdoc');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  brian = await staffWithToken('brian-pd@example.test', 'ceo');
  ceo = { id: brian.id, email: brian.email, permissions: ['*'], roleKey: 'ceo' } as AuthedStaff;
});

after(async () => {
  await app.close();
});

test('ONLY the required schedules appear — a tax client never sees bookkeeping terms', async () => {
  const id = await clientWithLines('TaxOnlyDoc', ['tax']);
  const packet = await createPacket(app, id, ceo);
  assert.deepEqual(packet.scheduleCodes, ['A']);

  const doc = await buildPacketDocument(app, packet.packetId);
  assert.deepEqual(doc.sections.map((s) => s.kind), ['master', 'schedule']);
  assert.deepEqual(doc.sections.filter((s) => s.kind === 'schedule').map((s) => s.code), ['A']);

  // The clauses that identify the OTHER schedules must be absent.
  assert.match(doc.html, /INDIVIDUAL INCOME TAX PREPARATION/i);
  assert.doesNotMatch(doc.html, /SCHEDULE C — BOOKKEEPING/i, 'bookkeeping terms are not in a tax packet');
  assert.doesNotMatch(doc.html, /SCHEDULE E — ENTITY/i, 'entity terms are not in a tax packet');
  assert.doesNotMatch(doc.html, /SCHEDULE F — ATTEST/i, 'attest terms are not in a tax packet');
});

test('a multi-service packet carries exactly its own schedules, in order', async () => {
  const id = await clientWithLines('MultiDoc', ['bookkeeping', 'advisory', 'entity']);
  const packet = await createPacket(app, id, ceo);
  assert.deepEqual(packet.scheduleCodes, ['C', 'D', 'E']);

  const doc = await buildPacketDocument(app, packet.packetId);
  assert.deepEqual(doc.sections.filter((s) => s.kind === 'schedule').map((s) => s.code), ['C', 'D', 'E']);
  assert.doesNotMatch(doc.html, /SCHEDULE A —/i, 'no individual tax schedule for a client with no tax service');
  assert.doesNotMatch(doc.html, /SCHEDULE B —/i);
});

test('NO §7216 consent is ever in the signing document, and the omission is named', async () => {
  const id = await clientWithLines('ConsentFreeDoc', ['tax']);
  const packet = await createPacket(app, id, ceo);
  const doc = await buildPacketDocument(app, packet.packetId);

  // The consent forms' own distinguishing language must be absent.
  assert.doesNotMatch(doc.html, /CONSENT TO USE OF TAX RETURN INFORMATION/i);
  assert.doesNotMatch(doc.html, /CONSENT TO DISCLOSURE OF TAX RETURN INFORMATION/i);
  for (const key of ['consent_7216_use', 'consent_7216_disclose']) {
    assert.ok(
      !doc.sections.some((s) => s.templateKey === key),
      `${key} must not be a section of the signing document`
    );
    assert.ok(
      doc.deliberatelyExcluded.some((e) => e.templateKey === key),
      `${key} must be listed as deliberately excluded, so the omission reads as a decision`
    );
  }
  assert.match(doc.deliberatelyExcluded[0]!.reason, /condition service/i);

  // The Master's own §7216 section is a different thing and SHOULD be present —
  // it describes the restriction; it does not grant consent.
  assert.match(doc.html, /Confidentiality; §7216/i);
});

test('nothing unfilled reaches a signer, including the attest Addendum blanks', async () => {
  const id = await clientWithLines('AttestDoc', ['attest']);
  const eng = await app.db.query<{ id: string }>(
    `SELECT id FROM engagements WHERE contact_id = $1 AND service_line = 'attest'`, [id]
  );
  await createAttestAddendum(app, ceo, {
    engagementId: eng.rows[0]!.id,
    entityName: 'Synthetic Holdings LLC',
    engagementType: 'review',
    statementsAndPeriods: 'Balance sheet and income statement, year ended 2025-12-31',
    reportingFramework: 'US GAAP',
    feeBasis: 'hourly',
    estimatedHours: 25,
    depositItemCode: 'DEPOSIT_1040',
    expectedReportDate: '2026-05-15',
  });
  const packet = await createPacket(app, id, ceo);
  const doc = await buildPacketDocument(app, packet.packetId);

  assert.deepEqual(doc.sections.filter((s) => s.kind === 'schedule').map((s) => s.code), ['F']);
  assert.doesNotMatch(doc.html, /\{\{/, 'no unfilled template variable anywhere');

  // The ADDENDUM's blanks are the agreed terms, so they must be filled. Asserted on
  // the Schedule F section alone, because the Master's attorney-cleared text ends
  // with ruled wet-signature lines ("Client signature: ______") which are part of
  // the legal text and are not ours to strip.
  const scheduleF = doc.sections.find((s) => s.code === 'F')!;
  assert.doesNotMatch(scheduleF.body, /_{4,}/, 'no blank left in the per-engagement Addendum');
  assert.match(scheduleF.body, /Synthetic Holdings LLC/);
  assert.match(scheduleF.body, /per hour, estimated 25\.00 hours/);
  assert.match(scheduleF.body, /US GAAP/);
  assert.match(scheduleF.body, /2026-05-15/);
  // And the Master's attached-schedule sentence names F rather than being blank.
  assert.match(doc.html, /Service Schedules attached at signing: F — /);
});

test('the document records which template VERSION each section came from', async () => {
  const id = await clientWithLines('VersionedDoc', ['bookkeeping']);
  const packet = await createPacket(app, id, ceo);
  const doc = await buildPacketDocument(app, packet.packetId);
  for (const s of doc.sections) {
    assert.ok(s.templateVersion >= 1, `${s.templateKey} carries a version`);
    assert.match(doc.html, new RegExp(`data-version="${s.templateVersion}"`));
  }
});

test('a packet whose schedule went back under review cannot be rendered', async () => {
  const id = await clientWithLines('DraftedDoc', ['bookkeeping']);
  const packet = await createPacket(app, id, ceo);
  await app.db.query(`UPDATE templates SET is_placeholder = true WHERE schedule_code = 'C'`);
  await assert.rejects(
    buildPacketDocument(app, packet.packetId),
    (err: { code?: string }) => err.code === 'schedule_not_final',
    'the placeholder gate reaches the document generator too'
  );
  await app.db.query(`UPDATE templates SET is_placeholder = false WHERE schedule_code = 'C'`);
});

test('the document is reviewable over HTTP before anything is sent', async () => {
  const id = await clientWithLines('HttpDoc', ['tax']);
  const packet = await createPacket(app, id, ceo);
  const res = await app.inject({
    method: 'GET', url: `/packets/${packet.packetId}/document`, headers: auth(brian),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as {
    sections: Array<{ kind: string; code: string | null; characters: number }>;
    deliberatelyExcluded: Array<{ templateKey: string }>;
    html: string;
  };
  assert.equal(body.sections.length, 2);
  assert.ok(body.sections.every((s) => s.characters > 100), 'every section has real text in it');
  assert.equal(body.deliberatelyExcluded.length, 2, 'both consents listed as excluded');
  assert.match(body.html, /data-signature-block="client"/);
});
