// M18 "Prove it": two-lane booking webhook. EVERY BOOKING IS FREE (Brian, 2026-08-14) —
// Lane 1 discovery creates/links the contact and tasks the team, Lane 2 is always free,
// and neither bills anything. The confirmation email is gated and its suppression is
// counted. Also: find-or-create dedupe, unmapped slugs + non-Zoom discovery flagged to
// staff, secret enforced. Synthetic data only.

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

/*
 * THE LANE 1 RULING (Brian, 2026-08-14): "retire the direct-deposit invoice path
 * entirely ... deposits exist ONLY on accepted quotes. Discovery and all bookings are
 * free; first client payment is always the quote deposit. Kill the second path, which
 * also kills the double-charge scenario."
 *
 * This test used to assert the opposite — a $250 invoice, a Stripe session, and a
 * checkout link in the email. It is inverted rather than deleted: the behaviour it
 * described was real and shipped, and the thing worth proving now is that it is gone.
 */
test('lane 1 discovery: contact created, team tasked, and NOTHING is billed', async () => {
  const res = await postBooking(booking('new-client-discovery', 'booked@example.test', 'Nina Booked'));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().lane, 'discovery');
  assert.equal(res.json().charged, false, 'the response says so out loud');

  const contact = await app.db.query<{ id: string; soto_status: string; how_heard: string }>(
    `SELECT id, soto_status, how_heard FROM contacts WHERE email = 'booked@example.test'`
  );
  assert.equal(contact.rows.length, 1);
  assert.equal(contact.rows[0]!.soto_status, 'lead');
  assert.equal(contact.rows[0]!.how_heard, 'booking');
  const contactId = contact.rows[0]!.id;

  // The whole point: no invoice, and therefore no checkout session to pay.
  const invoices = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM invoices WHERE contact_id = $1`, [contactId]);
  assert.equal(invoices.rows[0]!.n, 0, 'a booking takes no money');

  // The booking is still visible to someone — that used to be a side effect of the
  // deposit invoice landing in A/R, so removing the charge could have made bookings
  // silent.
  const task = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'booking_discovery' AND contact_id = $1`,
    [contactId]
  );
  assert.equal(task.rows[0]!.n, 1, 'the discovery call is in someone’s queue');

  // And it is on the record that this booking was free.
  const audit = await app.db.query<{ details: Record<string, unknown> }>(
    `SELECT details FROM audit_log WHERE action = 'booking.discovery_created' AND contact_id = $1`,
    [contactId]
  );
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0]!.details.charged, false);
});

test('the booking confirmation is gated, and OFF suppresses only the email', async () => {
  // Client-acting sends ship disabled (CLAUDE.md). createTestConfig arms everything, so
  // disarm this one explicitly and prove the internal half survives.
  await app.db.query(`UPDATE automations SET enabled = false WHERE key = 'booking_confirmations'`);
  const res = await postBooking(booking('new-client-discovery', 'gated@example.test', 'Gated Guest'));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().confirmationSent, false);

  const contactId = (
    await app.db.query<{ id: string }>(`SELECT id FROM contacts WHERE email = 'gated@example.test'`)
  ).rows[0]!.id;
  assert.ok(!sentMail.some((m) => m.to === 'gated@example.test'), 'no client email while disarmed');
  const task = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'booking_discovery' AND contact_id = $1`,
    [contactId]
  );
  assert.equal(task.rows[0]!.n, 1, 'staff never lose visibility because a channel is off');
  const audit = await app.db.query<{ details: Record<string, unknown> }>(
    `SELECT details FROM audit_log WHERE action = 'booking.discovery_created' AND contact_id = $1`,
    [contactId]
  );
  assert.equal(audit.rows[0]!.details.confirmation_suppressed, true, 'the suppression is counted');

  // Armed: the client hears, and the copy sets the money expectation rather than asking
  // for money.
  await app.db.query(`UPDATE automations SET enabled = true WHERE key = 'booking_confirmations'`);
  await postBooking(booking('new-client-discovery', 'armed@example.test', 'Armed Guest'));
  const mail = sentMail.find((m) => m.to === 'armed@example.test');
  assert.ok(mail, 'confirmation sent once armed');
  assert.match(mail.text, /nothing to pay for this call/i);
  assert.match(mail.text, /deposit comes with that quote/i);
  assert.ok(!/checkout\.stripe\.example/.test(mail.text), 'and no payment link anywhere in it');
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

test('lane 1 variant: the business-discovery slug is also free', async () => {
  const res = await postBooking(booking('business-discovery', 'bizbook@example.test', 'Biz Booker'));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().lane, 'discovery', 'still recognised as discovery, just not billed');
  const invoices = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM invoices i JOIN contacts c ON c.id = i.contact_id
      WHERE c.email = 'bizbook@example.test'`
  );
  assert.equal(invoices.rows[0]!.n, 0, 'it used to charge $300 here');
});

test('the retired deposit items cannot be sold, but a price-locked quote still reads them', async () => {
  const rows = await app.db.query<{ item_code: string; is_active: boolean; needs: boolean; structure: boolean }>(
    `SELECT i.item_code, i.is_active, i.needs_confirmation AS needs,
            i.structure_needs_confirmation AS structure
       FROM price_book_items i JOIN price_book_versions v ON v.id = i.version_id
      WHERE v.effective_to IS NULL AND i.service_line = 'deposit' ORDER BY i.item_code`
  );
  assert.equal(rows.rows.length, 2, 'both rows survive — accepted quotes are locked to them');
  for (const r of rows.rows) {
    assert.equal(r.is_active, false, `${r.item_code} is retired`);
    // Brian's ruling ANSWERED both questions these carried, so they must not still be
    // sitting in his confirmation queue asking something he has decided.
    assert.equal(r.needs, false, `${r.item_code} no longer asks a price question`);
    assert.equal(r.structure, false, `${r.item_code} no longer asks a structure question`);
  }
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
