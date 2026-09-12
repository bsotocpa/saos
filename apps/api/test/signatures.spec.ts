// M11 "Prove it": placeholder-block test (envelopes, not just email),
// KBA-required test, wet-path test, and the full remote-8879 journey:
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

test('KBA REQUIRED: remote 8879 cannot reach Docuseal without a passed KBA; pass auto-sends', async () => {
  const contact = await makeClient('Sigremote', 'sig-remote@example.test');
  const te = await makeTaxEngagement(contact);

  const started = await app.inject({
    method: 'POST', url: `/tax-engagements/${te}/signatures/remote-8879`, headers: auth(ana),
  });
  assert.equal(started.statusCode, 201, started.body);
  const { envelopeId, kbaId, vendor } = started.json();
  assert.equal(vendor, 'sandbox');

  // The KBA-required test: direct send attempts are refused while pending.
  const premature = await app.inject({
    method: 'POST', url: `/signature-envelopes/${envelopeId}/send`, headers: auth(ana),
  });
  assert.equal(premature.statusCode, 409, premature.body);
  assert.equal(premature.json().error, 'kba_required');

  // KBA passes → envelope auto-sends to Docuseal.
  const passed = await app.inject({
    method: 'POST', url: `/kba/${kbaId}/simulate`, headers: auth(ana),
    payload: { outcome: 'passed' },
  });
  assert.equal(passed.statusCode, 200, passed.body);
  assert.equal(passed.json().sent, true);
  const env = await app.db.query(
    `SELECT status, docuseal_submission_id, signature_method FROM signature_envelopes WHERE id = $1`,
    [envelopeId]
  );
  assert.equal(env.rows[0].status, 'sent');
  assert.equal(env.rows[0].signature_method, 'remote_kba');

  // Double-resolution is refused.
  const again = await app.inject({
    method: 'POST', url: `/kba/${kbaId}/simulate`, headers: auth(ana),
    payload: { outcome: 'passed' },
  });
  assert.equal(again.statusCode, 409);

  // Completion → f8879 gate fields; the M7 filing gate opens.
  await docusealComplete(env.rows[0].docuseal_submission_id);
  const teRow = await app.db.query(
    `SELECT f8879_signed_at, f8879_signature_method FROM tax_engagements WHERE id = $1`,
    [te]
  );
  assert.ok(teRow.rows[0].f8879_signed_at);
  assert.equal(teRow.rows[0].f8879_signature_method, 'remote_kba', 'signature method recorded per 8879');

  // Filing is now allowed (fabricate the rest of the pipeline prerequisites).
  await app.db.query(
    `UPDATE tax_engagements SET stage = 'ready_to_file', engagement_letter_signed_at = now(), estimate_locked_at = now() WHERE id = $1`,
    [te]
  );
  const filed = await app.inject({
    method: 'POST', url: `/tax-engagements/${te}/transition`, headers: auth(ana),
    payload: { toStage: 'filed', preparerPtinHolderId: ana.id },
  });
  assert.equal(filed.statusCode, 200, filed.body);
});

test('KBA failure keeps the envelope unsendable', async () => {
  const contact = await makeClient('Sigfail', 'sig-fail@example.test');
  const te = await makeTaxEngagement(contact);
  const started = await app.inject({
    method: 'POST', url: `/tax-engagements/${te}/signatures/remote-8879`, headers: auth(ana),
  });
  const { envelopeId, kbaId } = started.json();

  const failed = await app.inject({
    method: 'POST', url: `/kba/${kbaId}/simulate`, headers: auth(ana),
    payload: { outcome: 'failed', failureReason: 'identity questions not answered' },
  });
  assert.equal(failed.statusCode, 200, failed.body);
  assert.equal(failed.json().sent, false);

  const env = await app.db.query(`SELECT status FROM signature_envelopes WHERE id = $1`, [envelopeId]);
  assert.equal(env.rows[0].status, 'kba_required');
  const send = await app.inject({ method: 'POST', url: `/signature-envelopes/${envelopeId}/send`, headers: auth(ana) });
  assert.equal(send.statusCode, 409);
  assert.equal(send.json().error, 'kba_required');
});

test('WET PATH: in-office signature records method + completed envelope with the scanned document', async () => {
  const contact = await makeClient('Sigwet', 'sig-wet@example.test');
  const te = await makeTaxEngagement(contact);

  // The scanned signed 8879 lands in Signed Authorizations first (M10 path).
  const scan = await app.db.query<{ id: string }>(
    `INSERT INTO documents (contact_id, tax_engagement_id, category, filename, minio_bucket, minio_key, uploaded_by_type)
     VALUES ($1, $2, 'signed_authorizations', 'scanned-8879.pdf', 'saos-signed-docs', 'test/scanned-8879.pdf', 'staff')
     RETURNING id`,
    [contact, te]
  );

  const wet = await app.inject({
    method: 'POST', url: `/tax-engagements/${te}/signatures/wet`, headers: auth(ana),
    payload: { type: 'f8879', documentId: scan.rows[0]!.id, note: 'signed in office' },
  });
  assert.equal(wet.statusCode, 200, wet.body);

  const env = await app.db.query(
    `SELECT type, status, signature_method, signed_document_id FROM signature_envelopes
     WHERE tax_engagement_id = $1 AND type = 'f8879'`,
    [te]
  );
  assert.equal(env.rows.length, 1, 'wet signature leaves an envelope record');
  assert.equal(env.rows[0].status, 'completed');
  assert.equal(env.rows[0].signature_method, 'in_person_wet');
  assert.equal(env.rows[0].signed_document_id, scan.rows[0]!.id);
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

test('entity group: one bundled envelope + one KBA signs EVERY group 8879; packet rolls up; consolidated invoice', async () => {
  const brian = await staffWithToken('brian-group@example.test', 'ceo');
  const owner = await makeClient('Groupowner', 'group-owner@example.test');

  // Two entities in the group, each with a 2025 return.
  const bizIds: string[] = [];
  const teIds: string[] = [];
  for (const name of ['Synthetic Alpha LLC', 'Synthetic Beta Inc']) {
    const biz = await app.db.query<{ id: string }>(
      `INSERT INTO businesses (name) VALUES ($1) RETURNING id`, [name]
    );
    bizIds.push(biz.rows[0]!.id);
    const te = await app.inject({
      method: 'POST', url: '/tax-engagements', headers: auth(ana),
      payload: { contactId: owner, businessId: biz.rows[0]!.id, taxYear: 2025, returnType: '1120s' },
    });
    assert.equal(te.statusCode, 201, te.body);
    teIds.push(te.json().id as string);
    await app.db.query(
      `UPDATE tax_engagements SET estimated_fee_min_cents = 70000, estimated_fee_max_cents = 90000 WHERE id = $1`,
      [te.json().id]
    );
  }
  const group = await app.db.query<{ id: string }>(
    `INSERT INTO entity_groups (name) VALUES ('Synthetic Family Group') RETURNING id`
  );
  const groupId = group.rows[0]!.id;
  for (const bizId of bizIds) {
    await app.db.query(`INSERT INTO entity_group_members (group_id, business_id) VALUES ($1, $2)`, [groupId, bizId]);
  }
  await app.db.query(
    `INSERT INTO entity_group_members (group_id, contact_id, member_role) VALUES ($1, $2, 'owner')`,
    [groupId, owner]
  );

  // Packet BEFORE signatures: 2 entities, 2 awaiting 8879, estimates rolled up.
  const before8879 = await app.inject({
    method: 'GET', url: `/entity-groups/${groupId}/packet?taxYear=2025`, headers: auth(ana),
  });
  assert.equal(before8879.statusCode, 200, before8879.body);
  assert.equal(before8879.json().rollup.entities, 2);
  assert.equal(before8879.json().rollup.awaiting8879, 2);
  assert.equal(before8879.json().rollup.estimatedMinCents, 140000);
  assert.equal(before8879.json().rollup.estimatedMaxCents, 180000);

  // ONE bundled envelope + ONE KBA for both 8879s.
  const started = await app.inject({
    method: 'POST', url: `/entity-groups/${groupId}/f8879-envelope`, headers: auth(ana),
    payload: { taxYear: 2025 },
  });
  assert.equal(started.statusCode, 201, started.body);
  assert.equal(started.json().covered, 2, 'one envelope covers both entities');
  const { envelopeId, kbaId } = started.json();

  const passed = await app.inject({
    method: 'POST', url: `/kba/${kbaId}/simulate`, headers: auth(ana), payload: { outcome: 'passed' },
  });
  assert.equal(passed.statusCode, 200, passed.body);
  const env = await app.db.query<{ docuseal_submission_id: string }>(
    `SELECT docuseal_submission_id FROM signature_envelopes WHERE id = $1`, [envelopeId]
  );
  await docusealComplete(env.rows[0]!.docuseal_submission_id);

  // BOTH engagements stamped by the single completion.
  for (const teId of teIds) {
    const row = await app.db.query(
      `SELECT f8879_signed_at, f8879_signature_method FROM tax_engagements WHERE id = $1`, [teId]
    );
    assert.ok(row.rows[0].f8879_signed_at, 'bundled envelope stamps every covered 8879');
    assert.equal(row.rows[0].f8879_signature_method, 'remote_kba');
  }
  const afterPacket = await app.inject({
    method: 'GET', url: `/entity-groups/${groupId}/packet?taxYear=2025`, headers: auth(ana),
  });
  assert.equal(afterPacket.json().rollup.awaiting8879, 0);

  // Nothing left to sign → a second bundle refuses.
  const again = await app.inject({
    method: 'POST', url: `/entity-groups/${groupId}/f8879-envelope`, headers: auth(ana),
    payload: { taxYear: 2025 },
  });
  assert.equal(again.statusCode, 400);

  // Billing: per_entity mode refuses the consolidated invoice…
  const modeSet = await app.inject({
    method: 'PATCH', url: `/entity-groups/${groupId}`, headers: auth(brian),
    payload: { billingMode: 'per_entity' },
  });
  assert.equal(modeSet.statusCode, 200, modeSet.body);
  for (const teId of teIds) {
    await app.db.query(
      `UPDATE tax_engagements SET stage = 'filed', filed_date = CURRENT_DATE, final_fee_cents = 80000 WHERE id = $1`,
      [teId]
    );
  }
  const refused = await app.inject({
    method: 'POST', url: `/entity-groups/${groupId}/invoice`, headers: auth(ana), payload: { taxYear: 2025 },
  });
  assert.equal(refused.statusCode, 409);

  // …consolidated mode produces ONE invoice, line-itemed per entity.
  await app.inject({
    method: 'PATCH', url: `/entity-groups/${groupId}`, headers: auth(brian),
    payload: { billingMode: 'consolidated' },
  });
  const invoiced = await app.inject({
    method: 'POST', url: `/entity-groups/${groupId}/invoice`, headers: auth(ana), payload: { taxYear: 2025 },
  });
  assert.equal(invoiced.statusCode, 201, invoiced.body);
  assert.equal(invoiced.json().engagements, 2);
  assert.equal(invoiced.json().totalCents, 160000, 'sum of both entity final fees');
  const stamped = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tax_engagements WHERE id = ANY($1::uuid[]) AND invoice_number = $2`,
    [teIds, invoiced.json().invoiceNumber]
  );
  assert.equal(stamped.rows[0]!.n, 2, 'both engagements share the consolidated invoice number');

  // Idempotence: nothing left to bill.
  const rebill = await app.inject({
    method: 'POST', url: `/entity-groups/${groupId}/invoice`, headers: auth(ana), payload: { taxYear: 2025 },
  });
  assert.equal(rebill.statusCode, 400);
});
