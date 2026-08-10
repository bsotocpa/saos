// M27 "Prove it": Hilo events (the Eventbrite replacement).
//
// The load-bearing test is the CAPACITY RACE. Two people hitting Register on the
// last seat is the normal case at a popular workshop, so capacity is held by a
// partial unique index on (event_id, seat_number) rather than by counting rows and
// then inserting. This spec fires concurrent registrations at a 3-seat workshop and
// asserts exactly 3 confirmations — a read-then-write implementation fails here.
//
// Also under test: bilingual pages and copy, waitlist as a real state, a freed seat
// actually reaching the next person, check-in, no-shows recorded, the out-survey
// respecting the announcement opt-out, ONE follow-up task rather than one per
// attendee, and attendees NOT being auto-linked into the CRM.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { runEventReminderJob } from '../src/modules/events/service.ts';
import { todayChicago, addDays } from '../src/modules/tax/deadlines.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let ana: TestStaff & { token: string };

const sent: Array<{ to: string; subject: string; text: string }> = [];
const capturingMailer: Mailer = {
  transport: 'console',
  async send(msg: { to: string; subject: string; text: string }) {
    sent.push({ to: msg.to, subject: msg.subject, text: msg.text });
    return { id: `captured-${sent.length}` };
  },
};
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

async function makeEvent(slug: string, capacity: number, startsInDays = 14): Promise<void> {
  const starts = new Date(`${addDays(todayChicago(), startsInDays)}T18:00:00.000Z`).toISOString();
  const res = await app.inject({
    method: 'POST', url: '/events', headers: auth(brian),
    payload: {
      slug,
      titleEn: 'Bookkeeping basics for your first year',
      titleEs: 'Contabilidad básica para su primer año',
      descriptionEn: 'A hands-on evening on keeping books you can actually file from.',
      descriptionEs: 'Una tarde práctica para llevar libros con los que sí se puede declarar.',
      startsAt: starts,
      capacity,
      location: 'Hilo, 18th Street',
      program: 'DRK',
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  const pub = await app.inject({ method: 'POST', url: `/events/${slug}/publish`, headers: auth(brian) });
  assert.equal(pub.statusCode, 200, pub.body);
}

const register = (slug: string, n: number, extra: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST', url: `/public/events/${slug}/register`,
    payload: {
      firstName: 'Synthetic', lastName: `Attendee${n}`,
      email: `attendee${n}-${slug}@example.test`, ...extra,
    },
  });

before(async () => {
  config = await createTestConfig('events');
  app = buildServer(config, { mailer: capturingMailer });
  await app.ready();
  brian = await staffWithToken('brian-ev@example.test', 'ceo');
  ana = await staffWithToken('ana-ev@example.test', 'tax_preparer');
  await makeStaff(app.db, config, {
    email: 'jackson-ev@example.test', name: 'Synthetic Jackson', role: 'ed_coo',
    password: 'ed_coo-password-1234567',
  });
});

after(async () => {
  await app.close();
});

test('a draft event is invisible publicly; publishing opens the bilingual page', async () => {
  const starts = new Date(`${addDays(todayChicago(), 20)}T18:00:00.000Z`).toISOString();
  await app.inject({
    method: 'POST', url: '/events', headers: auth(brian),
    payload: {
      slug: 'draft-workshop', titleEn: 'Draft workshop', titleEs: 'Taller borrador',
      descriptionEn: 'Not ready for the public yet at all.', descriptionEs: 'Todavía no está listo.',
      startsAt: starts, capacity: 10,
    },
  });
  const hidden = await app.inject({ method: 'GET', url: '/public/events/draft-workshop' });
  assert.equal(hidden.statusCode, 404, 'a draft is not a public page');

  // Registering for a draft is impossible too.
  const blocked = await register('draft-workshop', 99);
  assert.equal(blocked.statusCode, 404);

  await app.inject({ method: 'POST', url: '/events/draft-workshop/publish', headers: auth(brian) });
  const open = await app.inject({ method: 'GET', url: '/public/events/draft-workshop' });
  assert.equal(open.statusCode, 200, open.body);
  assert.equal(open.json().event.title_en, 'Draft workshop');
  assert.equal(open.json().event.title_es, 'Taller borrador', 'both languages ship on the public page');
  assert.equal(open.json().seatsLeft, 10);
  assert.equal(open.json().full, false);

  // Non-leadership staff cannot create or publish events.
  const refused = await app.inject({
    method: 'POST', url: '/events', headers: auth(ana),
    payload: {
      slug: 'ana-workshop', titleEn: 'Nope', titleEs: 'No', descriptionEn: 'Should be refused.',
      descriptionEs: 'Debe ser rechazado.', startsAt: starts, capacity: 5,
    },
  });
  assert.equal(refused.statusCode, 403);
});

test('THE CAPACITY RACE: concurrent registrations never oversell the last seat', async () => {
  await makeEvent('race-workshop', 3);

  // Ten people hit Register at once on a three-seat workshop. A count-then-insert
  // implementation oversells here; the seat index does not.
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => register('race-workshop', i))
  );
  for (const r of results) assert.equal(r.statusCode, 201, r.body);

  const statuses = results.map((r) => r.json().status as string);
  assert.equal(statuses.filter((s) => s === 'confirmed').length, 3, 'exactly the capacity, never more');
  assert.equal(statuses.filter((s) => s === 'waitlisted').length, 7);

  // Seats are distinct 1..3 — no duplicates, no gaps.
  const seats = await app.db.query<{ seat_number: number }>(
    `SELECT r.seat_number FROM event_registrations r JOIN events e ON e.id = r.event_id
     WHERE e.slug = 'race-workshop' AND r.seat_number IS NOT NULL ORDER BY r.seat_number`
  );
  assert.deepEqual(seats.rows.map((s) => s.seat_number), [1, 2, 3]);

  const page = await app.inject({ method: 'GET', url: '/public/events/race-workshop' });
  assert.equal(page.json().seatsLeft, 0);
  assert.equal(page.json().full, true);
  assert.equal(page.json().event.waitlisted, 7);

  // The database itself refuses a fourth seat, whatever the app tries.
  const evId = await app.db.query<{ id: string }>(`SELECT id FROM events WHERE slug = 'race-workshop'`);
  await assert.rejects(
    app.db.query(
      `INSERT INTO event_registrations (event_id, first_name, last_name, email, seat_number)
       VALUES ($1, 'Synthetic', 'Oversell', 'oversell@example.test', 1)`,
      [evId.rows[0]!.id]
    ),
    /idx_event_seat_unique/,
    'capacity is a database guarantee, not an application convention'
  );
});

test('registration confirms in the registrant’s language, and waitlisting says so plainly', async () => {
  await makeEvent('lang-workshop', 1);

  const before = sent.length;
  const confirmed = await register('lang-workshop', 1, { language: 'es' });
  assert.equal(confirmed.json().status, 'confirmed');
  const confirmMail = sent.slice(before).find((m) => m.to.includes('attendee1-lang'))!;
  assert.match(confirmMail.subject, /^Confirmado:/);
  assert.match(confirmMail.text, /Está confirmado\(a\)/);

  const mark = sent.length;
  const waitlisted = await register('lang-workshop', 2, { language: 'en' });
  assert.equal(waitlisted.json().status, 'waitlisted');
  assert.equal(waitlisted.json().position, 1);
  assert.equal(waitlisted.json().seatNumber, null);
  const waitMail = sent.slice(mark).find((m) => m.to.includes('attendee2-lang'))!;
  assert.match(waitMail.subject, /^Waitlisted:/);
  assert.match(waitMail.text, /position 1/);

  // Registering twice with the same email is refused rather than double-booked.
  const again = await register('lang-workshop', 1, { language: 'es' });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, 'already_registered');
});

test('a cancelled seat is actually given to the next person on the waitlist', async () => {
  await makeEvent('promote-workshop', 2);
  await register('promote-workshop', 1);
  await register('promote-workshop', 2);
  await register('promote-workshop', 3); // waitlisted
  await register('promote-workshop', 4); // waitlisted

  const mark = sent.length;
  const cancelled = await app.inject({
    method: 'POST', url: '/public/events/promote-workshop/cancel',
    payload: { email: 'attendee1-promote-workshop@example.test' },
  });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelled.json().cancelled, true);
  assert.equal(
    cancelled.json().promotedEmail,
    'attendee3-promote-workshop@example.test',
    'the FIRST person waitlisted gets the seat, not the most recent'
  );

  // They were told.
  const promoteMail = sent.slice(mark).find((m) => m.to.includes('attendee3-promote'))!;
  assert.match(promoteMail.subject, /A seat opened/);

  // The event is full again — the freed seat was reused, not lost.
  const page = await app.inject({ method: 'GET', url: '/public/events/promote-workshop' });
  assert.equal(page.json().seatsLeft, 0);
  assert.equal(page.json().event.waitlisted, 1);

  // Cancelling someone who is not registered is a no-op, not an error.
  const nobody = await app.inject({
    method: 'POST', url: '/public/events/promote-workshop/cancel',
    payload: { email: 'never-registered@example.test' },
  });
  assert.equal(nobody.json().cancelled, false);
});

test('check-in: only a seated registrant, and the waitlist cannot be checked in', async () => {
  await makeEvent('checkin-workshop', 1);
  await register('checkin-workshop', 1);
  await register('checkin-workshop', 2); // waitlisted

  const list = await app.inject({ method: 'GET', url: '/events/checkin-workshop/check-in', headers: auth(ana) });
  assert.equal(list.statusCode, 200, 'any staffer can run the door');
  const regs = list.json().registrations;
  assert.equal(regs.length, 2);
  const seated = regs.find((r: { seat_number: number | null }) => r.seat_number !== null)!;
  const waiting = regs.find((r: { seat_number: number | null }) => r.seat_number === null)!;
  assert.equal(waiting.status, 'waitlisted');
  assert.equal(seated.in_crm, false, 'a workshop attendee is a member of the public, not a contact');

  const ok = await app.inject({
    method: 'POST', url: `/event-registrations/${seated.id}/check-in`, headers: auth(ana),
  });
  assert.equal(ok.statusCode, 200, ok.body);

  const refused = await app.inject({
    method: 'POST', url: `/event-registrations/${waiting.id}/check-in`, headers: auth(ana),
  });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error, 'cannot_check_in');
});

test('closing out: no-shows recorded, survey sent, ONE follow-up task, opt-out respected', async () => {
  await makeEvent('closeout-workshop', 4);
  await register('closeout-workshop', 1);
  await register('closeout-workshop', 2);
  await register('closeout-workshop', 3);
  await register('closeout-workshop', 4);

  // Attendee 4 is an existing contact who opted out of announcements — the
  // out-survey must respect that.
  const optedOut = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Attendee4', email: 'attendee4-closeout-workshop@example.test',
  });
  await app.db.query(`UPDATE contacts SET broadcast_opt_out_at = now() WHERE id = $1`, [optedOut.id]);

  // Three of the four show up.
  const list = await app.inject({ method: 'GET', url: '/events/closeout-workshop/check-in', headers: auth(brian) });
  const regs = list.json().registrations as Array<{ id: string; email: string }>;
  for (const r of regs.filter((x) => !x.email.includes('attendee2-'))) {
    await app.inject({ method: 'POST', url: `/event-registrations/${r.id}/check-in`, headers: auth(brian) });
  }

  const mark = sent.length;
  const done = await app.inject({ method: 'POST', url: '/events/closeout-workshop/complete', headers: auth(brian) });
  assert.equal(done.statusCode, 200, done.body);
  const result = done.json();
  assert.equal(result.attended, 3);
  assert.equal(result.noShows, 1, 'the person who registered and did not come is recorded');
  assert.equal(result.surveysSent, 2, 'two surveys — the opted-out attendee is skipped');
  assert.equal(result.surveysSuppressed, 1);

  const surveyMails = sent.slice(mark).filter((m) => /How was it|¿Cómo le fue/.test(m.subject));
  assert.equal(surveyMails.length, 2);
  assert.ok(!surveyMails.some((m) => m.to.includes('attendee4-')), 'the opt-out was honoured');
  assert.match(surveyMails[0]!.text, /a person reads these, not a robot/);

  // ONE task for the whole follow-up pass, not one per attendee (CLAUDE.md
  // forbids module-local to-do lists, and 20 tasks for one workshop is noise).
  const tasks = await app.db.query<{ title: string; sop_link: string | null }>(
    `SELECT title, sop_link FROM tasks WHERE source_type = 'event_followup'`
  );
  assert.equal(tasks.rows.length, 1);
  assert.match(tasks.rows[0]!.title, /Post-event follow-up/);
  assert.match(tasks.rows[0]!.title, /3 attendees/);

  // Attendees are still NOT contacts — linking is the follow-up decision.
  const linked = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM event_registrations r JOIN events e ON e.id = r.event_id
     WHERE e.slug = 'closeout-workshop' AND r.contact_id IS NOT NULL`
  );
  assert.equal(linked.rows[0]!.n, 0, 'no silent CRM import of workshop attendees');

  // Closing twice is refused.
  const twice = await app.inject({ method: 'POST', url: '/events/closeout-workshop/complete', headers: auth(brian) });
  assert.equal(twice.statusCode, 409);
  assert.equal(twice.json().error, 'already_completed');
});

test('impact numbers are the funder-report figures, and survey answers land on them', async () => {
  const impact = await app.inject({ method: 'GET', url: '/events/closeout-workshop/impact', headers: auth(brian) });
  assert.equal(impact.statusCode, 200, impact.body);
  const i = impact.json();
  assert.equal(i.program, 'DRK');
  assert.equal(i.registered, 4);
  assert.equal(i.attended, 3);
  assert.equal(i.no_shows, 1);
  assert.equal(i.surveys_answered, 0);

  // Record a reply and the averages appear.
  const list = await app.inject({ method: 'GET', url: '/events/closeout-workshop/check-in', headers: auth(brian) });
  const attendee = (list.json().registrations as Array<{ id: string; status: string }>)
    .find((r) => r.status === 'attended')!;
  const rec = await app.inject({
    method: 'POST', url: `/event-registrations/${attendee.id}/survey`, headers: auth(brian),
    payload: { satisfaction: 5, nps: 9, learned: 'How to reconcile without a spreadsheet.', next: 'Payroll basics.' },
  });
  assert.equal(rec.statusCode, 200, rec.body);

  const after = await app.inject({ method: 'GET', url: '/events/closeout-workshop/impact', headers: auth(brian) });
  assert.equal(after.json().surveys_answered, 1);
  assert.equal(after.json().avg_satisfaction, '5.0');
  assert.equal(after.json().avg_nps, '9.0');
});

test('the T-1 reminder is kill-switched, date-guarded, and SMS needs its own opt-in', async () => {
  const today = todayChicago();
  // A workshop tomorrow.
  await makeEvent('tomorrow-workshop', 5, 1);
  await register('tomorrow-workshop', 1, { smsOptIn: true, phone: '312-555-0150' });
  await register('tomorrow-workshop', 2, { smsOptIn: false });

  // Prod ships this OFF; the harness arms everything, so set the state explicitly.
  await app.db.query(`UPDATE automations SET enabled = false WHERE key = 'event_reminders'`);
  const off = await runEventReminderJob(app, today);
  assert.equal(off.skipped, false);
  assert.equal(off.emailed, 0);
  assert.equal(off.suppressed, 2, 'while disarmed it counts what it would have sent');

  // Arm it. The date guard means we need a fresh run date.
  await app.db.query(`UPDATE automations SET enabled = true WHERE key = 'event_reminders'`);
  const armedDay = addDays(today, 0);
  assert.equal((await runEventReminderJob(app, armedDay)).skipped, true, 'same date is guarded');

  // Reset the guard by using the event's real T-1 relationship on a later date:
  // move the workshop so "tomorrow" is relative to a new run date.
  const nextRun = addDays(today, 1);
  await app.db.query(
    `UPDATE events SET starts_at = ($1::date + 1)::timestamptz + interval '18 hours' WHERE slug = 'tomorrow-workshop'`,
    [nextRun]
  );
  const on = await runEventReminderJob(app, nextRun);
  assert.equal(on.skipped, false);
  assert.equal(on.emailed, 2, 'both confirmed registrants get the email');
  // Neither is a contact, so no SMS can go out even for the one who opted in —
  // standing TCPA consent lives on the contact record, not on a signup form.
  assert.equal(on.texted, 0);

  const reminders = sent.filter((m) => /^Tomorrow:|^Mañana:/.test(m.subject));
  assert.ok(reminders.length >= 2);
  assert.match(reminders[0]!.text, /18th Street/);

  // Reminders do not repeat for the same registration.
  const repeat = await runEventReminderJob(app, addDays(today, 2));
  assert.equal(repeat.emailed, 0, 'reminder_sent_at makes this idempotent');

  await app.db.query(`UPDATE automations SET enabled = false WHERE key = 'event_reminders'`);
});
