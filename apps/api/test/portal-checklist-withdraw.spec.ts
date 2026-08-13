// Portal home redesign + document withdraw (Brian's rulings from the 2026-08-13 run).
//
// Two behaviours carry the weight here:
//
//   PAY DEPOSIT COMPLETES ITSELF. During the rehearsal the deposit was genuinely paid
//   while the checklist would have shown it outstanding. A checklist that asks a client
//   to confirm something the system can already see is a checklist that lies.
//
//   REMOVE MEANS WITHDRAW. A client needs an undo for the wrong file; the record needs
//   to keep the fact that they sent it. So the row survives, the request re-opens, and
//   the chase resumes — the failure mode being guarded against is a document request
//   that reads "received" while pointing at a file nobody can see.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, multipartBody } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };

async function portalClient(name: string) {
  const email = `${name.toLowerCase()}@example.test`;
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: name, email });
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
  await app.db.query(
    `INSERT INTO portal_onboarding (contact_id) VALUES ($1) ON CONFLICT (contact_id) DO NOTHING`,
    [c.id]
  );
  return { contactId: c.id, cookie: { cookie: `saos_portal_session=${token}` } };
}

function upload(cookie: { cookie: string }, fields: Record<string, string>) {
  const mp = multipartBody(fields, {
    field: 'file',
    filename: 'w2.pdf',
    contentType: 'application/pdf',
    data: Buffer.from('%PDF-1.4 synthetic\n%%EOF'),
  });
  return { payload: mp.payload, headers: { ...mp.headers, ...cookie } };
}

before(async () => {
  config = await createTestConfig('portalredesign');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
});

after(async () => {
  await app.close();
});

test('the checklist no longer asks a client to book a consultation they already had', async () => {
  const { cookie } = await portalClient('NoBooking');
  const res = await app.inject({ method: 'GET', url: '/portal/onboarding', headers: cookie });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { onboarding: Record<string, unknown> };

  // The retired step is not in the payload the portal renders from.
  assert.ok(!('step_book_consult_at' in body.onboarding), 'book_consult is retired, not rendered');
  // But its column still EXISTS — it holds real dates from real clients.
  const col = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'portal_onboarding' AND column_name = 'step_book_consult_at'`
  );
  assert.equal(col.rows[0]!.n, 1, 'retired means "stop reading it", not "delete the history"');

  for (const k of ['step_sign_docs_at', 'step_pay_deposit_at', 'step_confirm_info_at',
                   'step_upload_documents_at', 'step_track_services_at']) {
    assert.ok(k in body.onboarding, `${k} is part of the new checklist`);
  }
});

test('the completion route accepts the new steps and refuses the retired one', async () => {
  const { cookie } = await portalClient('StepRoute');
  const ok = await app.inject({
    method: 'POST', url: '/portal/onboarding/steps/upload_documents/complete', headers: cookie,
  });
  assert.equal(ok.statusCode, 200, ok.body);

  const gone = await app.inject({
    method: 'POST', url: '/portal/onboarding/steps/book_consult/complete', headers: cookie,
  });
  assert.notEqual(gone.statusCode, 200, 'a retired step is not completable');
});

test('PAY DEPOSIT ticks itself when the invoice is paid — the client is never asked', async () => {
  const { contactId, cookie } = await portalClient('DepositTicks');

  const before = await app.inject({ method: 'GET', url: '/portal/onboarding', headers: cookie });
  const b = before.json() as { onboarding: Record<string, unknown>; depositApplies: boolean };
  assert.equal(b.onboarding.step_pay_deposit_at, null, 'nothing paid yet');
  assert.equal(b.depositApplies, false, 'and no deposit is owed, so the step is hidden');

  // A quote with a deposit invoice, unpaid.
  const inv = await app.db.query<{ id: string }>(
    `INSERT INTO invoices (contact_id, invoice_number, status, total_cents)
     VALUES ($1, 'SA-TEST-0001', 'sent', 25000) RETURNING id`,
    [contactId]
  );
  const version = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions ORDER BY version_number DESC LIMIT 1`
  );
  await app.db.query(
    `INSERT INTO quotes (contact_id, status, total_cents, price_book_version_id, deposit_invoice_id)
     VALUES ($1, 'accepted', 25000, $2, $3)`,
    [contactId, version.rows[0]!.id, inv.rows[0]!.id]
  );

  const owed = await app.inject({ method: 'GET', url: '/portal/onboarding', headers: cookie });
  const o = owed.json() as { onboarding: Record<string, unknown>; depositApplies: boolean };
  assert.equal(o.depositApplies, true, 'a deposit is owed, so the step appears');
  assert.equal(o.onboarding.step_pay_deposit_at, null, 'still unpaid, still unticked');

  // Pay it, the way the Stripe webhook does.
  await app.db.query(`UPDATE invoices SET status = 'paid', paid_at = now() WHERE id = $1`, [inv.rows[0]!.id]);

  const after = await app.inject({ method: 'GET', url: '/portal/onboarding', headers: cookie });
  const a = after.json() as { onboarding: Record<string, unknown> };
  assert.ok(a.onboarding.step_pay_deposit_at, 'the step completed ITSELF when the money arrived');

  // And it persisted with a real date rather than being computed each read.
  const row = await app.db.query<{ at: Date | null }>(
    `SELECT step_pay_deposit_at AS at FROM portal_onboarding WHERE contact_id = $1`,
    [contactId]
  );
  assert.ok(row.rows[0]!.at, 'the completion has a date, like every other step');
});

test('WITHDRAW hides the file, re-opens the request, and keeps the record', async () => {
  const { contactId, cookie } = await portalClient('WithdrawIt');

  const req = await app.db.query<{ id: string }>(
    `INSERT INTO document_requests (contact_id, title_en) VALUES ($1, 'Send your W-2') RETURNING id`,
    [contactId]
  );
  const item = await app.db.query<{ id: string }>(
    `INSERT INTO document_request_items (request_id, label_en) VALUES ($1, 'W-2') RETURNING id`,
    [req.rows[0]!.id]
  );

  const up = await app.inject({
    method: 'POST', url: '/portal/documents',
    ...upload(cookie, { category: 'tax_documents', documentRequestItemId: item.rows[0]!.id }),
  });
  assert.equal(up.statusCode, 201, up.body);
  const { id } = up.json() as { id: string };

  const fulfilled = await app.db.query<{ status: string }>(
    `SELECT status::text AS status FROM document_request_items WHERE id = $1`,
    [item.rows[0]!.id]
  );
  assert.equal(fulfilled.rows[0]!.status, 'received', 'precondition: the upload answered the request');

  // The client realises it was the wrong file.
  const wd = await app.inject({
    method: 'POST', url: `/portal/documents/${id}/withdraw`, headers: cookie,
    payload: { reason: 'wrong year' },
  });
  assert.equal(wd.statusCode, 200, wd.body);

  // Gone from the client's list…
  const list = await app.inject({ method: 'GET', url: '/portal/documents', headers: cookie });
  const docs = (list.json() as { documents: Array<{ id: string }> }).documents;
  assert.ok(!docs.some((d) => d.id === id), 'the client no longer sees it');

  // …but NOT gone from the record.
  const row = await app.db.query<{ withdrawn_at: Date | null; reason: string | null; by: string | null }>(
    `SELECT withdrawn_at, withdrawn_reason AS reason, withdrawn_by_type::text AS by
       FROM documents WHERE id = $1`,
    [id]
  );
  assert.ok(row.rows[0]!.withdrawn_at, 'the row survives, stamped');
  assert.equal(row.rows[0]!.reason, 'wrong year');
  assert.equal(row.rows[0]!.by, 'client');

  // And the chase RESUMES — this is the point.
  const reopened = await app.db.query<{ status: string; document_id: string | null }>(
    `SELECT status::text AS status, document_id FROM document_request_items WHERE id = $1`,
    [item.rows[0]!.id]
  );
  assert.equal(reopened.rows[0]!.status, 'pending', 'the request wants something again');
  assert.equal(reopened.rows[0]!.document_id, null, 'and no longer points at a file nobody can see');

  const audit = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = 'document.withdrawn' AND object_id = $1`,
    [id]
  );
  assert.equal(audit.rows[0]!.n, 1, 'withdrawing is an audited act');
});

test('a client cannot withdraw someone else’s document, and a double tap is not an error', async () => {
  const mine = await portalClient('WithdrawMine');
  const theirs = await portalClient('WithdrawTheirs');

  const up = await app.inject({
    method: 'POST', url: '/portal/documents', ...upload(theirs.cookie, { category: 'tax_documents' }),
  });
  const { id } = up.json() as { id: string };

  const crossed = await app.inject({
    method: 'POST', url: `/portal/documents/${id}/withdraw`, headers: mine.cookie,
  });
  assert.equal(crossed.statusCode, 404, 'someone else’s document does not exist to you');

  const first = await app.inject({
    method: 'POST', url: `/portal/documents/${id}/withdraw`, headers: theirs.cookie,
  });
  assert.equal(first.statusCode, 200);
  const second = await app.inject({
    method: 'POST', url: `/portal/documents/${id}/withdraw`, headers: theirs.cookie,
  });
  assert.equal(second.statusCode, 200, 'a double tap on a phone is not a failure');
});
