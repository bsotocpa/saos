/*
 * DELIVER RETURN SAYS WHAT HAPPENED (Brian, 2026-09-26, R48).
 *
 *   "Deliver Return said 'client notified' but no return-delivered notice is armed. The confirmation
 *    must state what actually happened, including 'the client was not emailed because that notice is
 *    switched off'."
 *
 * The notice is the gated automation `return_delivered`; the delivery (the PDF on the portal, the
 * stage move) is never gated. The answer carries `notice: { emailed, reason }`, and the Ops page
 * prints it. OFF: no mail, the suppression audited, the return still delivered. ON: one email, to the
 * CONTACT email (R45) — never the portal sign-in address. Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { AUTOMATION_KEYS } from '../src/automations.ts';
import { UNGATED_CLIENT_SENDS } from '../src/modules/comms/client-sends.ts';
import { createTestConfig, makeStaff, multipartBody, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { seedAll } from '@saos/db';

let app: FastifyInstance;
let config: Config;
let ana: TestStaff & { token: string };
let brian: TestStaff & { token: string };

const sent: MailMessage[] = [];
const capturingMailer: Mailer = {
  transport: 'console',
  async send(msg) { sent.push(msg); return { id: `captured-${sent.length}` }; },
};
const PDF = Buffer.from('%PDF-1.4 synthetic test return — no real client data\n%%EOF');
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

/** A client at internal review with a portal account on a DIFFERENT address than the contact email. */
async function clientAtReview(tag: string): Promise<{ contactId: string; te: string; contactEmail: string; portalEmail: string }> {
  const contactEmail = `${tag}-contact@example.test`;
  const portalEmail = `${tag}-portal@example.test`;
  const c = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, soto_status) VALUES ('Synthetic', $1, $2, 'active') RETURNING id`, [tag, contactEmail]
  );
  await app.db.query(`INSERT INTO portal_users (contact_id, email) VALUES ($1, $2)`, [c.rows[0]!.id, portalEmail]);
  const eng = await app.inject({
    method: 'POST', url: '/tax-engagements', headers: auth(ana),
    payload: { reason: 'Return opened by hand for the fixture; the client engaged by phone and the quote follows', contactId: c.rows[0]!.id, taxYear: 2025, returnType: '1040' },
  });
  assert.equal(eng.statusCode, 201, eng.body);
  const te = eng.json().id as string;
  await app.db.query(`UPDATE tax_engagements SET stage = 'internal_review', engagement_letter_signed_at = now(), estimate_locked_at = now() WHERE id = $1`, [te]);
  return { contactId: c.rows[0]!.id, te, contactEmail, portalEmail };
}

async function deliver(contactId: string, te: string, filename: string) {
  const up = multipartBody(
    { contactId, category: 'return_deliverable', taxEngagementId: te, taxYear: '2025' },
    { field: 'file', filename, contentType: 'application/pdf', data: PDF }
  );
  const res = await app.inject({ method: 'POST', url: '/documents', headers: { ...auth(ana), ...up.headers }, payload: up.payload });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { stageMoved: boolean; notice: { emailed: boolean; reason: string } };
}

before(async () => {
  config = await createTestConfig('returnnotice');
  app = buildServer(config, { mailer: capturingMailer });
  await app.ready();
  ana = await staffWithToken('ana-notice@example.test', 'tax_preparer');
  brian = await staffWithToken('brian-notice@example.test', 'ceo');
});
after(async () => { await app.close(); });

test('the return-delivered notice is a registered automation, seeded OFF, and no longer an ungated send', async () => {
  assert.ok((AUTOMATION_KEYS as readonly string[]).includes('return_delivered'));
  assert.ok(!Object.keys(UNGATED_CLIENT_SENDS).some((k) => /afterReturnDelivered/.test(k)), 'afterReturnDelivered left the ungated registry');
  const row = await app.db.query<{ enabled: boolean }>(`SELECT enabled FROM automations WHERE key = 'return_delivered'`);
  assert.equal(row.rows.length, 1, 'an admin row exists (the seed registers it)');
  // createTestConfig arms every automation for the suite; the seed itself ships it off (seedAutomations inserts enabled = false).
});

test('OFF: the return is on the portal and the stage moves, no email leaves, the answer says why, the suppression is audited', async () => {
  await app.db.query(`UPDATE automations SET enabled = false WHERE key = 'return_delivered'`);
  const c = await clientAtReview('notice-off');
  sent.length = 0;
  const res = await deliver(c.contactId, c.te, 'return-off.pdf');
  assert.equal(res.stageMoved, true, 'the delivery is never gated');
  assert.deepEqual(res.notice, { emailed: false, reason: 'automation_off' });
  assert.equal(sent.filter((m) => /example\.test$/.test(m.to)).length, 0, 'nothing reached the client');
  const stage = await app.db.query<{ stage: string }>(`SELECT stage::text AS stage FROM tax_engagements WHERE id = $1`, [c.te]);
  assert.equal(stage.rows[0]!.stage, 'client_review');
  const onPortal = await app.db.query(`SELECT 1 FROM documents WHERE tax_engagement_id = $1 AND category = 'return_deliverable'`, [c.te]);
  assert.equal(onPortal.rows.length, 1, 'the PDF is in My Returns');
  const held = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'document.return_delivered_notice_suppressed' AND object_id = $1`, [c.te]);
  assert.equal(held.rows.length, 1, 'the suppression is recorded where the send would have been');
});

test('ON: one email, to the CONTACT email and never the portal sign-in address; the answer says so', async () => {
  await app.db.query(`UPDATE automations SET enabled = true WHERE key = 'return_delivered'`);
  const c = await clientAtReview('notice-on');
  sent.length = 0;
  const res = await deliver(c.contactId, c.te, 'return-on.pdf');
  assert.equal(res.stageMoved, true);
  assert.deepEqual(res.notice, { emailed: true, reason: 'sent' });
  const toContact = sent.filter((m) => m.to === c.contactEmail);
  assert.equal(toContact.length, 1, 'one notice, to the contact email');
  assert.match(toContact[0]!.subject, /ready to review/i);
  assert.equal(sent.filter((m) => m.to === c.portalEmail).length, 0, 'the sign-in address is not where client mail goes (R45)');
});

test('a client with no email address: delivered, not emailed, the reason says so', async () => {
  const c = await clientAtReview('notice-noemail');
  await app.db.query(`UPDATE contacts SET email = NULL WHERE id = $1`, [c.contactId]);
  sent.length = 0;
  const res = await deliver(c.contactId, c.te, 'return-noemail.pdf');
  assert.deepEqual(res.notice, { emailed: false, reason: 'no_email' });
  assert.equal(sent.length, 0);
});

/*
 * ARMED IN ADMIN → AUTOMATIONS (Brian, 2026-09-26, R48: "Arm the automation"). The toggle Brian presses
 * is PATCH /admin/automations/return_delivered; this proves that toggle, and nothing else, drives the
 * gate: OFF through the door → not emailed and audited; ON through the door → one email; each flip
 * audited under automation.enabled / automation.disabled.
 */
test('the Admin → Automations toggle drives the gate: PATCH off suppresses, PATCH on sends', async () => {
  const flip = async (enabled: boolean) => {
    const res = await app.inject({ method: 'PATCH', url: '/admin/automations/return_delivered', headers: auth(brian), payload: { enabled } });
    assert.equal(res.statusCode, 200, res.body);
  };
  const listed = await app.inject({ method: 'GET', url: '/admin/automations', headers: auth(brian) });
  assert.equal(listed.statusCode, 200, listed.body);
  const row = (listed.json().automations as Array<{ key: string; name: string; enabled: boolean }>).find((a) => a.key === 'return_delivered');
  assert.ok(row, 'the Admin → Automations page lists return_delivered');
  assert.equal(row!.name, 'Return-delivered notice ("Your return is ready to review")');

  await flip(false);
  const off = await clientAtReview('notice-toggle-off');
  sent.length = 0;
  assert.deepEqual((await deliver(off.contactId, off.te, 'toggle-off.pdf')).notice, { emailed: false, reason: 'automation_off' });
  assert.equal(sent.filter((m) => /example\.test$/.test(m.to)).length, 0, 'nothing reached the client while off');

  await flip(true);
  const on = await clientAtReview('notice-toggle-on');
  sent.length = 0;
  assert.deepEqual((await deliver(on.contactId, on.te, 'toggle-on.pdf')).notice, { emailed: true, reason: 'sent' });
  assert.equal(sent.filter((m) => m.to === on.contactEmail).length, 1, 'one notice once armed');

  const audits = await app.db.query<{ action: string }>(
    `SELECT action FROM audit_log WHERE object_type = 'automation' AND object_id = 'return_delivered' ORDER BY occurred_at`);
  assert.deepEqual(audits.rows.map((r) => r.action).slice(-2), ['automation.disabled', 'automation.enabled']);
});

/*
 * THE RULED SENTENCE REACHES A ROW THE SEED NEVER OVERWRITES (R48). seedTemplates is insert-if-missing,
 * so a deploy leaves an existing row alone; the ruled correction rewrites the OLD sentence to the ruled
 * one on a row still carrying it, and leaves a row an admin already edited untouched.
 */
test('R48 template: the seed lands the ruled last sentence on an existing row and never clobbers an admin edit', async () => {
  const OLD_EN = 'We’ll follow up on the e-file authorization next.';
  const NEW_EN = 'We’ll be in touch about signing next.';
  const OLD_ES = 'Luego le enviaremos la autorización de presentación electrónica.';
  const NEW_ES = 'Luego le escribiremos sobre la firma.';
  const read = async () => (await app.db.query<{ body_en: string; body_es: string; version: number }>(
    `SELECT body_en, body_es, version FROM templates WHERE key = 'return_delivered'`)).rows[0]!;

  // Freshly seeded: the ruled sentence is the seed's own text.
  let t = await read();
  assert.ok(t.body_en.endsWith(`${NEW_EN}\n\n— Soto Accounting`), t.body_en);
  assert.ok(t.body_es.endsWith(`${NEW_ES}\n\n— Soto Accounting`), t.body_es);
  assert.ok(!t.body_en.includes(OLD_EN) && !t.body_es.includes(OLD_ES));

  // The box's row still says the old sentence (seeded before the ruling): the seed corrects it, once, audited.
  await app.db.query(`UPDATE templates SET body_en = replace(body_en, $1, $2), body_es = replace(body_es, $3, $4) WHERE key = 'return_delivered'`, [NEW_EN, OLD_EN, NEW_ES, OLD_ES]);
  const before = await read();
  assert.ok(before.body_en.includes(OLD_EN));
  const results = (await seedAll(app.db)) as string[];
  assert.ok(results.some((r) => /return_delivered: corrected/.test(r)), results.join(' | '));
  t = await read();
  assert.ok(t.body_en.includes(NEW_EN) && !t.body_en.includes(OLD_EN), t.body_en);
  assert.ok(t.body_es.includes(NEW_ES) && !t.body_es.includes(OLD_ES), t.body_es);
  assert.equal(t.version, before.version + 1, 'one version bump for the correction');
  const audit = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'template.updated' AND actor_label = 'seed: ruled copy correction' AND details->>'key' = 'return_delivered'`);
  assert.equal(audit.rows.length, 1, 'the correction is audited as the ruling');

  // A second run finds nothing to do: idempotent, no version bump.
  const again = (await seedAll(app.db)) as string[];
  assert.ok(again.some((r) => /return_delivered: nothing to correct/.test(r)), again.join(' | '));
  assert.equal((await read()).version, t.version);

  // An admin's own edit (the old sentence gone) is never clobbered.
  await app.db.query(`UPDATE templates SET body_en = 'Hi {{first_name}}, your {{tax_year}} return is in the portal. Brian edited this by hand.' WHERE key = 'return_delivered'`);
  await seedAll(app.db);
  assert.match((await read()).body_en, /Brian edited this by hand/);
});
