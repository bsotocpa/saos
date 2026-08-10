// "Prove it": portal SMS opt-in (Brian's addition, 2026-08-09).
//
// The migrated book has 433 active clients and ZERO SMS consent on record, so
// every text nudge is permanently suppressed for existing clients unless consent
// can backfill through the portal. This is that path.
//
// TCPA discipline under test:
//   · consent must be EXPRESS — the endpoint records what the client posted, and
//     no code path grants consent as a side effect of anything else
//   · consent without a phone number is refused (it consents to nothing)
//   · the disclosure version the client saw is recorded, so years later we can
//     say exactly what they agreed to
//   · granting genuinely unblocks the send gate; revoking re-blocks it
//   · revocation does not require texting STOP

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { sendSms } from '../src/modules/comms/send-sms.ts';
import { previewAudience } from '../src/modules/comms/broadcast.ts';

let app: FastifyInstance;
let config: Config;

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };

/** Sign a contact in the way the portal does, returning its session cookie. */
async function portalSession(contactId: string, email: string): Promise<string> {
  const pu = await app.db.query<{ id: string }>(
    `INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`,
    [contactId, email]
  );
  const { randomBytes, createHash } = await import('node:crypto');
  const token = randomBytes(32).toString('base64url');
  await app.db.query(
    `INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '1 hour')`,
    [pu.rows[0]!.id, createHash('sha256').update(token).digest('hex')]
  );
  return token;
}

before(async () => {
  config = await createTestConfig('smsconsent');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
});

after(async () => {
  await app.close();
});

test('a migrated client can grant SMS consent from the portal, and it is recorded properly', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Migrated', email: 'migrated-sms@example.test' });
  await app.db.query(`UPDATE contacts SET soto_status = 'active', source = 'dubsado' WHERE id = $1`, [c.id]);
  const token = await portalSession(c.id, 'migrated-sms@example.test');
  const cookie = { cookie: `saos_portal_session=${token}` };

  // Baseline: the migrated book's actual state — no consent, no phone.
  const before = await app.inject({ method: 'GET', url: '/portal/me', headers: cookie });
  assert.equal(before.statusCode, 200, before.body);
  assert.equal(before.json().contact.sms_consent, false);

  // Consent with no number anywhere is refused: it consents to nothing.
  const noPhone = await app.inject({
    method: 'POST', url: '/portal/sms-consent', headers: cookie, payload: { consent: true },
  });
  assert.equal(noPhone.statusCode, 400, noPhone.body);
  assert.equal(noPhone.json().error, 'phone_required');
  const stillOff = await app.db.query<{ sms_consent: boolean }>(
    `SELECT sms_consent FROM contacts WHERE id = $1`, [c.id]
  );
  assert.equal(stillOff.rows[0]!.sms_consent, false, 'a refused grant does not half-apply');

  // Express affirmative consent, with the number.
  const granted = await app.inject({
    method: 'POST', url: '/portal/sms-consent', headers: cookie,
    payload: { consent: true, phone: '312-555-0143' },
  });
  assert.equal(granted.statusCode, 200, granted.body);
  assert.equal(granted.json().smsConsent, true);

  const row = await app.db.query<{ sms_consent: boolean; sms_consent_at: Date | null; phone: string }>(
    `SELECT sms_consent, sms_consent_at, phone FROM contacts WHERE id = $1`, [c.id]
  );
  assert.equal(row.rows[0]!.sms_consent, true);
  assert.ok(row.rows[0]!.sms_consent_at, 'the moment of consent is stamped');
  assert.equal(row.rows[0]!.phone, '312-555-0143', 'the number they consented for is saved');

  // The consents row carries WHAT they agreed to, by version.
  const consent = await app.db.query<{ status: string; method: string; policy_version: string; signed_at: Date }>(
    `SELECT status, method, policy_version, signed_at FROM consents WHERE contact_id = $1 AND type = 'sms'`,
    [c.id]
  );
  assert.equal(consent.rows.length, 1);
  assert.equal(consent.rows[0]!.status, 'signed', 'the consents enum calls an affirmative consent "signed"');
  assert.equal(consent.rows[0]!.method, 'portal_checkbox');
  assert.equal(consent.rows[0]!.policy_version, 'sms-portal-optin-v1');
  assert.ok(consent.rows[0]!.signed_at);
});

test('granting consent actually unblocks the send gate; revoking re-blocks it', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Gated', email: 'gated-sms@example.test' });
  await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [c.id]);
  const token = await portalSession(c.id, 'gated-sms@example.test');
  const cookie = { cookie: `saos_portal_session=${token}` };

  // Before consent, the TCPA gate refuses — and specifically for CONSENT, not
  // for a missing phone or missing Twilio config.
  await app.db.query(`UPDATE contacts SET phone = '312-555-0199' WHERE id = $1`, [c.id]);
  const blocked = await sendSms(app, {
    contactId: c.id, templateKey: 'ladder_sms_nudge', language: 'en', vars: { first_name: 'Synthetic', item: 'x' },
  });
  assert.equal(blocked.sent, false);
  assert.equal(blocked.reason, 'no_sms_consent');

  const grant = await app.inject({
    method: 'POST', url: '/portal/sms-consent', headers: cookie, payload: { consent: true },
  });
  assert.equal(grant.statusCode, 200, grant.body);

  // After consent the gate is past. Twilio is unconfigured in test, so the
  // refusal moves to CONFIGURATION — which is exactly the proof that consent is
  // no longer the blocker.
  const afterConsent = await sendSms(app, {
    contactId: c.id, templateKey: 'ladder_sms_nudge', language: 'en', vars: { first_name: 'Synthetic', item: 'x' },
  });
  assert.equal(afterConsent.sent, false);
  assert.equal(afterConsent.reason, 'twilio_not_configured', 'consent is cleared; only the vendor stub remains');

  // Revoking works from the portal — no STOP text required — and re-blocks.
  const revoked = await app.inject({
    method: 'POST', url: '/portal/sms-consent', headers: cookie, payload: { consent: false },
  });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal(revoked.json().smsConsent, false);
  const reblocked = await sendSms(app, {
    contactId: c.id, templateKey: 'ladder_sms_nudge', language: 'en', vars: { first_name: 'Synthetic', item: 'x' },
  });
  assert.equal(reblocked.reason, 'no_sms_consent');

  // Both the grant and the revocation are on the consent record.
  const trail = await app.db.query<{ status: string }>(
    `SELECT status FROM consents WHERE contact_id = $1 AND type = 'sms' ORDER BY created_at`,
    [c.id]
  );
  assert.deepEqual(trail.rows.map((r) => r.status), ['signed', 'revoked']);
});

test('consent moves the broadcast audience: suppressed-for-TCPA becomes textable', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Audience', email: 'audience-sms@example.test' });
  await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [c.id]);
  const token = await portalSession(c.id, 'audience-sms@example.test');
  const cookie = { cookie: `saos_portal_session=${token}` };

  const before = await previewAudience(app, { sotoStatus: 'active' }, 'sms');
  const beforeTextable = before.smsable;

  await app.inject({
    method: 'POST', url: '/portal/sms-consent', headers: cookie,
    payload: { consent: true, phone: '312-555-0177' },
  });

  const after = await previewAudience(app, { sotoStatus: 'active' }, 'sms');
  assert.equal(after.smsable, beforeTextable + 1, 'one more client is reachable by text');
  // And the TCPA suppression bucket shrank by the same one.
  const suppressedBefore = before.suppressed.find((s) => /TCPA/.test(s.reason))?.count ?? 0;
  const suppressedAfter = after.suppressed.find((s) => /TCPA/.test(s.reason))?.count ?? 0;
  assert.equal(suppressedAfter, suppressedBefore - 1);
});

test('consent is never granted as a side effect of a profile update', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Sideeffect', email: 'side-sms@example.test' });
  const token = await portalSession(c.id, 'side-sms@example.test');
  const cookie = { cookie: `saos_portal_session=${token}` };

  // Adding a phone number and choosing "text" as the preferred contact method
  // are NOT consent. This is the classic TCPA trap.
  const patched = await app.inject({
    method: 'PATCH', url: '/portal/me', headers: cookie,
    payload: { phone: '312-555-0123', preferredContactMethod: 'text' },
  });
  assert.equal(patched.statusCode, 200, patched.body);

  const row = await app.db.query<{ sms_consent: boolean; preferred_contact_method: string }>(
    `SELECT sms_consent, preferred_contact_method::text FROM contacts WHERE id = $1`, [c.id]
  );
  assert.equal(row.rows[0]!.preferred_contact_method, 'text', 'the preference was saved');
  assert.equal(row.rows[0]!.sms_consent, false, 'but preferring text is NOT consenting to be texted');
  const consents = await app.db.query(`SELECT 1 FROM consents WHERE contact_id = $1 AND type = 'sms'`, [c.id]);
  assert.equal(consents.rows.length, 0, 'and no consent record was invented');
});
