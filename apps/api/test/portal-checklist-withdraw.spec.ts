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

/** A signed Master, which is what unlocks every §7216 offer. */
async function signedPacket(contactId: string) {
  await app.db.query(
    `INSERT INTO engagement_packets (contact_id, master_template_key, master_version, schedule_codes, status, signed_at, signature_method)
     VALUES ($1, 'engagement_master', 1, ARRAY[]::text[], 'signed', now(), 'portal_esign')`,
    [contactId]
  );
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

/*
 * INVERTED 2026-08-16. This asserted that booking was retired and unrendered — true
 * between 2026-08-13 and Brian's canonical-journey ruling, which brings it back as step
 * 6, optional and completable at any time. The premise changed, so the assertion states
 * the new premise rather than being deleted.
 *
 * What did NOT change: a client is never asked to book the discovery call they already
 * had. Step 6 is the KICKOFF, which happens after the engagement exists.
 */
test('the checklist carries the canonical journey: booking is back as optional, the deposit is gone', async () => {
  const { cookie } = await portalClient('NoBooking');
  const res = await app.inject({ method: 'GET', url: '/portal/onboarding', headers: cookie });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { onboarding: Record<string, unknown>; bookingApplies: boolean };

  for (const k of ['step_sign_docs_at', 'step_consent_at', 'step_confirm_info_at',
                   'step_questionnaire_at', 'step_upload_documents_at',
                   'step_track_services_at', 'step_book_consult_at']) {
    assert.ok(k in body.onboarding, `${k} is part of the canonical journey`);
  }

  // The deposit column is still SERVED — it holds real history — but it is no longer a
  // step the client is shown, because it is collected at quote acceptance, before this
  // journey begins. Nothing here should hold a client open for it.
  assert.ok('step_pay_deposit_at' in body.onboarding, 'deposit history stays readable');

  // Booking is only offered where there is somewhere to book.
  assert.equal(body.bookingApplies, false, 'no scheduler configured in a fresh database');
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

/*
 * #34 — SEQUENCING /consent AND BOOKING INTO THE CHECKLIST (Brian, 2026-08-16).
 *
 * The consent screen has existed since #12 and RC2 was signed on it. Nothing in the
 * portal ever linked to it: the dashboard knew an offer was outstanding — it used the
 * count to suppress "you're all caught up" — and gave the client no route there. A
 * client could finish every step and never be asked.
 */
test('§7216 consent is a step only AFTER the packet is signed, and never before', async () => {
  const { contactId, cookie } = await portalClient('Consentstep');

  // Before signing, consentsToPresent withholds every offer — "a consent presented
  // alongside the document a client must sign to be served is the conditioning §7216
  // prohibits" — so there must be no step to see.
  const before = await app.inject({ method: 'GET', url: '/portal/onboarding', headers: cookie });
  assert.equal(before.statusCode, 200, before.body);
  assert.equal(before.json().consentApplies, false, 'no consent step before the Master is signed');

  await signedPacket(contactId);

  const after = await app.inject({ method: 'GET', url: '/portal/onboarding', headers: cookie });
  assert.equal(after.json().consentApplies, true, 'the step appears once the packet is signed');
  assert.equal(after.json().onboarding.step_consent_at, null, 'and it is not done yet');
});

test('DECLINING the consent completes the step — setup never depends on consenting', async () => {
  const { contactId, cookie } = await portalClient('Declines');
  await signedPacket(contactId);

  const offered = await app.inject({ method: 'GET', url: '/portal/consents', headers: cookie });
  assert.equal(offered.statusCode, 200, offered.body);
  const kinds = offered.json().offers.map((o: { kind: string }) => o.kind);
  assert.ok(kinds.includes('7216_use'), 'the USE consent is offered after signing');

  const declined = await app.inject({
    method: 'POST', url: '/portal/consents', headers: cookie,
    payload: { kind: '7216_use', granted: false },
  });
  assert.equal(declined.statusCode, 200, declined.body);
  assert.equal(declined.json().status, 'declined');

  /*
   * The whole point. §7216 is a rule against conditioning service on consent, so a
   * checklist step that only completed on "yes" would apply exactly the pressure the
   * regulation forbids — in a different place. Answering completes it.
   */
  const row = await app.db.query<{ step_consent_at: Date | null }>(
    `SELECT step_consent_at FROM portal_onboarding WHERE contact_id = $1`,
    [contactId]
  );
  assert.ok(row.rows[0]!.step_consent_at, 'a client who declines has answered, and the step is done');

  const gate = await app.db.query<{ consent_7216_status: string }>(
    `SELECT consent_7216_status FROM contacts WHERE id = $1`,
    [contactId]
  );
  assert.equal(gate.rows[0]!.consent_7216_status, 'declined', 'and the gate still says no');
});

test('booking completes from the Cal.com webhook, never from a client saying so', async () => {
  const { contactId, cookie } = await portalClient('Bookstep');
  const email = 'bookstep@example.test';

  // Not open unless a scheduler is configured — a step pointing nowhere is not a step.
  const closed = await app.inject({ method: 'GET', url: '/portal/onboarding', headers: cookie });
  assert.equal(closed.json().bookingApplies, false, 'no booking step while scheduling is closed');

  await app.db.query(
    `INSERT INTO app_settings (key, value) VALUES ('booking.client_booking_url', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify('https://cal.example.test/kickoff')]
  );
  const open = await app.inject({ method: 'GET', url: '/portal/onboarding', headers: cookie });
  assert.equal(open.json().bookingApplies, true, 'the step appears once there is somewhere to book');
  assert.equal(open.json().onboarding.step_book_consult_at, null, 'nothing booked yet');

  const hook = await app.inject({
    method: 'POST', url: '/webhooks/calcom',
    headers: { 'x-webhook-secret': config.WEBHOOK_SECRET },
    payload: {
      triggerEvent: 'BOOKING_CREATED',
      payload: {
        type: 'kickoff',
        startTime: '2026-09-01T15:00:00Z',
        attendees: [{ email, name: 'Synthetic Bookstep', language: 'en' }],
      },
    },
  });
  assert.equal(hook.statusCode, 200, hook.body);

  const row = await app.db.query<{ step_book_consult_at: Date | null }>(
    `SELECT step_book_consult_at FROM portal_onboarding WHERE contact_id = $1`,
    [contactId]
  );
  assert.ok(row.rows[0]!.step_book_consult_at, 'the booking arriving is what completes the step');
});

test('booking is optional: it never holds the checklist open, and the deposit no longer does either', async () => {
  const { contactId, cookie } = await portalClient('Optionalbook');
  await app.db.query(
    `UPDATE portal_onboarding SET
       step_sign_docs_at = now(), step_confirm_info_at = now(),
       step_upload_documents_at = now()
     WHERE contact_id = $1`,
    [contactId]
  );

  const done = await app.inject({
    method: 'POST', url: '/portal/onboarding/steps/track_services/complete', headers: cookie,
  });
  assert.equal(done.statusCode, 200, done.body);

  const row = await app.db.query<{ completed_at: Date | null; step_book_consult_at: Date | null }>(
    `SELECT completed_at, step_book_consult_at FROM portal_onboarding WHERE contact_id = $1`,
    [contactId]
  );
  assert.ok(row.rows[0]!.completed_at, 'finished without booking — the ruling made it optional');
  assert.equal(row.rows[0]!.step_book_consult_at, null, 'and it really was not booked');
});
