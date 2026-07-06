// M16 "Prove it": gating tests (no consent → no referral/CTA), the full
// Hilo→Soto transition with the disclosure audit trail, the DB CHECK that
// makes an undisclosed conversion impossible, and the §7216 direction rules.
// Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { generateToken } from '../src/crypto.ts';
import { record7216Consent } from '../src/modules/compliance/consent.ts';
import { createTestConfig, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let jackson: TestStaff & { token: string }; // ed_coo — suggests + approves
let rene: TestStaff & { token: string };    // comms_billing — creates referrals

const sentMail: MailMessage[] = [];
const capturingMailer: Mailer = {
  transport: 'console',
  async send(msg) {
    sentMail.push(msg);
    return { id: `captured-${sentMail.length}` };
  },
};

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

async function makeHiloContact(last: string, email: string, opts: { language?: 'en' | 'es'; status?: string } = {}): Promise<string> {
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, phone, language, hilo_status, hilo_first_contact)
     VALUES ('Synthetic', $1, $2, '+13125550188', $3, $4::hilo_status, '2025-11-01') RETURNING id`,
    [last, email, opts.language ?? 'en', opts.status ?? 'active']
  );
  return rows[0]!.id;
}

async function makeSotoTaxClient(last: string, email: string): Promise<string> {
  const contactId = await makeHiloContact(last, email, { status: 'none' });
  await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [contactId]);
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status) VALUES ($1, 'tax', 'active') RETURNING id`,
    [contactId]
  );
  await app.db.query(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type) VALUES ($1, 2025, '1040')`,
    [eng.rows[0]!.id]
  );
  return contactId;
}

async function clientSession(contactId: string, email: string): Promise<string> {
  const user = await app.db.query<{ id: string }>(
    `INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`,
    [contactId, email]
  );
  const { token, hash } = generateToken();
  await app.db.query(
    `INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
    [user.rows[0]!.id, hash]
  );
  return token;
}

before(async () => {
  config = await createTestConfig('ref');
  app = buildServer(config, { mailer: capturingMailer });
  await app.ready();
  jackson = await staffWithToken('jackson-ref@example.test', 'ed_coo');
  rene = await staffWithToken('rene-ref@example.test', 'comms_billing');
  // Downstream automation targets exist:
  await staffWithToken('brian-ref@example.test', 'ceo');
  await staffWithToken('ana-ref@example.test', 'tax_preparer');
});

after(async () => {
  await app.close();
});

test('soto→hilo is ALWAYS §7216-gated: blocked without consent, flows with it', async () => {
  const client = await makeSotoTaxClient('Refsoto', 'ref-soto@example.test');

  const blocked = await app.inject({
    method: 'POST', url: '/referrals', headers: auth(rene),
    payload: { contactId: client, direction: 'soto_to_hilo' },
  });
  assert.equal(blocked.statusCode, 403, blocked.body);
  assert.equal(blocked.json().error, 'consent_7216_required');

  await record7216Consent(app, { contactId: client, type: '7216_use', method: 'wet_signature' });
  const created = await app.inject({
    method: 'POST', url: '/referrals', headers: auth(rene),
    payload: { contactId: client, direction: 'soto_to_hilo' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const referralId = created.json().id as string;

  // One-tap approve + send the warm Hilo intro.
  const approved = await app.inject({ method: 'POST', url: `/referrals/${referralId}/approve`, headers: auth(jackson) });
  assert.equal(approved.statusCode, 200, approved.body);
  const sent = await app.inject({ method: 'POST', url: `/referrals/${referralId}/send`, headers: auth(jackson) });
  assert.equal(sent.statusCode, 200, sent.body);

  const row = await app.db.query(`SELECT status, sent_at FROM referrals WHERE id = $1`, [referralId]);
  assert.equal(row.rows[0].status, 'sent');
  assert.ok(row.rows[0].sent_at);
  assert.ok(sentMail.some((m) => m.to === 'ref-soto@example.test' && /Hilo/.test(m.subject)));
});

test('hilo→soto: pure Hilo entrepreneurs flow without consent; Soto tax clients need it', async () => {
  const pureHilo = await makeHiloContact('Refpure', 'ref-pure@example.test');
  const ok = await app.inject({
    method: 'POST', url: '/referrals', headers: auth(jackson),
    payload: { contactId: pureHilo, direction: 'hilo_to_soto' },
  });
  assert.equal(ok.statusCode, 201, ok.body);

  const taxClient = await makeSotoTaxClient('Reftax', 'ref-tax@example.test');
  const blocked = await app.inject({
    method: 'POST', url: '/referrals', headers: auth(jackson),
    payload: { contactId: taxClient, direction: 'hilo_to_soto' },
  });
  assert.equal(blocked.statusCode, 403, 'tax data exists → consent required even hilo→soto');
});

test('full transition journey: approve → link → disclosure REQUIRED → converted with full trail', async () => {
  const luz = await makeHiloContact('Refluz', 'ref-luz@example.test', { language: 'es' });
  // A session summary flagged tax need → services pre-check.
  const meeting = await app.db.query<{ id: string }>(
    `INSERT INTO meetings (contact_id, staff_id, type, source, status) VALUES ($1, $2, 'zoom', 'manual', 'ready') RETURNING id`,
    [luz, jackson.id]
  );
  await app.db.query(
    `INSERT INTO meeting_summaries (meeting_id, summary, tax_need) VALUES ($1, 'synthetic session', true)`,
    [meeting.rows[0]!.id]
  );

  const created = await app.inject({
    method: 'POST', url: '/referrals', headers: auth(jackson),
    payload: { contactId: luz, direction: 'hilo_to_soto', source: 'session_summary' },
  });
  const referralId = created.json().id as string;
  await app.inject({ method: 'POST', url: `/referrals/${referralId}/approve`, headers: auth(jackson) });
  const sent = await app.inject({ method: 'POST', url: `/referrals/${referralId}/send`, headers: auth(jackson) });
  assert.equal(sent.statusCode, 200, sent.body);

  // Warm handoff (Spanish) with the transition link.
  const mail = sentMail.find((m) => m.to === 'ref-luz@example.test');
  assert.ok(mail, 'handoff email sent');
  assert.match(mail.subject, /presentación/i);
  const rt = mail.text.match(/rt=([A-Za-z0-9_\-.]+)/)?.[1];
  assert.ok(rt, 'transition token in the email');

  // Prefill: ES disclosure, pre-checked tax, policy version.
  const prefill = await app.inject({ method: 'GET', url: `/public/transition?rt=${rt}` });
  assert.equal(prefill.statusCode, 200, prefill.body);
  const p = prefill.json();
  assert.equal(p.language, 'es');
  assert.match(p.disclosure, /Directora Ejecutiva/);
  assert.deepEqual(p.preCheckedServices, ['tax_personal']);
  assert.equal(p.policyVersion, '2026-07-05.v1');

  // No acknowledgement → refused.
  const refused = await app.inject({
    method: 'POST', url: '/public/transition/submit',
    payload: { rt, services: ['tax_personal'], disclosureAcknowledged: false, communicationConsent: true, esignConsent: true },
  });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.json().error, 'disclosure_ack_required');

  // Acknowledged → converted, full attribution.
  const converted = await app.inject({
    method: 'POST', url: '/public/transition/submit',
    payload: { rt, services: ['tax_personal'], disclosureAcknowledged: true, communicationConsent: true, esignConsent: true },
  });
  assert.equal(converted.statusCode, 200, converted.body);

  const referral = await app.db.query(
    `SELECT status, disclosure_shown_at, disclosure_policy_version, converted_at FROM referrals WHERE id = $1`,
    [referralId]
  );
  assert.equal(referral.rows[0].status, 'converted');
  assert.ok(referral.rows[0].disclosure_shown_at, 'disclosure timestamp logged');
  assert.equal(referral.rows[0].disclosure_policy_version, '2026-07-05.v1');

  const contact = await app.db.query(
    `SELECT soto_status, br1_referred_by_hilo, br2_hilo_status_at_referral, br3_referred_by_jackson, br6_referring_staff
     FROM contacts WHERE id = $1`,
    [luz]
  );
  assert.equal(contact.rows[0].soto_status, 'lead', 'Soto lead created');
  assert.equal(contact.rows[0].br1_referred_by_hilo, true);
  assert.equal(contact.rows[0].br3_referred_by_jackson, true, 'suggested by the ED/COO role');
  assert.match(contact.rows[0].br6_referring_staff, /ed_coo/);

  const te = await app.db.query(
    `SELECT count(*)::int AS n FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id WHERE e.contact_id = $1`,
    [luz]
  );
  assert.equal(te.rows[0].n, 1, 'intake automation ran (tax engagement created)');

  const audit = await app.db.query(
    `SELECT details FROM audit_log WHERE action = 'referral.converted' AND object_id = $1`,
    [referralId]
  );
  assert.equal(audit.rows[0].details.disclosure_policy_version, '2026-07-05.v1', 'disclosure audit trail');

  const brianNote = await app.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'hilo_transition_converted'`
  );
  assert.equal(brianNote.rows[0].n, 1, 'Brian notified');

  // The link is one-shot: replay refused.
  const replay = await app.inject({
    method: 'POST', url: '/public/transition/submit',
    payload: { rt, services: ['tax_personal'], disclosureAcknowledged: true, communicationConsent: true, esignConsent: true },
  });
  assert.equal(replay.statusCode, 409);
});

test('DB CHECK: an undisclosed hilo→soto conversion is impossible even by direct SQL', async () => {
  const contact = await makeHiloContact('Refcheck', 'ref-check@example.test');
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO referrals (contact_id, direction, status, source) VALUES ($1, 'hilo_to_soto', 'approved', 'manual') RETURNING id`,
    [contact]
  );
  await assert.rejects(
    app.db.query(`UPDATE referrals SET status = 'converted' WHERE id = $1`, [rows[0]!.id]),
    /check constraint/i,
    'conversion without a disclosure trail must violate the CHECK'
  );
});

test('portal CTA (automation 15): fires on referral status / tax-need, and is §7216-aware', async () => {
  // Pure Hilo contact with status 'referral' → CTA shows.
  const eager = await makeHiloContact('Refeager', 'ref-eager@example.test', { status: 'referral' });
  const eagerSession = await clientSession(eager, 'ref-eager@example.test');
  const show = await app.inject({
    method: 'GET', url: '/portal/soto-cta', headers: { authorization: `Bearer ${eagerSession}` },
  });
  assert.equal(show.json().show, true);
  assert.equal(show.json().reason, 'hilo_status_referral');

  // Tapping the CTA files a referral into Jackson's queue.
  const requested = await app.inject({
    method: 'POST', url: '/portal/soto-cta/request', headers: { authorization: `Bearer ${eagerSession}` },
  });
  assert.equal(requested.statusCode, 201, requested.body);
  const queue = await app.db.query(
    `SELECT status, source FROM referrals WHERE contact_id = $1`,
    [eager]
  );
  assert.equal(queue.rows[0].status, 'pending_approval');
  assert.equal(queue.rows[0].source, 'portal_cta');

  // A contact WITH Soto tax data and no consent: CTA suppressed.
  const gated = await makeSotoTaxClient('Refgated', 'ref-gated@example.test');
  await app.db.query(`UPDATE contacts SET hilo_status = 'referral' WHERE id = $1`, [gated]);
  const gatedSession = await clientSession(gated, 'ref-gated@example.test');
  const hidden = await app.inject({
    method: 'GET', url: '/portal/soto-cta', headers: { authorization: `Bearer ${gatedSession}` },
  });
  assert.equal(hidden.json().show, false);
  assert.equal(hidden.json().reason, 'consent_7216_required');

  // Consent on file → CTA returns.
  await record7216Consent(app, { contactId: gated, type: '7216_use', method: 'wet_signature' });
  const restored = await app.inject({
    method: 'GET', url: '/portal/soto-cta', headers: { authorization: `Bearer ${gatedSession}` },
  });
  assert.equal(restored.json().show, true);
});
