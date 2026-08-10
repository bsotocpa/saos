// M10 "Prove it": audit-log assertions on EVERY document path (upload,
// download, status change), row-level isolation on downloads, IRS-notice
// upload hook, itemized request fulfillment, chase-job reminders + 7-day
// non-response alert, return delivery. Runs against the real MinIO from
// docker compose. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { generateToken } from '../src/crypto.ts';
import { createTestConfig, makeStaff, multipartBody, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { addDays, todayChicago } from '../src/modules/tax/deadlines.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let jackson: TestStaff & { token: string };
let ana: TestStaff & { token: string };

const sentMail: MailMessage[] = [];
const capturingMailer: Mailer = {
  transport: 'console',
  async send(msg) {
    sentMail.push(msg);
    return { id: `captured-${sentMail.length}` };
  },
};

const PDF = Buffer.from('%PDF-1.4 synthetic test document — no real client data\n%%EOF');
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

async function makeClient(last: string, email: string, language: 'en' | 'es' = 'en'): Promise<{ contactId: string; token: string }> {
  const contact = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, language, soto_status)
     VALUES ('Synthetic', $1, $2, $3, 'active') RETURNING id`,
    [last, email, language]
  );
  const contactId = contact.rows[0]!.id;
  const user = await app.db.query<{ id: string }>(
    `INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`,
    [contactId, email]
  );
  const { token, hash } = generateToken();
  await app.db.query(
    `INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
    [user.rows[0]!.id, hash]
  );
  return { contactId, token };
}

async function docAudits(action: string, documentId: string): Promise<number> {
  const { rows } = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = $1 AND object_type = 'document' AND object_id = $2`,
    [action, documentId]
  );
  return rows[0]!.n;
}

before(async () => {
  config = await createTestConfig('doc');
  app = buildServer(config, { mailer: capturingMailer });
  await app.ready();
  brian = await staffWithToken('brian-doc@example.test', 'ceo');
  jackson = await staffWithToken('jackson-doc@example.test', 'ed_coo');
  ana = await staffWithToken('ana-doc@example.test', 'tax_preparer');
});

after(async () => {
  await app.close();
});

test('upload + download round-trip through MinIO, audited on every access; cross-client fails closed', async () => {
  const alice = await makeClient('Docalice', 'doc-alice@example.test');
  const mallory = await makeClient('Docmallory', 'doc-mallory@example.test');

  const up = multipartBody({ category: 'tax_documents', taxYear: '2025' }, {
    field: 'file', filename: 'w2 2025 (final).pdf', contentType: 'application/pdf', data: PDF,
  });
  const uploaded = await app.inject({
    method: 'POST', url: '/portal/documents',
    headers: { ...auth(alice), ...up.headers }, payload: up.payload,
  });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const docId = uploaded.json().id as string;
  assert.equal(await docAudits('document.uploaded', docId), 1);

  const row = await app.db.query(`SELECT sha256, size_bytes, minio_bucket FROM documents WHERE id = $1`, [docId]);
  assert.equal(row.rows[0].size_bytes, String(PDF.length));
  assert.equal(row.rows[0].minio_bucket, 'saos-documents');

  // Owner downloads: bytes match, audit row written.
  const dl = await app.inject({
    method: 'GET', url: `/portal/documents/${docId}/download`, headers: auth(alice),
  });
  assert.equal(dl.statusCode, 200);
  assert.deepEqual(dl.rawPayload, PDF, 'downloaded bytes match the upload');
  assert.equal(await docAudits('document.downloaded', docId), 1);

  // Another client gets 404 (no existence oracle) and NO audit access row.
  const denied = await app.inject({
    method: 'GET', url: `/portal/documents/${docId}/download`, headers: auth(mallory),
  });
  assert.equal(denied.statusCode, 404);
  assert.equal(await docAudits('document.downloaded', docId), 1, 'denied attempt streams nothing');

  // Staff download is separately audited; status change too.
  const staffDl = await app.inject({
    method: 'GET', url: `/documents/${docId}/download`, headers: auth(ana),
  });
  assert.equal(staffDl.statusCode, 200);
  assert.equal(await docAudits('document.downloaded', docId), 2);

  const status = await app.inject({
    method: 'PATCH', url: `/documents/${docId}`, headers: auth(ana), payload: { status: 'accepted' },
  });
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(await docAudits('document.status_changed', docId), 1);
});

test('disallowed file types are refused', async () => {
  const bob = await makeClient('Docbob', 'doc-bob@example.test');
  const up = multipartBody({ category: 'tax_documents' }, {
    field: 'file', filename: 'malware.exe', contentType: 'application/x-msdownload', data: PDF,
  });
  const res = await app.inject({
    method: 'POST', url: '/portal/documents',
    headers: { ...auth(bob), ...up.headers }, payload: up.payload,
  });
  assert.equal(res.statusCode, 415);
});

test('IRS-notice upload auto-creates the notice record and alerts the handler role', async () => {
  const carla = await makeClient('Docnotice', 'doc-notice@example.test');
  const up = multipartBody({ category: 'irs_notices' }, {
    field: 'file', filename: 'cp2000-scan.pdf', contentType: 'application/pdf', data: PDF,
  });
  const res = await app.inject({
    method: 'POST', url: '/portal/documents',
    headers: { ...auth(carla), ...up.headers }, payload: up.payload,
  });
  assert.equal(res.statusCode, 201, res.body);

  const notice = await app.db.query(
    `SELECT source, handler_staff_id, document_id FROM irs_notices WHERE contact_id = $1`,
    [carla.contactId]
  );
  assert.equal(notice.rows.length, 1, 'notice record auto-created');
  assert.equal(notice.rows[0].source, 'portal_upload');
  assert.equal(notice.rows[0].handler_staff_id, ana.id, 'routed to the tax_preparer role');
  assert.equal(notice.rows[0].document_id, res.json().id);
  const alert = await app.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'irs_notice_new' AND staff_id = $1 AND contact_id = $2`,
    [ana.id, carla.contactId]
  );
  assert.equal(alert.rows[0].n, 1, 'Ana alerted within the same request');
});

test('itemized request: initial ES email, per-item fulfillment, completion stamps docs_received_at', async () => {
  const dora = await makeClient('Docdora', 'doc-dora@example.test', 'es');
  const eng = await app.inject({
    method: 'POST', url: '/tax-engagements', headers: auth(ana),
    payload: { contactId: dora.contactId, taxYear: 2025, returnType: '1040' },
  });
  const teId = eng.json().id as string;
  await app.inject({
    method: 'POST', url: `/tax-engagements/${teId}/transition`, headers: auth(ana),
    payload: { toStage: 'scheduled' },
  });
  await app.inject({
    method: 'POST', url: `/tax-engagements/${teId}/signatures/wet`, headers: auth(ana),
    payload: { type: 'engagement_letter' },
  });

  const created = await app.inject({
    method: 'POST', url: '/document-requests', headers: auth(ana),
    payload: {
      taxEngagementId: teId,
      titleEn: '2025 tax documents', titleEs: 'Documentos de impuestos 2025',
      items: [
        { labelEn: 'W-2', labelEs: 'Formulario W-2' },
        { labelEn: 'Prior-year return', labelEs: 'Declaración del año anterior' },
      ],
    },
  });
  assert.equal(created.statusCode, 201, created.body);

  // Initial email in Spanish with the Spanish item labels.
  const mail = sentMail.find((m) => m.to === 'doc-dora@example.test');
  assert.ok(mail, 'initial doc_request email sent');
  assert.match(mail.subject, /Documentos necesarios/);
  assert.match(mail.text, /Formulario W-2/);

  // Portal shows the open request + items.
  const portal = await app.inject({ method: 'GET', url: '/portal/document-requests', headers: auth(dora) });
  assert.equal(portal.json().requests.length, 1);
  const items = portal.json().requests[0].items as Array<{ id: string; status: string }>;
  assert.equal(items.length, 2);

  // Fulfil item 1 → partially received. Item 2 → complete + docs_received_at.
  const up1 = multipartBody(
    { category: 'tax_documents', documentRequestItemId: items[0]!.id },
    { field: 'file', filename: 'w2.pdf', contentType: 'application/pdf', data: PDF }
  );
  await app.inject({ method: 'POST', url: '/portal/documents', headers: { ...auth(dora), ...up1.headers }, payload: up1.payload });
  let req = await app.db.query(`SELECT status FROM document_requests WHERE contact_id = $1`, [dora.contactId]);
  assert.equal(req.rows[0].status, 'partially_received');

  const up2 = multipartBody(
    { category: 'tax_documents', documentRequestItemId: items[1]!.id },
    { field: 'file', filename: 'prior.pdf', contentType: 'application/pdf', data: PDF }
  );
  await app.inject({ method: 'POST', url: '/portal/documents', headers: { ...auth(dora), ...up2.headers }, payload: up2.payload });
  req = await app.db.query(`SELECT status, completed_at FROM document_requests WHERE contact_id = $1`, [dora.contactId]);
  assert.equal(req.rows[0].status, 'complete');
  assert.ok(req.rows[0].completed_at);
  const te = await app.db.query(`SELECT docs_received_at FROM tax_engagements WHERE id = $1`, [teId]);
  assert.ok(te.rows[0].docs_received_at, 'engagement stamped when the request completes');
});

test('chase job: recurring reminders + one-time 7-day non-response alert (automations 4–5)', async () => {
  const eli = await makeClient('Docchase', 'doc-chase@example.test');
  const eng = await app.inject({
    method: 'POST', url: '/tax-engagements', headers: auth(ana),
    payload: { contactId: eli.contactId, taxYear: 2025, returnType: '1040' },
  });
  const teId = eng.json().id as string;
  await app.inject({ method: 'POST', url: `/tax-engagements/${teId}/transition`, headers: auth(ana), payload: { toStage: 'scheduled' } });
  await app.inject({ method: 'POST', url: `/tax-engagements/${teId}/signatures/wet`, headers: auth(ana), payload: { type: 'engagement_letter' } });
  await app.inject({
    method: 'POST', url: '/document-requests', headers: auth(ana),
    payload: { taxEngagementId: teId, titleEn: 'Everything', items: [{ labelEn: '1099s' }] },
  });
  // Backdate the request 4 days and the engagement's docs-requested stamp 8
  // days, then run asOf TODAY — everything stays now()-relative so the test
  // can't rot as the calendar advances (the job stamps last_reminder_at with
  // now(), so fixed past asOf dates break the recurrence assertion).
  const asOf = todayChicago();
  // 7 days, not 4 — same midnight-Chicago boundary as docs_requested_at below.
  // The reminder window is 3 days, so 4 days left under a day of slack and
  // `reminders` silently came back 0 in the UTC-ahead-of-Chicago window. The
  // recurrence assertion later (run2 at asOf+4) is unaffected: the job stamps
  // last_reminder_at = now() after reminder #1, so #2 still depends on the
  // 4-day asOf advance, not on this backdate.
  await app.db.query(`UPDATE document_requests SET created_at = now() - interval '7 days' WHERE contact_id = $1`, [eli.contactId]);
  // 14 days, not 8. The alert compares this timestamptz against a 7-day window
  // measured from `todayChicago()::date` (midnight Chicago), so between UTC
  // midnight and Chicago midnight an 8-day backdate leaves under a day of slack
  // and the comparison flips. Same latent boundary as the invoice-overdue spec.
  await app.db.query(`UPDATE tax_engagements SET docs_requested_at = now() - interval '14 days' WHERE id = $1`, [teId]);

  // 4+ days later: reminder #1 + non-response alert (docs requested > 7d before asOf).
  const run1 = await app.inject({ method: 'POST', url: `/jobs/document-chase?asOf=${asOf}`, headers: auth(brian) });
  assert.equal(run1.statusCode, 200, run1.body);
  // Payload in the message: a bare `>= 1` failure tells you nothing about which
  // half of the job came back empty, and this test has two independent windows.
  assert.ok(run1.json().reminders >= 1, `reminder sent — payload ${run1.body}`);
  assert.ok(run1.json().nonResponseAlerts >= 1, `non-response alert fired — payload ${run1.body}`);
  const reminded = sentMail.filter((m) => m.to === 'doc-chase@example.test' && /Reminder|Recordatorio/i.test(m.subject));
  assert.equal(reminded.length, 1);

  const req = await app.db.query(`SELECT reminder_count FROM document_requests WHERE contact_id = $1`, [eli.contactId]);
  assert.equal(req.rows[0].reminder_count, 1);

  // Same date re-run → date guard.
  const rerun = await app.inject({ method: 'POST', url: `/jobs/document-chase?asOf=${asOf}`, headers: auth(brian) });
  assert.equal(rerun.json().skipped, true);

  // Non-response alert reached both leaders, and never duplicates.
  for (const leader of [brian, jackson]) {
    const n = await app.db.query(
      `SELECT count(*)::int AS n FROM notifications WHERE type = 'client_non_response' AND staff_id = $1 AND contact_id = $2`,
      [leader.id, eli.contactId]
    );
    assert.equal(n.rows[0].n, 1, `alert for ${leader.email}`);
  }
  // +7, not +4. last_reminder_at was stamped with now() (a timestamptz) and the
  // window is measured from a date-truncated asOf, so a 4-day advance against a
  // 3-day window left under a day of slack — the third instance of this boundary
  // in this one test. Advance past it comfortably; recurrence is still proven.
  const run2 = await app.inject({ method: 'POST', url: `/jobs/document-chase?asOf=${addDays(asOf, 7)}`, headers: auth(brian) });
  assert.ok(run2.json().reminders >= 1, `reminders recur every N days — payload ${run2.body}`);
  const stillOne = await app.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'client_non_response' AND contact_id = $1`,
    [eli.contactId]
  );
  assert.equal(stillOne.rows[0].n, 2, 'non-response alert stays once per leader');
});

test('return delivery: staff uploads the ATX PDF → stage moves to client_review + client notified', async () => {
  const fern = await makeClient('Docreturn', 'doc-return@example.test');
  const eng = await app.inject({
    method: 'POST', url: '/tax-engagements', headers: auth(ana),
    payload: { contactId: fern.contactId, taxYear: 2025, returnType: '1040' },
  });
  const teId = eng.json().id as string;
  // Fabricate mid-pipeline state (letter + estimate satisfied, at internal review).
  await app.db.query(
    `UPDATE tax_engagements
     SET stage = 'internal_review', engagement_letter_signed_at = now(), estimate_locked_at = now()
     WHERE id = $1`,
    [teId]
  );

  const up = multipartBody(
    { contactId: fern.contactId, category: 'return_deliverable', taxEngagementId: teId, taxYear: '2025' },
    { field: 'file', filename: '2025-return-final.pdf', contentType: 'application/pdf', data: PDF }
  );
  const res = await app.inject({
    method: 'POST', url: '/documents', headers: { ...auth(ana), ...up.headers }, payload: up.payload,
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().stageMoved, true);

  const te = await app.db.query(`SELECT stage FROM tax_engagements WHERE id = $1`, [teId]);
  assert.equal(te.rows[0].stage, 'client_review');
  const mail = sentMail.find((m) => m.to === 'doc-return@example.test');
  assert.ok(mail, 'client notified of delivery');
  assert.match(mail.subject, /ready to review/i);
  const bucket = await app.db.query(`SELECT minio_bucket FROM documents WHERE tax_engagement_id = $1`, [teId]);
  assert.equal(bucket.rows[0].minio_bucket, 'saos-returns');
});
