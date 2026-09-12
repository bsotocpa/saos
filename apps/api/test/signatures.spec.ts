// M11 "Prove it": placeholder-block test (envelopes, not just email),
// The 8879 is a wet-signed UPLOAD (2026-09-12): no KBA, no remote envelope. Tests below:
// start → KBA pass → auto-send → webhook completion → signed PDF in MinIO →
// M7 gates satisfied. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { generateToken } from '../src/crypto.ts';
import { createTestConfig, makeStaff, auditRows, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let ana: TestStaff & { token: string };

const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  const res = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email, password: staff.password, totp: code },
  });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

async function makeClient(last: string, email: string): Promise<string> {
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, soto_status)
     VALUES ('Synthetic', $1, $2, 'active') RETURNING id`,
    [last, email]
  );
  return rows[0]!.id;
}

async function makeTaxEngagement(contactId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/tax-engagements', headers: auth(ana),
    payload: { contactId, taxYear: 2025, returnType: '1040' },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
}

async function docusealComplete(submissionId: string): Promise<void> {
  const res = await app.inject({
    method: 'POST', url: '/webhooks/docuseal',
    headers: { 'x-webhook-secret': config.WEBHOOK_SECRET },
    payload: { event_type: 'form.completed', data: { submission_id: submissionId } },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().matched, true);
}

before(async () => {
  config = await createTestConfig('sig');
  app = buildServer(config);
  await app.ready();
  ana = await staffWithToken('ana-sig@example.test', 'tax_preparer');
});

after(async () => {
  await app.close();
});

test('PLACEHOLDER BLOCK: envelope with a flagged template is unsendable; finalized copy sends', async () => {
  const contact = await makeClient('Sigletter', 'sig-letter@example.test');
  const te = await makeTaxEngagement(contact);

  // v3 loaded final text, so the Master is not flagged in a fresh database. Flag
  // it deliberately — the gate must hold for ANY flagged template, whatever the
  // current launch state happens to be.
  await app.db.query(`UPDATE templates SET is_placeholder = true WHERE key = 'engagement_master'`);

  const envelope = await app.inject({
    method: 'POST', url: '/signature-envelopes', headers: auth(ana),
    payload: { contactId: contact, type: 'engagement_letter', taxEngagementId: te, serviceLine: 'tax' },
  });
  assert.equal(envelope.statusCode, 201, envelope.body);
  const envId = envelope.json().id as string;

  // Drafting/queueing is allowed — SENDING is the gated act.
  const blocked = await app.inject({
    method: 'POST', url: `/signature-envelopes/${envId}/send`, headers: auth(ana),
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().error, 'template_placeholder_blocked');

  // Brian finalizes the legal text in admin (simulated) → the gate opens.
  await app.db.query(`UPDATE templates SET is_placeholder = false WHERE key = 'engagement_master'`);
  const sent = await app.inject({
    method: 'POST', url: `/signature-envelopes/${envId}/send`, headers: auth(ana),
  });
  assert.equal(sent.statusCode, 200, sent.body);
  const submissionId = sent.json().submissionId as string;
  assert.ok(submissionId);

  // Completion webhook: signed PDF stored, gate fields set, M7 unblocked.
  await docusealComplete(submissionId);
  const env = await app.db.query(
    `SELECT status, signed_document_id FROM signature_envelopes WHERE id = $1`,
    [envId]
  );
  assert.equal(env.rows[0].status, 'completed');
  assert.ok(env.rows[0].signed_document_id, 'signed PDF filed');
  const doc = await app.db.query(`SELECT category, minio_bucket FROM documents WHERE id = $1`, [
    env.rows[0].signed_document_id,
  ]);
  assert.equal(doc.rows[0].category, 'signed_authorizations');
  assert.equal(doc.rows[0].minio_bucket, 'saos-signed-docs');

  const teRow = await app.db.query(`SELECT engagement_letter_signed_at FROM tax_engagements WHERE id = $1`, [te]);
  assert.ok(teRow.rows[0].engagement_letter_signed_at, 'M7 letter gate satisfied by webhook');

  // The pipeline actually unblocks: scheduled → documents_requested now works.
  await app.inject({ method: 'POST', url: `/tax-engagements/${te}/transition`, headers: auth(ana), payload: { toStage: 'scheduled' } });
  const advance = await app.inject({
    method: 'POST', url: `/tax-engagements/${te}/transition`, headers: auth(ana),
    payload: { toStage: 'documents_requested' },
  });
  assert.equal(advance.statusCode, 200, advance.body);
  assert.ok((await auditRows(app.db, 'signature.completed')) >= 1);

  // Webhook replays are idempotent.
  await docusealComplete(submissionId);
  const docs = await app.db.query(
    `SELECT count(*)::int AS n FROM documents WHERE contact_id = $1 AND category = 'signed_authorizations'`,
    [contact]
  );
  assert.equal(docs.rows[0].n, 1, 'replayed webhook stores nothing twice');
});

test('§7216 envelope completion records the consent and opens the gate', async () => {
  const contact = await makeClient('Sigconsent', 'sig-consent@example.test');
  await app.db.query(`UPDATE templates SET is_placeholder = false WHERE key = 'consent_7216_use'`);

  const envelope = await app.inject({
    method: 'POST', url: '/signature-envelopes', headers: auth(ana),
    payload: { contactId: contact, type: 'consent_7216' },
  });
  const envId = envelope.json().id as string;
  const sent = await app.inject({ method: 'POST', url: `/signature-envelopes/${envId}/send`, headers: auth(ana) });
  assert.equal(sent.statusCode, 200, sent.body);
  await docusealComplete(sent.json().submissionId);

  const contactRow = await app.db.query(`SELECT consent_7216_status FROM contacts WHERE id = $1`, [contact]);
  assert.equal(contactRow.rows[0].consent_7216_status, 'signed');
  const consent = await app.db.query(
    `SELECT method, envelope_id, document_id FROM consents WHERE contact_id = $1 AND type = '7216_use'`,
    [contact]
  );
  assert.equal(consent.rows[0].method, 'docuseal');
  assert.equal(consent.rows[0].envelope_id, envId);
  assert.ok(consent.rows[0].document_id);
});




test('portal Sign Documents list is scoped to the session contact', async () => {
  const mine = await makeClient('Sigmine', 'sig-mine@example.test');
  const theirs = await makeClient('Sigtheirs', 'sig-theirs@example.test');
  await app.inject({
    method: 'POST', url: '/signature-envelopes', headers: auth(ana),
    payload: { contactId: mine, type: 'engagement_letter', serviceLine: 'tax' },
  });
  await app.inject({
    method: 'POST', url: '/signature-envelopes', headers: auth(ana),
    payload: { contactId: theirs, type: 'engagement_letter', serviceLine: 'tax' },
  });

  const user = await app.db.query<{ id: string }>(
    `INSERT INTO portal_users (contact_id, email) VALUES ($1, 'sig-mine@example.test') RETURNING id`,
    [mine]
  );
  const { token, hash } = generateToken();
  await app.db.query(
    `INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
    [user.rows[0]!.id, hash]
  );

  const res = await app.inject({
    method: 'GET', url: '/portal/signature-envelopes',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().envelopes.length, 1, 'only own envelopes visible');
});

// ── M26 flow 2: entity-group workflow — ONE envelope/KBA, packet, billing ────


/*
 * THE 8879 IS A DOCUMENT (2026-09-12, Brian's rulings 2 and 3). The remote path is retired.
 * Uploading the wet-signed scan under Signed Authorizations with the signed date and the
 * preparer of record IS the authorization — and nothing in SAOS may claim a return is
 * authorized without that document.
 */
test('the wet-signed 8879 upload authorizes the return: date, preparer of record, envelope record, audit', async () => {
  const contact = await makeClient('Sigwet', 'sig-wet@example.test');
  const te = await makeTaxEngagement(contact);
  await app.db.query(`UPDATE tax_engagements SET engagement_letter_signed_at = now(), estimate_locked_at = now(), stage = 'ready_to_file' WHERE id = $1`, [te]);

  // Before: the return is not authorized and cannot file.
  const early = await app.inject({ method: 'POST', url: `/tax-engagements/${te}/transition`, headers: auth(ana), payload: { toStage: 'filed', preparerPtinHolderId: ana.id } });
  assert.equal(early.statusCode, 409);
  assert.equal(early.json().error, 'f8879_required');

  // The old wet route no longer stamps an 8879.
  const old = await app.inject({ method: 'POST', url: `/tax-engagements/${te}/signatures/wet`, headers: auth(ana), payload: { type: 'f8879' } });
  assert.equal(old.statusCode, 410, old.body);

  // The scan lands under Signed Authorizations and is recorded with its date and PTIN holder.
  const scan = await app.db.query<{ id: string }>(
    `INSERT INTO documents (contact_id, tax_engagement_id, category, filename, minio_bucket, minio_key, uploaded_by_type)
     VALUES ($1, $2, 'signed_authorizations', 'scanned-8879.pdf', 'saos-signed-docs', 'test/scanned-8879.pdf', 'staff') RETURNING id`,
    [contact, te]
  );
  const { recordSigned8879 } = await import('../src/modules/tax/signed-8879.ts');
  await recordSigned8879(app, { staffId: ana.id, label: ana.fullName }, { taxEngagementId: te, documentId: scan.rows[0]!.id, signedOn: '2026-09-10', preparerPtinHolderId: ana.id });

  const row = await app.db.query<{ f8879_signed_at: Date; f8879_signature_method: string; f8879_document_id: string; preparer_ptin_holder_id: string }>(
    `SELECT f8879_signed_at, f8879_signature_method, f8879_document_id, preparer_ptin_holder_id FROM tax_engagements WHERE id = $1`, [te]);
  assert.equal(row.rows[0]!.f8879_signature_method, 'in_person_wet');
  assert.equal(row.rows[0]!.f8879_document_id, scan.rows[0]!.id);
  assert.equal(row.rows[0]!.preparer_ptin_holder_id, ana.id, 'whose PTIN is on it, recorded at upload');
  assert.equal(row.rows[0]!.f8879_signed_at.toISOString().slice(0, 10), '2026-09-10');

  const env = await app.db.query(`SELECT status, signature_method, signed_document_id FROM signature_envelopes WHERE tax_engagement_id = $1 AND type = 'f8879'`, [te]);
  assert.equal(env.rows.length, 1);
  assert.equal(env.rows[0].status, 'completed');
  assert.equal(env.rows[0].signed_document_id, scan.rows[0]!.id);
  const audit = await app.db.query(`SELECT details FROM audit_log WHERE action = 'signature.recorded_wet' AND object_id = $1`, [te]);
  assert.equal(audit.rows.length, 1);

  // After: the return files.
  const filed = await app.inject({ method: 'POST', url: `/tax-engagements/${te}/transition`, headers: auth(ana), payload: { toStage: 'filed', preparerPtinHolderId: ana.id } });
  assert.equal(filed.statusCode, 200, filed.body);

  // Twice is refused: one 8879 per return.
  await assert.rejects(
    () => recordSigned8879(app, { staffId: ana.id, label: ana.fullName }, { taxEngagementId: te, documentId: scan.rows[0]!.id, signedOn: '2026-09-11', preparerPtinHolderId: ana.id }),
    /already on file/
  );
});

test('nothing may claim a return is authorized without the document: the database refuses a timestamp alone, and so does the gate', async () => {
  const contact = await makeClient('Sigbare', 'sig-bare@example.test');
  const te = await makeTaxEngagement(contact);
  await app.db.query(`UPDATE tax_engagements SET engagement_letter_signed_at = now(), estimate_locked_at = now(), stage = 'ready_to_file' WHERE id = $1`, [te]);

  await assert.rejects(
    () => app.db.query(`UPDATE tax_engagements SET f8879_signed_at = now() WHERE id = $1`, [te]),
    /f8879_document_required/,
    'a signed_at with no document is refused by the database itself'
  );
  const still = await app.inject({ method: 'POST', url: `/tax-engagements/${te}/transition`, headers: auth(ana), payload: { toStage: 'filed', preparerPtinHolderId: ana.id } });
  assert.equal(still.statusCode, 409);

  // A document of the wrong category is not an 8879.
  const wrong = await app.db.query<{ id: string }>(
    `INSERT INTO documents (contact_id, tax_engagement_id, category, filename, minio_bucket, minio_key, uploaded_by_type)
     VALUES ($1, $2, 'tax_documents', 'w2.pdf', 'saos-documents', 'test/w2.pdf', 'staff') RETURNING id`, [contact, te]);
  const { recordSigned8879 } = await import('../src/modules/tax/signed-8879.ts');
  await assert.rejects(
    () => recordSigned8879(app, { staffId: ana.id, label: ana.fullName }, { taxEngagementId: te, documentId: wrong.rows[0]!.id, signedOn: '2026-09-10', preparerPtinHolderId: ana.id }),
    /Signed Authorizations/
  );

  // The retired routes say so.
  const remote = await app.inject({ method: 'POST', url: `/tax-engagements/${te}/signatures/remote-8879`, headers: auth(ana), payload: {} });
  assert.equal(remote.statusCode, 410);
  assert.equal(remote.json().error, 'remote_8879_retired');
});
