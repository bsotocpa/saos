// Launch-gate "Prove it" (2026-07-06): Twilio inbound SMS/voice with real
// signature validation, STOP-keyword consent revocation, the SES/SNS
// bounce-complaint feed with real RSA signature verification, and the
// TCPA consent EVENT written by intake. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { snsHttp, type SnsMessage } from '../src/modules/comms/ses-sns.ts';
import { createTestConfig, makeContact, makeStaff, auditRows } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;

const TWILIO_TOKEN = 'twilio-test-token-synthetic';
const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };

// RSA pair standing in for Amazon's SNS signing certificate.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const CERT_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string;
const CERT_URL = 'https://sns.us-east-2.amazonaws.com/SimpleNotificationService-synthetic.pem';
const fetchedUrls: string[] = [];

/** Sign params exactly the way Twilio does: HMAC-SHA1 over url + sorted key/value concat. */
function twilioSign(path: string, params: Record<string, string>): string {
  let data = `${config.API_PUBLIC_URL}${path}`;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  return createHmac('sha1', TWILIO_TOKEN).update(data, 'utf8').digest('base64');
}

async function postTwilio(path: string, params: Record<string, string>, signature?: string) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': signature ?? twilioSign(path, params),
    },
    payload: new URLSearchParams(params).toString(),
  });
}

function snsCanonical(msg: SnsMessage): string {
  const keys =
    msg.Type === 'Notification'
      ? (['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'] as const)
      : (['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'] as const);
  let out = '';
  for (const key of keys) {
    const value = msg[key];
    if (value === undefined || value === null) continue;
    out += `${key}\n${value}\n`;
  }
  return out;
}

function signedSns(partial: Omit<SnsMessage, 'Signature' | 'SignatureVersion' | 'SigningCertURL'>): SnsMessage {
  const msg = { ...partial, SignatureVersion: '1', SigningCertURL: CERT_URL, Signature: '' } as SnsMessage;
  msg.Signature = createSign('RSA-SHA1').update(snsCanonical(msg), 'utf8').sign(privateKey, 'base64');
  return msg;
}

// Outbound Twilio calls (the MMS ack) are stubbed — no test ever hits the
// network; captured for assertions. data:-URL media fetches pass through.
const twilioSends: string[] = [];
const realFetch = globalThis.fetch;

async function staffWithToken(email: string, role: string) {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

before(async () => {
  const base = await createTestConfig('comms');
  config = {
    ...base,
    TWILIO_ACCOUNT_SID: 'ACsynthetic',
    TWILIO_AUTH_TOKEN: TWILIO_TOKEN,
    TWILIO_PHONE_NUMBER: '+15005550006',
  };
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  await makeStaff(app.db, config, {
    email: 'rene-comms@example.test', name: 'Synthetic Rene', role: 'comms_billing',
    password: 'rene-password-123456',
  });
  snsHttp.fetchText = async (url: string) => {
    fetchedUrls.push(url);
    return CERT_PEM;
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('api.twilio.com')) {
      twilioSends.push(url);
      return new Response(JSON.stringify({ sid: 'SMack-synthetic' }), { status: 201 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
});

test('Twilio SMS: forged signature refused; unconfigured token would 503', async () => {
  const params = { From: '+13125550170', Body: 'hello', MessageSid: 'SMforged1' };
  const bad = await postTwilio('/webhooks/twilio/sms', params, 'not-a-real-signature');
  assert.equal(bad.statusCode, 401);
  const wrongKey = await postTwilio(
    '/webhooks/twilio/sms',
    params,
    createHmac('sha1', 'some-other-token').update('x').digest('base64')
  );
  assert.equal(wrongKey.statusCode, 401);
});

test('Twilio SMS: matched sender lands in their thread; Rene notified; audited without the body', async () => {
  const carla = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Carla', email: 'carla-sms@example.test' });
  await app.db.query(`UPDATE contacts SET phone = '(312) 555-0171', sms_consent = true WHERE id = $1`, [carla.id]);

  const res = await postTwilio('/webhooks/twilio/sms', {
    From: '+13125550171', To: '+15005550006',
    Body: 'Just dropped my W-2 in the portal', MessageSid: 'SMsynthetic1',
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.body, /<Response\/>/);

  const msg = await app.db.query(
    `SELECT m.body, m.direction, m.channel FROM messages m
     JOIN message_threads t ON t.id = m.thread_id WHERE t.contact_id = $1`,
    [carla.id]
  );
  assert.equal(msg.rows.length, 1);
  assert.equal(msg.rows[0].direction, 'inbound');
  assert.equal(msg.rows[0].channel, 'sms');

  const notif = await app.db.query(`SELECT 1 FROM notifications WHERE type = 'sms_received' AND related_object_id = 'SMsynthetic1'`);
  assert.equal(notif.rows.length, 1);

  // The audit row must carry identifiers only — never the message text.
  const audit = await app.db.query(
    `SELECT details FROM audit_log WHERE action = 'sms.received' AND details->>'message_sid' = 'SMsynthetic1'`
  );
  assert.equal(audit.rows.length, 1);
  assert.ok(!JSON.stringify(audit.rows[0].details).includes('W-2'));
});

test('Twilio SMS: STOP revokes consent on our side (rollup + consent event + audit)', async () => {
  const dora = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Dora', email: 'dora-sms@example.test' });
  await app.db.query(`UPDATE contacts SET phone = '+13125550172', sms_consent = true, sms_consent_at = now() WHERE id = $1`, [dora.id]);

  const res = await postTwilio('/webhooks/twilio/sms', {
    From: '+13125550172', To: '+15005550006', Body: ' STOP ', MessageSid: 'SMstop1', OptOutType: 'STOP',
  });
  assert.equal(res.statusCode, 200, res.body);

  const contact = await app.db.query(`SELECT sms_consent FROM contacts WHERE id = $1`, [dora.id]);
  assert.equal(contact.rows[0].sms_consent, false);
  const consent = await app.db.query(
    `SELECT status, policy_version, revoked_at FROM consents WHERE contact_id = $1 AND type = 'sms'`,
    [dora.id]
  );
  assert.equal(consent.rows.length, 1);
  assert.equal(consent.rows[0].status, 'revoked');
  assert.equal(consent.rows[0].policy_version, 'sms-stop-keyword');
  assert.ok(consent.rows[0].revoked_at);
  assert.ok((await auditRows(app.db, 'sms.consent_revoked')) >= 1);

  const notif = await app.db.query(`SELECT 1 FROM notifications WHERE type = 'sms_opt_out' AND related_object_id = 'SMstop1'`);
  assert.equal(notif.rows.length, 1);
});

test('Twilio voice: TwiML greeting comes from the admin-editable template', async () => {
  const res = await postTwilio('/webhooks/twilio/voice', {
    From: '+13125550173', To: '+15005550006', CallSid: 'CAsynthetic1',
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.headers['content-type'] as string, /text\/xml/);
  assert.match(res.body, /<Say>.*Thank you for calling Soto Accounting.*<\/Say>/s);
  assert.match(res.body, /Gracias por llamar/s, 'bilingual script spoken');
  const notif = await app.db.query(`SELECT 1 FROM notifications WHERE type = 'call_received' AND related_object_id = 'CAsynthetic1'`);
  assert.equal(notif.rows.length, 1);
});

test('SNS: signed SES bounce triggers the Rene task; tampered payload refused', async () => {
  const evan = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Evan', email: 'evan-bounce@example.test' });
  await app.db.query(`INSERT INTO portal_users (contact_id, email) VALUES ($1, $2)`, [evan.id, evan.email]);

  const sesBounce = JSON.stringify({
    notificationType: 'Bounce',
    bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'evan-bounce@example.test' }] },
  });
  const msg = signedSns({
    Type: 'Notification', MessageId: 'sns-msg-1', TopicArn: 'arn:aws:sns:us-east-2:000000000000:saos-ses',
    Message: sesBounce, Timestamp: new Date().toISOString(),
  });

  const ok = await app.inject({
    method: 'POST', url: '/webhooks/ses-notifications',
    headers: { 'content-type': 'text/plain' }, payload: JSON.stringify(msg),
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().kind, 'bounce');
  assert.equal(ok.json().matched, 1);

  const task = await app.db.query(
    `SELECT 1 FROM tasks WHERE source_type = 'magic_link_bounce' AND contact_id = $1`, [evan.id]
  );
  assert.equal(task.rows.length, 1, 'bounce feeds the existing Rene verification task flow');
  assert.ok((await auditRows(app.db, 'mail.bounced')) >= 1);

  // Tamper the SES payload after signing → signature no longer matches.
  const tampered = { ...msg, Message: sesBounce.replace('evan-bounce', 'attacker') };
  const bad = await app.inject({
    method: 'POST', url: '/webhooks/ses-notifications',
    headers: { 'content-type': 'text/plain' }, payload: JSON.stringify(tampered),
  });
  assert.equal(bad.statusCode, 401, 'forged SNS messages must be refused');
});

test('SNS: SubscriptionConfirmation auto-confirms via a validated SubscribeURL', async () => {
  const subscribeUrl = 'https://sns.us-east-2.amazonaws.com/?Action=ConfirmSubscription&Token=synthetic';
  const msg = signedSns({
    Type: 'SubscriptionConfirmation', MessageId: 'sns-sub-1',
    TopicArn: 'arn:aws:sns:us-east-2:000000000000:saos-ses',
    Message: 'You have chosen to subscribe...', Timestamp: new Date().toISOString(),
    Token: 'synthetic', SubscribeURL: subscribeUrl,
  });
  const res = await app.inject({
    method: 'POST', url: '/webhooks/ses-notifications',
    headers: { 'content-type': 'text/plain' }, payload: JSON.stringify(msg),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'confirmed');
  assert.ok(fetchedUrls.includes(subscribeUrl), 'the SubscribeURL must actually be visited');
  assert.ok((await auditRows(app.db, 'ses.subscription_confirmed')) >= 1);

  // Non-Amazon SubscribeURL must never be fetched.
  const evil = signedSns({
    Type: 'SubscriptionConfirmation', MessageId: 'sns-sub-2',
    TopicArn: 'arn:aws:sns:us-east-2:000000000000:saos-ses',
    Message: 'x', Timestamp: new Date().toISOString(),
    Token: 't', SubscribeURL: 'https://attacker.example.test/confirm',
  });
  const refused = await app.inject({
    method: 'POST', url: '/webhooks/ses-notifications',
    headers: { 'content-type': 'text/plain' }, payload: JSON.stringify(evil),
  });
  assert.equal(refused.statusCode, 400);
  assert.ok(!fetchedUrls.includes('https://attacker.example.test/confirm'));
});

test('Intake writes the TCPA consent EVENT (type sms, versioned disclosure) — not just the rollup', async () => {
  const start = await app.inject({ method: 'POST', url: '/public/forms/soto_intake/start', payload: { language: 'en' } });
  assert.equal(start.statusCode, 201, start.body);
  const { submissionId, resumeToken } = start.json();

  const submit = await app.inject({
    method: 'POST', url: `/public/forms/submissions/${submissionId}/submit`,
    payload: {
      resumeToken,
      answers: {
        language: 'en', first_name: 'Synthetic', last_name: 'Opter', email: 'opter@example.test',
        mobile_phone: '+13125550174', sms_ok: 'yes', preferred_contact_method: 'text',
        owns_business: 'no', services: ['tax_personal'], filed_last_year: 'no',
        irs_letters: 'no', how_heard: 'google', communication_consent: true, esign_consent: true,
      },
    },
  });
  assert.equal(submit.statusCode, 200, submit.body);

  const consent = await app.db.query(
    `SELECT co.status, co.method, co.policy_version, co.signed_at
     FROM consents co JOIN contacts c ON c.id = co.contact_id
     WHERE c.email = 'opter@example.test' AND co.type = 'sms'`
  );
  assert.equal(consent.rows.length, 1, 'sms consent event recorded');
  assert.equal(consent.rows[0].status, 'signed');
  assert.equal(consent.rows[0].method, 'intake_checkbox');
  assert.match(consent.rows[0].policy_version, /^sms-disclosure-/);
  assert.ok(consent.rows[0].signed_at);

  // The disclosure language ships in the form definition (renderers must show it).
  const def = await app.db.query(
    `SELECT definition FROM form_definitions WHERE key = 'soto_intake' ORDER BY version DESC LIMIT 1`
  );
  const defText = JSON.stringify(def.rows[0]?.definition ?? {});
  assert.ok(defText.includes('Reply STOP to opt out'), 'EN disclosure present in the definition');
  assert.ok(defText.includes('Responda STOP'), 'ES disclosure present in the definition');
});

// ── inbound attachment policy (decided 2026-08-09): accept, never reject ─────

test('MMS: media accepted → scanned → quarantined on the thread; matched sender gets the transactional ack', async () => {
  const mia = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Mms', email: 'mms-client@example.test' });
  await app.db.query(`UPDATE contacts SET phone = '+13125550180', sms_consent = false WHERE id = $1`, [mia.id]);
  // NO sms_consent: the ack is a reply in a consumer-initiated exchange,
  // so it must go out anyway (transactionalReply) — outreach stays gated.
  const pdfB64 = Buffer.from('%PDF-1.4 synthetic w2 document').toString('base64');
  const sendsBefore = twilioSends.length;
  const res = await postTwilio('/webhooks/twilio/sms', {
    From: '+13125550180', Body: 'here is my W2', MessageSid: 'SMmms1',
    NumMedia: '1', MediaUrl0: `data:application/pdf;base64,${pdfB64}`, MediaContentType0: 'application/pdf',
  });
  assert.equal(res.statusCode, 200, res.body);

  const att = await app.db.query<{
    id: string; channel: string; contact_id: string; scan_status: string;
    suggested_category: string | null; status: string; thread_id: string | null;
  }>(`SELECT id, channel, contact_id, scan_status, suggested_category, status, thread_id
      FROM inbound_attachments WHERE origin_ref = 'SMmms1-0'`);
  assert.equal(att.rows.length, 1, 'attachment quarantined');
  assert.equal(att.rows[0]!.channel, 'mms');
  assert.equal(att.rows[0]!.contact_id, mia.id, 'sender matched');
  assert.equal(att.rows[0]!.status, 'quarantined', 'holding area, NOT a document folder');
  assert.equal(att.rows[0]!.scan_status, 'skipped', 'no scanner configured → skipped, never rejected');
  assert.ok(att.rows[0]!.thread_id, 'attached to the client thread');
  assert.equal(att.rows[0]!.suggested_category, 'tax_documents', 'matched sender gets a suggestion');
  // No document row yet — the confirm tap is the only path in.
  const docs = await app.db.query(`SELECT 1 FROM documents WHERE contact_id = $1`, [mia.id]);
  assert.equal(docs.rows.length, 0);
  assert.ok(twilioSends.length > sendsBefore, 'warm ack sent despite missing consent flag (transactional reply)');
});

test('unmatched senders are triage-only; file/reassign/discard round trip with audit; infected hard-blocks', async () => {
  const brian = await staffWithToken('brian-comms@example.test', 'ceo');
  const auth = { authorization: `Bearer ${brian.token}` };

  // Email ingest from an address matching no contact.
  const ingest = await app.inject({
    method: 'POST', url: '/inbound-email/ingest', headers: auth,
    payload: {
      messageId: 'email-msg-1', sender: 'stranger@example.test',
      filename: 'IRS Notice CP2000.pdf', mimeType: 'application/pdf',
      contentBase64: Buffer.from('%PDF-1.4 synthetic notice').toString('base64'),
    },
  });
  assert.equal(ingest.statusCode, 201, ingest.body);
  const attId = ingest.json().id as string;

  const listed = await app.inject({ method: 'GET', url: '/inbound-attachments', headers: auth });
  const row = listed.json().attachments.find((a: { id: string }) => a.id === attId);
  assert.ok(row, 'surfaced in the unified inbox');
  assert.equal(row.suggested_category, null, 'unmatched + sensitive doc type → NO auto-suggestion, triage only');
  assert.equal(row.contact_name, null);

  // Filing without a contact is refused.
  const noContact = await app.inject({
    method: 'POST', url: `/inbound-attachments/${attId}/file`, headers: auth, payload: { category: 'irs_notices' },
  });
  assert.equal(noContact.statusCode, 400, noContact.body);

  // Reassign to a real client → suggestion computed now that it's matched.
  const nadia = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Nadia', email: 'nadia-att@example.test' });
  const reassign = await app.inject({
    method: 'POST', url: `/inbound-attachments/${attId}/reassign`, headers: auth, payload: { contactId: nadia.id },
  });
  assert.equal(reassign.statusCode, 200, reassign.body);
  const after = await app.db.query<{ suggested_category: string }>(
    `SELECT suggested_category FROM inbound_attachments WHERE id = $1`, [attId]
  );
  assert.equal(after.rows[0]!.suggested_category, 'irs_notices');

  // Infected → filing hard-blocked whatever the staffer taps.
  await app.db.query(`UPDATE inbound_attachments SET scan_status = 'infected' WHERE id = $1`, [attId]);
  const blocked = await app.inject({
    method: 'POST', url: `/inbound-attachments/${attId}/file`, headers: auth, payload: { category: 'irs_notices' },
  });
  assert.equal(blocked.statusCode, 409, blocked.body);

  // Clean verdict → the confirm tap files it into the client folder with the
  // origin channel + staffer in the audit trail.
  await app.db.query(`UPDATE inbound_attachments SET scan_status = 'clean' WHERE id = $1`, [attId]);
  const filed = await app.inject({
    method: 'POST', url: `/inbound-attachments/${attId}/file`, headers: auth, payload: { category: 'irs_notices' },
  });
  assert.equal(filed.statusCode, 200, filed.body);
  const doc = await app.db.query<{ category: string }>(
    `SELECT category::text AS category FROM documents WHERE id = $1`, [filed.json().documentId]
  );
  assert.equal(doc.rows[0]!.category, 'irs_notices');
  const audit = await app.db.query<{ details: { origin_channel?: string } }>(
    `SELECT details FROM audit_log WHERE action = 'attachment.filed'`
  );
  assert.ok(
    audit.rows.some((a) => a.details.origin_channel === 'email'),
    'audit notes email origin + confirming staffer'
  );

  // Double-file refused; discard works on a fresh quarantined item.
  const again = await app.inject({
    method: 'POST', url: `/inbound-attachments/${attId}/file`, headers: auth, payload: { category: 'irs_notices' },
  });
  assert.equal(again.statusCode, 409);

  const ingest2 = await app.inject({
    method: 'POST', url: '/inbound-email/ingest', headers: auth,
    payload: {
      messageId: 'email-msg-2', sender: 'stranger2@example.test',
      filename: 'random.jpg', mimeType: 'image/jpeg',
      contentBase64: Buffer.from('synthetic jpeg').toString('base64'),
    },
  });
  const discard = await app.inject({
    method: 'POST', url: `/inbound-attachments/${ingest2.json().id}/discard`, headers: auth,
    payload: { reason: 'spam' },
  });
  assert.equal(discard.statusCode, 200, discard.body);
  const gone = await app.db.query<{ status: string }>(
    `SELECT status FROM inbound_attachments WHERE id = $1`, [ingest2.json().id]
  );
  assert.equal(gone.rows[0]!.status, 'discarded');
});
