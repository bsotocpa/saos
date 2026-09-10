// M28 "Prove it": the wireframe gaps closed.
//
// Three of the five gaps from tasks/m28-wireframe-conformance.md are API-backed
// and tested here:
//
//   · PREPARER QUEUE (preparer step 1) — deadline-first, rejects pinned to the
//     top, and SCOPED so a preparer cannot see another preparer's returns.
//   · CLIENT PACKET (preparer step 2) — one client's returns and documents, with
//     the document list audited because CLAUDE.md requires every document access
//     to be logged.
//   · CLIENT NOTICE VIEW (customer step 8) — the client sees that it is handled,
//     and never sees the internal machinery.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { withTransaction } from '../src/db.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, auditRows, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { addDays, todayChicago } from '../src/modules/tax/deadlines.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let ana: TestStaff & { token: string };
let marta: TestStaff & { token: string };

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${email.split('-')[0]}`, role, password: `${role}-password-1234567`, totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

/** A return assigned to a preparer, with an explicit deadline and stage. */
async function makeReturn(opts: {
  label: string; preparerId: string; returnType?: string; stage?: string;
  originalDeadline?: string | null; extendedDeadline?: string | null;
  extensionFiled?: boolean; docsReceived?: boolean; perfectionDeadline?: string | null;
}): Promise<{ taxEngagementId: string; contactId: string }> {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: opts.label, email: `${opts.label.toLowerCase()}-m28@example.test`,
  });
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status) VALUES ($1, 'tax', 'active') RETURNING id`,
    [c.id]
  );
  /*
   * A LIVE PERFECTION CLOCK NEEDS ITS OWNING TASK, IN THE SAME TRANSACTION (#48).
   *
   * The fixture used to set the deadline alone, which is the state the deferred constraint now
   * forbids: a statutory clock nobody is watching. Two separate statements would not do —
   * outside an explicit transaction each is its own, so the trigger fires at the end of the
   * INSERT and never sees the task. The real path writes both inside one transaction, and a
   * fixture that cannot model the real path is not a fixture.
   */
  const teId = await withTransaction(app.db, async () => {
    const te = await app.db.query<{ id: string }>(
      `INSERT INTO tax_engagements
         (engagement_id, tax_year, return_type, stage, preparer_id, original_deadline, extended_deadline,
          extension_filed, docs_received_at, perfection_deadline)
       VALUES ($1, 2025, $2::return_type, $3::tax_stage, $4, $5::date, $6::date, $7, $8, $9::date)
       RETURNING id`,
      [
        eng.rows[0]!.id, opts.returnType ?? '1040', opts.stage ?? 'in_preparation', opts.preparerId,
        opts.originalDeadline ?? null, opts.extendedDeadline ?? null, opts.extensionFiled ?? false,
        opts.docsReceived ? new Date() : null, opts.perfectionDeadline ?? null,
      ]
    );
    if (opts.perfectionDeadline) {
      await app.db.query(
        `INSERT INTO tasks (title, assigned_staff_id, contact_id, due_date, priority,
                            source, source_type, source_id)
         VALUES ($1, $2, $3, $4::date, 1, 'automation', 'efile_reject', $5)`,
        [
          `E-file REJECTED: Synthetic ${opts.label} — fix & re-file by ${opts.perfectionDeadline}`,
          opts.preparerId, c.id, opts.perfectionDeadline, te.rows[0]!.id,
        ]
      );
    }
    return te.rows[0]!.id;
  });
  return { taxEngagementId: teId, contactId: c.id };
}

before(async () => {
  config = await createTestConfig('m28');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  brian = await staffWithToken('brian-m28@example.test', 'ceo');
  ana = await staffWithToken('ana-m28@example.test', 'tax_preparer');
  marta = await staffWithToken('marta-m28@example.test', 'tax_preparer');
});

after(async () => {
  await app.close();
});

test('the preparer queue is deadline-first with rejects pinned to the top', async () => {
  const today = todayChicago();
  // Deliberately inserted out of order.
  await makeReturn({ label: 'Later', preparerId: ana.id, originalDeadline: addDays(today, 60) });
  await makeReturn({ label: 'Sooner', preparerId: ana.id, originalDeadline: addDays(today, 5) });
  // A reject with a LATER deadline than both — it must still come first, because
  // the perfection clock is shorter than any filing deadline.
  await makeReturn({
    label: 'Rejected', preparerId: ana.id, stage: 'rejected',
    originalDeadline: addDays(today, 90), perfectionDeadline: addDays(today, 3),
  });

  const res = await app.inject({ method: 'GET', url: '/my-queue', headers: auth(ana) });
  assert.equal(res.statusCode, 200, res.body);
  const q = res.json();

  assert.deepEqual(
    q.queue.map((r: { client: string }) => r.client),
    ['Synthetic Rejected', 'Synthetic Sooner', 'Synthetic Later'],
    'rejects first, then deadline order'
  );
  assert.equal(q.queue[0].rejected, true);
  assert.equal(q.queue[0].perfectionDeadline, addDays(today, 3));
  assert.equal(q.queue[1].daysLeft, 5, 'days-left is derived against the firm today');
  assert.equal(q.counts.total, 3);
  assert.equal(q.counts.rejected, 1);
  assert.equal(q.counts.awaitingDocs, 3, 'nothing has documents in yet');

  // Completed work leaves the queue.
  await app.db.query(
    `UPDATE tax_engagements SET stage = 'completed' WHERE preparer_id = $1 AND stage = 'rejected'`,
    [ana.id]
  );
  const after = await app.inject({ method: 'GET', url: '/my-queue', headers: auth(ana) });
  assert.equal(after.json().counts.total, 2);
  assert.equal(after.json().counts.rejected, 0);
});

test('a preparer sees ONLY their own returns, whatever they ask for', async () => {
  await makeReturn({ label: 'Martas', preparerId: marta.id, originalDeadline: addDays(todayChicago(), 10) });

  // Ana's queue does not contain Marta's work.
  const anas = await app.inject({ method: 'GET', url: '/my-queue', headers: auth(ana) });
  assert.equal(anas.json().scoped, true);
  assert.ok(
    !anas.json().queue.some((r: { client: string }) => r.client.includes('Martas')),
    'no cross-preparer visibility'
  );

  // Asking for Marta's queue by id gets Ana her OWN queue, not an error page.
  const asked = await app.inject({
    method: 'GET', url: `/my-queue?preparerId=${marta.id}`, headers: auth(ana),
  });
  assert.equal(asked.statusCode, 200);
  assert.equal(asked.json().preparerId, ana.id, 'the id is ignored, not honoured');
  assert.ok(!asked.json().queue.some((r: { client: string }) => r.client.includes('Martas')));

  // Leadership may look at a preparer's queue deliberately.
  const leadership = await app.inject({
    method: 'GET', url: `/my-queue?preparerId=${marta.id}`, headers: auth(brian),
  });
  assert.equal(leadership.json().preparerId, marta.id);
  assert.equal(leadership.json().scoped, false);
  assert.equal(leadership.json().counts.total, 1);
});

test('at-risk uses the SAME setting as the extension board, not a second rule', async () => {
  const today = todayChicago();
  // Extended, no documents. Whether it is "at risk" depends on the shared
  // extension.at_risk_no_docs_by setting, so drive the setting and watch it flip.
  await makeReturn({
    label: 'Extendednodocs', preparerId: marta.id, extensionFiled: true,
    originalDeadline: addDays(today, 5), extendedDeadline: addDays(today, 120),
  });

  await app.db.query(
    `UPDATE app_settings SET value = to_jsonb('12-31'::text) WHERE key = 'extension.at_risk_no_docs_by'`
  );
  const early = await app.inject({ method: 'GET', url: '/my-queue', headers: auth(marta) });
  assert.equal(early.json().counts.atRisk, 0, 'before the at-risk date, nothing is at risk');

  await app.db.query(
    `UPDATE app_settings SET value = to_jsonb('01-01'::text) WHERE key = 'extension.at_risk_no_docs_by'`
  );
  const late = await app.inject({ method: 'GET', url: '/my-queue', headers: auth(marta) });
  assert.equal(late.json().counts.atRisk, 1, 'the shared setting drives both screens');
  const flagged = late.json().queue.find((r: { client: string }) => r.client.includes('Extendednodocs'));
  assert.equal(flagged.atRisk, true);
  assert.equal(flagged.extended, true);

  await app.db.query(
    `UPDATE app_settings SET value = to_jsonb('08-15'::text) WHERE key = 'extension.at_risk_no_docs_by'`
  );
});

test('the client packet scopes returns to one client, and lists documents WITH an audit row', async () => {
  const mine = await makeReturn({ label: 'Packet', preparerId: ana.id, originalDeadline: addDays(todayChicago(), 30) });
  await makeReturn({ label: 'Someoneelse', preparerId: ana.id, originalDeadline: addDays(todayChicago(), 30) });

  // Returns filter by contact — the packet must not show the whole firm.
  const scoped = await app.inject({
    method: 'GET', url: `/tax-engagements?contactId=${mine.contactId}`, headers: auth(ana),
  });
  assert.equal(scoped.statusCode, 200, scoped.body);
  assert.equal(scoped.json().taxEngagements.length, 1);
  assert.equal(scoped.json().taxEngagements[0].id, mine.taxEngagementId);

  // A document on the record.
  await app.db.query(
    `INSERT INTO documents (contact_id, category, filename, minio_bucket, minio_key, sha256,
                            uploaded_by_type, size_bytes, mime_type)
     VALUES ($1, 'tax_documents', 'W-2_2025.pdf', 'saos', 'k/1', repeat('a', 64), 'client', 1024, 'application/pdf')`,
    [mine.contactId]
  );

  const before = await auditRows(app.db, 'documents.listed');
  const docs = await app.inject({
    method: 'GET', url: `/documents?contactId=${mine.contactId}`, headers: auth(ana),
  });
  assert.equal(docs.statusCode, 200, docs.body);
  assert.equal(docs.json().documents.length, 1);
  assert.equal(docs.json().documents[0].original_filename, 'W-2_2025.pdf');

  // CLAUDE.md: every document access is logged. Listing is an access.
  assert.equal(await auditRows(app.db, 'documents.listed'), before + 1);
  const audit = await app.db.query<{ actor_label: string; contact_id: string; details: { count: number } }>(
    `SELECT actor_label, contact_id, details FROM audit_log
     WHERE action = 'documents.listed' ORDER BY occurred_at DESC LIMIT 1`
  );
  assert.equal(audit.rows[0]!.actor_label, ana.fullName, 'the audit names who looked');
  assert.equal(audit.rows[0]!.contact_id, mine.contactId);
  assert.equal(audit.rows[0]!.details.count, 1);

  // The list is metadata only — no storage key or bucket leaks to the client app.
  const keys = Object.keys(docs.json().documents[0]);
  assert.ok(!keys.includes('minio_key'), 'no storage key in a list response');
  assert.ok(!keys.includes('minio_bucket'));
  assert.ok(!keys.includes('sha256'));

  // contactId is required — an unscoped document dump is not a thing.
  const unscoped = await app.inject({ method: 'GET', url: '/documents', headers: auth(ana) });
  assert.equal(unscoped.statusCode, 400);
});

test('the client sees that a notice is handled, and never sees the internal machinery', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Noticed', email: 'noticed-m28@example.test' });
  const portal = await app.db.query<{ id: string }>(
    `INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`,
    [c.id, 'noticed-m28@example.test']
  );
  const session = await app.db.query<{ token: string }>(
    `INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at)
     VALUES ($1, encode(sha256('m28-client-token'::bytea), 'hex'), now() + interval '1 hour')
     RETURNING 'm28-client-token' AS token`,
    [portal.rows[0]!.id]
  );
  const clientAuth = { cookie: `saos_portal_session=${session.rows[0]!.token}` };

  await app.db.query(
    `INSERT INTO irs_notices (contact_id, notice_type, tax_year, status, response_deadline,
                              received_at, service_tier, handler_staff_id, resolution_notes)
     VALUES ($1, 'CP2000', 2024, 'under_review', $2::date, now(), 'premium', $3,
             'Internal: client under-reported 1099-K; drafting a partial agreement.')`,
    [c.id, addDays(todayChicago(), 21), ana.id]
  );

  const res = await app.inject({ method: 'GET', url: '/portal/notices', headers: clientAuth });
  assert.equal(res.statusCode, 200, res.body);
  const n = res.json().notices[0];
  assert.equal(n.noticeType, 'CP2000');
  assert.equal(n.taxYear, 2024);
  assert.equal(n.clientState, 'in_progress', 'internal stages collapse to "we are on it"');
  assert.ok(n.responseDeadline);

  // The internal machinery must NOT be in the payload.
  const body = JSON.stringify(res.json());
  assert.ok(!body.includes('under_review'), 'the internal stage name never ships');
  assert.ok(!body.includes('premium'), 'the service tier is ours');
  assert.ok(!body.includes(ana.id), 'the handler is not named to the client');
  assert.ok(!body.includes('under-reported'), 'internal resolution notes never ship');

  // Later stages read as the client would expect.
  await app.db.query(`UPDATE irs_notices SET status = 'response_sent' WHERE contact_id = $1`, [c.id]);
  assert.equal(
    (await app.inject({ method: 'GET', url: '/portal/notices', headers: clientAuth })).json().notices[0].clientState,
    'response_sent'
  );
  await app.db.query(`UPDATE irs_notices SET status = 'resolved' WHERE contact_id = $1`, [c.id]);
  assert.equal(
    (await app.inject({ method: 'GET', url: '/portal/notices', headers: clientAuth })).json().notices[0].clientState,
    'resolved'
  );

  // And a client only ever sees their OWN notices.
  const other = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Otherclient', email: 'other-m28@example.test' });
  await app.db.query(
    `INSERT INTO irs_notices (contact_id, notice_type, status, received_at)
     VALUES ($1, 'CP14', 'received', now())`,
    [other.id]
  );
  const stillMine = await app.inject({ method: 'GET', url: '/portal/notices', headers: clientAuth });
  assert.equal(stillMine.json().notices.length, 1);
  assert.ok(!JSON.stringify(stillMine.json()).includes('CP14'));
});
