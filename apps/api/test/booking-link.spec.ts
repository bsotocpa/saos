// Prefilled booking links (portal checklist step 4).
//
// This value is rendered straight into an href on the portal home page, from a
// setting Brian types by hand. So the tests care as much about what a MALFORMED
// setting does as about the happy path: the checklist endpoint must not throw, and
// a non-http scheme must never reach the href.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact } from './helpers.ts';
import { prefillBookingUrl } from '../src/modules/forms/booking-link.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };

before(async () => {
  config = await createTestConfig('booklink');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
});

after(async () => {
  await app.close();
});

test('prefill carries name and email, and preserves parameters already on the setting', () => {
  const out = prefillBookingUrl('https://book.sotoaccounting.com/brian/onboarding-consultation', {
    name: 'Synthetic Client',
    email: 'synthetic@example.test',
  });
  const url = new URL(out);
  assert.equal(url.origin + url.pathname, 'https://book.sotoaccounting.com/brian/onboarding-consultation');
  assert.equal(url.searchParams.get('name'), 'Synthetic Client');
  assert.equal(url.searchParams.get('email'), 'synthetic@example.test');

  const kept = new URL(
    prefillBookingUrl('https://book.sotoaccounting.com/brian/x?month=2026-09', {
      name: 'A B',
      email: 'a@example.test',
    })
  );
  assert.equal(kept.searchParams.get('month'), '2026-09', 'existing parameters survive');
  assert.equal(kept.searchParams.get('name'), 'A B');
});

test('the session wins over a name already hardcoded in the setting', () => {
  const url = new URL(
    prefillBookingUrl('https://book.sotoaccounting.com/brian/x?name=Somebody%20Else', {
      name: 'Synthetic Client',
      email: 'synthetic@example.test',
    })
  );
  assert.equal(url.searchParams.get('name'), 'Synthetic Client');
  assert.equal(url.searchParams.getAll('name').length, 1, 'replaced, not appended twice');
});

test('a client with no name or no email still gets a usable link', () => {
  const noName = new URL(prefillBookingUrl('https://book.sotoaccounting.com/brian/x', { name: null, email: 'a@example.test' }));
  assert.equal(noName.searchParams.has('name'), false, 'no empty name parameter');
  assert.equal(noName.searchParams.get('email'), 'a@example.test');

  const neither = prefillBookingUrl('https://book.sotoaccounting.com/brian/x', { name: null, email: null });
  assert.equal(neither, 'https://book.sotoaccounting.com/brian/x');

  const blank = prefillBookingUrl('https://book.sotoaccounting.com/brian/x', { name: '   ', email: '  ' });
  assert.equal(blank, 'https://book.sotoaccounting.com/brian/x', 'whitespace is not a name');
});

test('a malformed or dangerous setting degrades instead of reaching the href', () => {
  // Not parseable — returned unchanged rather than throwing inside the endpoint.
  assert.equal(prefillBookingUrl('not a url', { name: 'A', email: 'a@example.test' }), 'not a url');
  // Non-http schemes must never be decorated and handed to an anchor.
  for (const hostile of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd']) {
    const out = prefillBookingUrl(hostile, { name: 'A', email: 'a@example.test' });
    assert.equal(out, hostile, 'returned untouched');
    assert.ok(!out.includes('email='), 'and never carries client data into a non-http scheme');
  }
});

test('the checklist endpoint returns a prefilled link, and null while scheduling is closed', async () => {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic',
    lastName: 'Booker',
    email: 'booker@example.test',
  });
  const pu = await app.db.query<{ id: string }>(
    `INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`,
    [c.id, c.email]
  );
  const token = randomBytes(32).toString('base64url');
  await app.db.query(
    `INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '1 hour')`,
    [pu.rows[0]!.id, createHash('sha256').update(token).digest('hex')]
  );
  const cookie = { cookie: `saos_portal_session=${token}` };

  // Seeded state: the setting is null, so step 4 must not become a link at all.
  const closed = await app.inject({ method: 'GET', url: '/portal/onboarding', headers: cookie });
  assert.equal(closed.statusCode, 200, closed.body);
  assert.equal((closed.json() as { bookingUrl: string | null }).bookingUrl, null,
    'null setting means scheduling is not open — the portal says so instead of misrouting');

  await app.db.query(
    `UPDATE app_settings SET value = to_jsonb($1::text) WHERE key = 'booking.client_booking_url'`,
    ['https://book.sotoaccounting.com/brian/onboarding-consultation']
  );
  const open = await app.inject({ method: 'GET', url: '/portal/onboarding', headers: cookie });
  assert.equal(open.statusCode, 200, open.body);
  const url = new URL((open.json() as { bookingUrl: string }).bookingUrl);
  assert.equal(url.searchParams.get('name'), 'Synthetic Booker', 'name came from the session, not the browser');
  assert.equal(url.searchParams.get('email'), 'booker@example.test');
});
