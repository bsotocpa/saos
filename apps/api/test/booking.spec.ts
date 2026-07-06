// M18 "Prove it": two-lane booking webhook — Lane 1 collects the price-book
// deposit at booking (true-up), Lane 2 is always free; find-or-create contact
// dedupe; unmapped slugs + non-Zoom discovery flagged to staff; secret
// enforced. Deposit charge exercised via the stub Stripe adapter (live
// test-mode parked on Brian's keys, as with M13). Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { createTestConfig, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let rene: TestStaff;

const sentMail: MailMessage[] = [];
const capturingMailer: Mailer = {
  transport: 'console',
  async send(msg) {
    sentMail.push(msg);
    return { id: `captured-${sentMail.length}` };
  },
};

function booking(slug: string, email: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    triggerEvent: 'BOOKING_CREATED',
    payload: {
      type: slug,
      title: 'Synthetic booking',
      startTime: '2026-08-01T15:00:00Z',
      attendees: [{ email, name, language: 'en' }],
      videoCallData: { type: 'zoom_video' },
      ...extra,
    },
  };
}

async function postBooking(payload: Record<string, unknown>, secret?: string) {
  return app.inject({
    method: 'POST',
    url: '/webhooks/calcom',
    headers: { 'x-webhook-secret': secret ?? config.WEBHOOK_SECRET },
    payload: payload as never,
  });
}

before(async () => {
  config = await createTestConfig('book');
  app = buildServer(config, { mailer: capturingMailer });
  await app.ready();
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  rene = await makeStaff(app.db, config, {
    email: 'rene-book@example.test', name: 'Synthetic comms', role: 'comms_billing',
    password: 'rene-password-123456', totpSecret: secret,
  });
});

after(async () => {
  await app.close();
});

test('lane 1 discovery: contact created + price-book deposit + checkout link emailed', async () => {
  const res = await postBooking(booking('new-client-discovery', 'booked@example.test', 'Nina Booked'));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().lane, 'discovery');

  const contact = await app.db.query<{ id: string; soto_status: string; how_heard: string }>(
    `SELECT id, soto_status, how_heard FROM contacts WHERE email = 'booked@example.test'`
  );
  assert.equal(contact.rows.length, 1);
  assert.equal(contact.rows[0]!.soto_status, 'lead');
  assert.equal(contact.rows[0]!.how_heard, 'booking');

  const invoice = await app.db.query(
    `SELECT total_cents, status, stripe_checkout_session_id FROM invoices WHERE contact_id = $1`,
    [contact.rows[0]!.id]
  );
  assert.equal(invoice.rows.length, 1);
  assert.equal(invoice.rows[0].total_cents, 25000, 'DEPOSIT_1040 from the price book');
  assert.equal(invoice.rows[0].status, 'sent');
  assert.match(invoice.rows[0].stripe_checkout_session_id, /^cs_stub_/);

  const mail = sentMail.find((m) => m.to === 'booked@example.test');
  assert.ok(mail, 'deposit email sent');
  assert.match(mail.subject, /one quick step/i);
  assert.match(mail.text, /\$250\.00/);
  assert.match(mail.text, /checkout\.stripe\.example/);
  assert.match(mail.text, /applies in full toward your final invoice/i, 'true-up language at checkout');
});

test('lane 1 dedupe: an existing contact is linked, never duplicated', async () => {
  await app.db.query(
    `INSERT INTO contacts (first_name, last_name, email, soto_status) VALUES ('Synthetic', 'Repeat', 'repeat-book@example.test', 'active')`
  );
  const res = await postBooking(booking('new-client-discovery', 'repeat-book@example.test', 'Repeat Person'));
  assert.equal(res.statusCode, 200);
  const contacts = await app.db.query(
    `SELECT count(*)::int AS n FROM contacts WHERE email = 'repeat-book@example.test'`
  );
  assert.equal(contacts.rows[0].n, 1);
});

test('lane 1 variant: business-discovery slug charges the business deposit', async () => {
  const res = await postBooking(booking('business-discovery', 'bizbook@example.test', 'Biz Booker'));
  assert.equal(res.statusCode, 200, res.body);
  const invoice = await app.db.query(
    `SELECT i.total_cents FROM invoices i JOIN contacts c ON c.id = i.contact_id WHERE c.email = 'bizbook@example.test'`
  );
  assert.equal(invoice.rows[0].total_cents, 30000, 'DEPOSIT_BUSINESS_TAX from the price book');
});

test('lane 2: question calls are always free — task, no invoice, nothing billed', async () => {
  const res = await postBooking(booking('general-inquiries', 'asker@example.test', 'Question Asker'));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().lane, 'questions');

  const contact = await app.db.query<{ id: string }>(`SELECT id FROM contacts WHERE email = 'asker@example.test'`);
  const invoices = await app.db.query(`SELECT count(*)::int AS n FROM invoices WHERE contact_id = $1`, [contact.rows[0]!.id]);
  assert.equal(invoices.rows[0].n, 0, 'questions are never billed');
  const task = await app.db.query(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'booking_question' AND contact_id = $1`,
    [contact.rows[0]!.id]
  );
  assert.equal(task.rows[0].n, 1);
});

test('unmapped event types are accepted but flagged to staff (nothing silently slips)', async () => {
  const res = await postBooking(booking('mystery-event', 'mystery@example.test', 'Mystery Guest'));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().lane, 'unmapped');
  const note = await app.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'booking_unmapped_event' AND staff_id = $1`,
    [rene.id]
  );
  assert.equal(note.rows[0].n, 1);
});

test('non-Zoom discovery bookings raise the Zoom-only flag (MP rule lives in Cal.com config)', async () => {
  const res = await postBooking(
    booking('new-client-discovery', 'walkin@example.test', 'Walk In', {
      videoCallData: undefined,
      location: 'inPerson',
    })
  );
  assert.equal(res.statusCode, 200, res.body);
  const note = await app.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'booking_not_zoom' AND staff_id = $1`,
    [rene.id]
  );
  assert.equal(note.rows[0].n, 1);
});

test('webhook secret enforced', async () => {
  const res = await postBooking(booking('new-client-discovery', 'nope@example.test', 'No Pe'), 'wrong-secret');
  assert.equal(res.statusCode, 401);
});
