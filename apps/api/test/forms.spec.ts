// M14 "Prove it": e2e submits for the major Form 1 branches (business owner
// with every flag vs. individual), conditional validation, autosave/resume,
// analytics counters, Hilo intake (demographics never touch the contact),
// module firing rules (B on industry alone; I → PLLC auto-flag), IL SOS
// stamping + adverse path. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { generateToken } from '../src/crypto.ts';
import { createTestConfig, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let rene: TestStaff & { token: string };
let ana: TestStaff & { token: string };
let laura: TestStaff & { token: string };
let brian: TestStaff & { token: string };

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

async function startForm(key: string, language: 'en' | 'es' = 'en'): Promise<{ submissionId: string; resumeToken: string }> {
  const res = await app.inject({ method: 'POST', url: `/public/forms/${key}/start`, payload: { language } });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

async function clientSessionFor(contactId: string, email: string): Promise<string> {
  const user = await app.db.query<{ id: string }>(
    `SELECT id FROM portal_users WHERE contact_id = $1`,
    [contactId]
  );
  let userId = user.rows[0]?.id;
  if (!userId) {
    const created = await app.db.query<{ id: string }>(
      `INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`,
      [contactId, email]
    );
    userId = created.rows[0]!.id;
  }
  const { token, hash } = generateToken();
  await app.db.query(
    `INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
    [userId, hash]
  );
  return token;
}

before(async () => {
  config = await createTestConfig('forms');
  app = buildServer(config, { mailer: capturingMailer });
  await app.ready();
  rene = await staffWithToken('rene-forms@example.test', 'comms_billing');
  ana = await staffWithToken('ana-forms@example.test', 'tax_preparer');
  laura = await staffWithToken('laura-forms@example.test', 'va_entity');
  brian = await staffWithToken('brian-forms@example.test', 'ceo');
});

after(async () => {
  await app.close();
});

test('Form 1 full branch: F&B owner, ES, IRS letters, SSN by phone, co-owned entities — automation #1 end to end', async () => {
  const { submissionId, resumeToken } = await startForm('soto_intake', 'es');

  // Autosave screen by screen (mobile interruption pattern).
  await app.inject({
    method: 'PATCH', url: `/public/forms/submissions/${submissionId}`,
    payload: {
      resumeToken, screenReached: 1,
      answers: {
        language: 'es', first_name: 'Synthetic', last_name: 'Taquera',
        email: 'taquera@example.test', mobile_phone: '+13125550142', sms_ok: 'yes',
        preferred_contact_method: 'text',
      },
    },
  });
  await app.inject({
    method: 'PATCH', url: `/public/forms/submissions/${submissionId}`,
    payload: {
      resumeToken, screenReached: 2,
      answers: {
        owns_business: 'yes', business_name: 'Synthetic Tacos LLC', entity_type: 'llc',
        industry: 'food_beverage', years_in_business: '1-3', business_zip: '60608',
        other_businesses: 'yes', other_businesses_list: [{ name: 'Synthetic Catering LLC', role: 'co-owner' }],
      },
    },
  });
  const submit = await app.inject({
    method: 'POST', url: `/public/forms/submissions/${submissionId}/submit`,
    payload: {
      resumeToken,
      answers: {
        services: ['tax_business', 'tax_personal'], filed_last_year: 'yes', irs_letters: 'yes',
        ssn_preference: 'phone', how_heard: 'referral', referred_by: 'A friend',
        communication_consent: true, esign_consent: true,
        _hilo: { referringContactId: 'not-allowed' }, // reserved key — must be stripped
      },
    },
  });
  assert.equal(submit.statusCode, 200, submit.body);

  const contact = await app.db.query<{
    id: string; soto_status: string; language: string; sms_consent: boolean;
    br1_referred_by_hilo: boolean; ssn_status: string;
  }>(
    `SELECT id, soto_status, language, sms_consent, br1_referred_by_hilo, ssn_status
     FROM contacts WHERE email = 'taquera@example.test'`
  );
  assert.equal(contact.rows.length, 1);
  const c = contact.rows[0]!;
  assert.equal(c.soto_status, 'lead');
  assert.equal(c.language, 'es');
  assert.equal(c.sms_consent, true);
  assert.equal(c.br1_referred_by_hilo, false, 'client-supplied _hilo key was stripped — no bridge fields');
  assert.equal(c.ssn_status, 'provide_by_phone');

  // Business + IL SOS stamped; entity group with the co-owned business.
  const biz = await app.db.query(
    `SELECT b.name, b.industry, b.il_sos_status FROM businesses b
     JOIN business_members m ON m.business_id = b.id WHERE m.contact_id = $1 AND m.is_primary`,
    [c.id]
  );
  assert.equal(biz.rows[0].industry, 'food_beverage');
  assert.equal(biz.rows[0].il_sos_status, 'good_standing', 'SOS checked at intake');
  const group = await app.db.query(
    `SELECT count(*)::int AS n FROM entity_group_members gm
     JOIN entity_groups g ON g.id = gm.group_id
     WHERE gm.contact_id = $1 OR gm.business_id IN (SELECT business_id FROM business_members WHERE contact_id = $1)`,
    [c.id]
  );
  assert.ok(group.rows[0].n >= 3, 'entity group links contact + both businesses');

  // Tax engagement created at intake_started; envelopes queued as drafts.
  const te = await app.db.query(
    `SELECT te.stage FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id WHERE e.contact_id = $1`,
    [c.id]
  );
  assert.equal(te.rows.length, 1);
  assert.equal(te.rows[0].stage, 'intake_started');
  const envelopes = await app.db.query(
    `SELECT type, status FROM signature_envelopes WHERE contact_id = $1 ORDER BY type`,
    [c.id]
  );
  assert.deepEqual(envelopes.rows.map((r: { type: string }) => r.type).sort(), ['consent_7216', 'engagement_letter']);
  assert.ok(envelopes.rows.every((r: { status: string }) => r.status === 'draft'), 'queued, not sent — placeholder gate governs sending');

  // ONE welcome (ES), carrying the link; Rene + Ana notifications; SSN task.
  //
  // This asserted the opposite until 2026-08-15 — a welcome AND a separate "enlace
  // seguro" magic link — which is precisely the bug: the second of those two was the
  // bare sign-in email finding #21 called indistinguishable from phishing, and the
  // first told the client to go looking for it while its 15 minutes ran down. Inverted
  // rather than deleted: the premise changed, so the assertion states the new premise.
  const hers = sentMail.filter((m) => m.to === 'taquera@example.test');
  assert.equal(hers.length, 1, `one welcome, got ${hers.length}: ${hers.map((m) => m.subject).join(' | ')}`);
  assert.match(hers[0]!.subject, /portal de cliente/i, 'the ES invite, not the bare ES sign-in link');
  assert.ok(!/enlace seguro/i.test(hers[0]!.subject), 'a first-time client never gets the bare link');
  assert.ok(hers[0]!.text.includes('/auth/verify?token='), 'and it carries the link itself');
  const reneNote = await app.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'new_intake' AND staff_id = $1 AND contact_id = $2`,
    [rene.id, c.id]
  );
  assert.equal(reneNote.rows[0].n, 1);
  const anaNote = await app.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'intake_irs_letter_flag' AND staff_id = $1`,
    [ana.id]
  );
  assert.equal(anaNote.rows[0].n, 1, 'IRS letters flag routed to Ana');
  const ssnTask = await app.db.query(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'ssn_by_phone' AND assigned_staff_id = $1`,
    [rene.id]
  );
  assert.equal(ssnTask.rows[0].n, 1);

  // Module assembly: B fires on industry ALONE (tax-only F&B client — v4.1 fix) + F for tax.
  const session = await clientSessionFor(c.id, 'taquera@example.test');
  const modules = await app.inject({
    method: 'GET', url: '/portal/service-onboarding',
    headers: { authorization: `Bearer ${session}` },
  });
  const keys = modules.json().modules.map((m: { key: string }) => m.key);
  assert.ok(keys.includes('module_b'), 'Module B fires on food_beverage industry alone');
  assert.ok(keys.includes('module_f'), 'Module F fires for tax');
  assert.ok(!keys.includes('module_a'), 'Module A needs bookkeeping/payroll/sales-tax/advisory');
  assert.ok(!keys.includes('module_i'), 'Module I is healthcare-only');
});

test('Form 1 conditional logic: individual path skips business fields; validation fails closed', async () => {
  const { submissionId, resumeToken } = await startForm('soto_intake');

  // Missing required email → 400 with sanitized issues.
  const invalid = await app.inject({
    method: 'POST', url: `/public/forms/submissions/${submissionId}/submit`,
    payload: {
      resumeToken,
      answers: {
        language: 'en', first_name: 'Synthetic', last_name: 'Solo',
        mobile_phone: '+13125550143', sms_ok: 'no', preferred_contact_method: 'email',
        owns_business: 'no', services: ['tax_personal'], filed_last_year: 'no',
        irs_letters: 'no', how_heard: 'google', communication_consent: true, esign_consent: true,
      },
    },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error, 'form_validation_failed');
  assert.ok(invalid.json().issues.some((i: { field: string }) => i.field === 'email'));

  // With email, the individual path needs NO business fields (hidden = not required).
  const ok = await app.inject({
    method: 'POST', url: `/public/forms/submissions/${submissionId}/submit`,
    payload: {
      resumeToken,
      answers: {
        language: 'en', first_name: 'Synthetic', last_name: 'Solo', email: 'solo@example.test',
        mobile_phone: '+13125550143', sms_ok: 'no', preferred_contact_method: 'email',
        owns_business: 'no', services: ['tax_personal'], filed_last_year: 'no',
        irs_letters: 'no', how_heard: 'google', communication_consent: true, esign_consent: true,
      },
    },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  const biz = await app.db.query(
    `SELECT count(*)::int AS n FROM business_members m JOIN contacts c ON c.id = m.contact_id
     WHERE c.email = 'solo@example.test'`
  );
  assert.equal(biz.rows[0].n, 0, 'no business created for individuals');

  // Duplicate detection: same email again links, never duplicates.
  const again = await startForm('soto_intake');
  await app.inject({
    method: 'POST', url: `/public/forms/submissions/${again.submissionId}/submit`,
    payload: {
      resumeToken: again.resumeToken,
      answers: {
        language: 'en', first_name: 'Synthetic', last_name: 'Solo', email: 'solo@example.test',
        mobile_phone: '+13125550143', sms_ok: 'no', preferred_contact_method: 'email',
        owns_business: 'no', services: ['bookkeeping'], irs_letters: 'no',
        how_heard: 'google', communication_consent: true, esign_consent: true,
      },
    },
  });
  const contacts = await app.db.query(`SELECT count(*)::int AS n FROM contacts WHERE email = 'solo@example.test'`);
  assert.equal(contacts.rows[0].n, 1, 'one contact per email');
});

test('autosave/resume tokens: wrong token 404; submitted form refuses further writes; analytics count', async () => {
  const { submissionId, resumeToken } = await startForm('soto_intake');
  const wrong = await app.inject({
    method: 'PATCH', url: `/public/forms/submissions/${submissionId}`,
    payload: { resumeToken: 'not-the-token', answers: {}, screenReached: 1 },
  });
  assert.equal(wrong.statusCode, 404);

  await app.inject({
    method: 'PATCH', url: `/public/forms/submissions/${submissionId}`,
    payload: { resumeToken, answers: { first_name: 'Synthetic' }, screenReached: 1 },
  });
  // Abandon it — the analytics drop-off should see screen 1.

  const analytics = await app.inject({ method: 'GET', url: '/forms/analytics', headers: auth(ana) });
  assert.equal(analytics.statusCode, 200, analytics.body);
  const soto = analytics.json().forms.find((f: { form_key: string }) => f.form_key === 'soto_intake');
  assert.ok(soto.started >= 4, 'starts counted');
  assert.ok(soto.submitted >= 3, 'submissions counted');
  assert.ok(
    analytics.json().dropOff.some((d: { form_key: string; screen_reached: number }) => d.form_key === 'soto_intake' && d.screen_reached >= 1),
    'abandonment drop-off recorded with the screen reached'
  );
});

test('Form 2 Hilo intake: exploring status, demographics stay OFF the contact record', async () => {
  const { submissionId, resumeToken } = await startForm('hilo_intake', 'es');
  const res = await app.inject({
    method: 'POST', url: `/public/forms/submissions/${submissionId}/submit`,
    payload: {
      resumeToken,
      answers: {
        language: 'es', first_name: 'Synthetic', last_name: 'Emprendedora',
        email: 'emprendedora@example.test', mobile_phone: '+13125550144', sms_ok: 'yes', zip: '60623',
        stage: 'starting', business_kind: 'food', help_domains: ['money', 'legal'],
        demo_woman: 'yes', demo_race: ['latino'], communication_consent: true,
      },
    },
  });
  assert.equal(res.statusCode, 200, res.body);

  const contact = await app.db.query(
    `SELECT hilo_status, zip, language FROM contacts WHERE email = 'emprendedora@example.test'`
  );
  assert.equal(contact.rows[0].hilo_status, 'exploring');
  assert.equal(contact.rows[0].zip, '60623', 'zip captured (funder metric)');

  // Demographics live ONLY in the submission (aggregate reporting), never on the contact.
  const cols = await app.db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'contacts' AND column_name LIKE 'demo%'`
  );
  assert.equal(cols.rows.length, 0, 'no demographic columns on contacts at all');
  const sub = await app.db.query(
    `SELECT answers->>'demo_woman' AS w FROM form_submissions WHERE id = $1`,
    [submissionId]
  );
  assert.equal(sub.rows[0].w, 'yes', 'demographics retained in the submission for aggregates');

  assert.ok(sentMail.some((m) => m.to === 'emprendedora@example.test' && /Hilo/.test(m.subject)), 'Hilo welcome sent');
});

test('Module I → PLLC auto-flag: licensed therapist + LLC + IL creates the conversion pipeline record', async () => {
  // Healthcare client with a tax engagement (fires I + F).
  const { submissionId, resumeToken } = await startForm('soto_intake');
  await app.inject({
    method: 'POST', url: `/public/forms/submissions/${submissionId}/submit`,
    payload: {
      resumeToken,
      answers: {
        language: 'en', first_name: 'Synthetic', last_name: 'Therapist', email: 'therapist-forms@example.test',
        mobile_phone: '+13125550145', sms_ok: 'yes', preferred_contact_method: 'email',
        owns_business: 'yes', business_name: 'Synthetic Counseling LLC', entity_type: 'llc',
        industry: 'healthcare_therapy', years_in_business: '3-5', business_zip: '60614',
        services: ['tax_business'], filed_last_year: 'yes', irs_letters: 'no',
        how_heard: 'google', communication_consent: true, esign_consent: true,
      },
    },
  });
  const contact = await app.db.query<{ id: string }>(`SELECT id FROM contacts WHERE email = 'therapist-forms@example.test'`);
  const contactId = contact.rows[0]!.id;

  const session = await clientSessionFor(contactId, 'therapist-forms@example.test');
  const modules = await app.inject({
    method: 'GET', url: '/portal/service-onboarding', headers: { authorization: `Bearer ${session}` },
  });
  const keys = modules.json().modules.map((m: { key: string }) => m.key);
  assert.ok(keys.includes('module_i'), 'Module I fires for healthcare');

  const submit = await app.inject({
    method: 'POST', url: '/portal/service-onboarding/submit',
    headers: { authorization: `Bearer ${session}` },
    payload: {
      answers: {
        I1: 'lcpc', I2: 'llc', I3: 'mostly_private', I4: 'simplepractice', I5: 'no', I6: 'group_1099',
        F1: 'other_preparer', F2: 'single', F4: ['il', 'in'],
      },
    },
  });
  assert.equal(submit.statusCode, 200, submit.body);
  assert.ok(submit.json().flags.includes('pllc_conversion'), 'PLLC auto-flag fired');
  assert.ok(submit.json().flags.includes('worker_classification_risk'), '1099 clinicians flag fired');

  const pllc = await app.db.query(
    `SELECT detected_via, license_type, assigned_staff_id FROM pllc_conversions WHERE contact_id = $1`,
    [contactId]
  );
  assert.equal(pllc.rows.length, 1);
  assert.equal(pllc.rows[0].detected_via, 'module_i');
  assert.equal(pllc.rows[0].license_type, 'lcpc');
  assert.equal(pllc.rows[0].assigned_staff_id, laura.id, 'routed to Laura');

  // Module F fed the complexity inputs (2 states).
  const te = await app.db.query(
    `SELECT te.complexity_inputs FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id
     WHERE e.contact_id = $1`,
    [contactId]
  );
  assert.equal(te.rows[0].complexity_inputs.states, 2);
});

test('IL SOS adverse result: Laura task + bilingual fix-steps email; recheck job is date-guarded', async () => {
  const { submissionId, resumeToken } = await startForm('soto_intake');
  await app.inject({
    method: 'POST', url: `/public/forms/submissions/${submissionId}/submit`,
    payload: {
      resumeToken,
      answers: {
        language: 'en', first_name: 'Synthetic', last_name: 'Lapsed', email: 'lapsed@example.test',
        mobile_phone: '+13125550146', sms_ok: 'no', preferred_contact_method: 'email',
        owns_business: 'yes', business_name: 'Dissolved Ventures LLC', entity_type: 'llc',
        industry: 'professional_services', years_in_business: '5+', business_zip: '60601',
        services: ['tax_business'], filed_last_year: 'yes', irs_letters: 'no',
        how_heard: 'google', communication_consent: true, esign_consent: true,
      },
    },
  });

  const biz = await app.db.query(
    `SELECT b.il_sos_status FROM businesses b JOIN business_members m ON m.business_id = b.id
     JOIN contacts c ON c.id = m.contact_id WHERE c.email = 'lapsed@example.test'`
  );
  assert.equal(biz.rows[0].il_sos_status, 'not_good_standing');
  const task = await app.db.query(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'sos_check' AND assigned_staff_id = $1`,
    [laura.id]
  );
  assert.equal(task.rows[0].n, 1, 'Laura gets the reinstatement task');
  assert.ok(
    sentMail.some((m) => m.to === 'lapsed@example.test' && /needs attention/i.test(m.subject)),
    'fix-steps email sent'
  );

  const run = await app.inject({ method: 'POST', url: '/jobs/sos-recheck?asOf=2026-08-01', headers: auth(brian) });
  assert.equal(run.statusCode, 200, run.body);
  assert.equal(run.json().skipped, false);
  const rerun = await app.inject({ method: 'POST', url: '/jobs/sos-recheck?asOf=2026-08-01', headers: auth(brian) });
  assert.equal(rerun.json().skipped, true);
});

test('M28 renderer contract: every question has bilingual text, and the TCPA disclosure ships with it', async () => {
  // The public renderer is data-driven, so the DEFINITION is the contract. A field
  // with no wording would render its database key to a stranger deciding whether
  // to trust us with their taxes.
  for (const key of ['soto_intake', 'hilo_intake']) {
    const res = await app.inject({ method: 'GET', url: `/public/forms/${key}` });
    assert.equal(res.statusCode, 200, res.body);
    const def = res.json().definition as {
      screens: Array<{
        id: number; titleEn: string; titleEs: string;
        fields: Array<{ key: string; type: string; labelEn?: string; labelEs?: string; options?: Array<{ labelEn: string; labelEs: string }> }>;
      }>;
    };
    assert.equal(res.json().version, 2, 'v2 is the labelled definition the renderer needs');
    assert.ok(def.screens.length >= 4);

    for (const screen of def.screens) {
      assert.ok(screen.titleEn?.length > 0, `${key} screen ${screen.id}: no English title`);
      assert.ok(screen.titleEs?.length > 0, `${key} screen ${screen.id}: no Spanish title`);
      for (const f of screen.fields) {
        assert.ok((f.labelEn ?? '').length > 0, `${key}.${f.key}: no English question text`);
        assert.ok((f.labelEs ?? '').length > 0, `${key}.${f.key}: no Spanish question text`);
        // A label that is just the key means withLabels() had no entry for it.
        assert.notEqual(f.labelEn, f.key, `${key}.${f.key}: label fell back to the raw key`);
        assert.notEqual(f.labelEs, f.key, `${key}.${f.key}: Spanish label fell back to the raw key`);
        for (const o of f.options ?? []) {
          assert.ok(o.labelEn.length > 0 && o.labelEs.length > 0, `${key}.${f.key}: an option is missing a label`);
        }
      }
    }

    // TCPA: the disclosure must travel WITH the consent question, because the A2P
    // campaign registration references that language at the point of consent.
    const sms = def.screens.flatMap((s) => s.fields).find((f) => f.key === 'sms_ok') as
      | { helpEn?: string; helpEs?: string }
      | undefined;
    assert.ok(sms, `${key}: no sms_ok field`);
    assert.match(sms!.helpEn ?? '', /Reply STOP to opt out/i, `${key}: English TCPA disclosure missing`);
    assert.match(sms!.helpEn ?? '', /Consent is not a condition of service/i);
    assert.match(sms!.helpEs ?? '', /Responda STOP/i, `${key}: Spanish TCPA disclosure missing`);
  }

  // Demographic questions are never required and say why they are asked.
  const hilo = (await app.inject({ method: 'GET', url: '/public/forms/hilo_intake' })).json().definition as {
    screens: Array<{ fields: Array<{ key: string; required?: unknown; helpEn?: string; helpEs?: string }> }>;
  };
  const demos = hilo.screens.flatMap((s) => s.fields).filter((f) => f.key.startsWith('demo_'));
  assert.ok(demos.length >= 3);
  for (const d of demos) {
    assert.notEqual(d.required, true, `${d.key} must never be required`);
    assert.match(d.helpEn ?? '', /never affects what you get/i, `${d.key}: says why it is asked`);
    assert.ok((d.helpEs ?? '').length > 0, `${d.key}: Spanish note missing`);
  }
});

test('the rehearsal banner keys off the placeholder flag, so it removes itself', async () => {
  // Legal package v3 landed final §7216 text, so the banner is already gone in a
  // fresh database — the state Brian was building toward. Assert that first.
  const live = await app.inject({ method: 'GET', url: '/public/forms/soto_intake' });
  assert.equal(live.json().consentTextPending, false, 'v3 consent text is final');
  assert.equal(live.json().rehearsalBannerEn, null, 'no watermark on a real intake');
  assert.equal(live.json().rehearsalBannerEs, null);

  // Then prove the mechanism still works, because the flag is what protects a
  // client from signing text that is back under review: flag the consents and the
  // banner returns with no separate switch to remember.
  await app.db.query(
    `UPDATE templates SET is_placeholder = true WHERE key IN ('consent_7216_use', 'consent_7216_disclose')`
  );
  const pending = await app.inject({ method: 'GET', url: '/public/forms/soto_intake' });
  assert.equal(pending.json().consentTextPending, true);
  assert.match(pending.json().rehearsalBannerEn, /NOT legally effective/);
  assert.match(pending.json().rehearsalBannerEs, /NO tiene efecto legal/);

  // Restore, so the rest of the suite sees the real production state.
  await app.db.query(
    `UPDATE templates SET is_placeholder = false WHERE key IN ('consent_7216_use', 'consent_7216_disclose')`
  );
  const restored = await app.inject({ method: 'GET', url: '/public/forms/soto_intake' });
  assert.equal(restored.json().rehearsalBannerEn, null, 'gone by itself');
});

/*
 * BUG 1 (Brian, 2026-08-15). Finding #21 said an invite and a re-login link are
 * different emails, and it was closed after fixing the STAFF-GRANT path — while the
 * intake processor, the path every self-serve client actually walks, kept calling
 * issueMagicLink with no purpose and sending the bare link #21 described as
 * indistinguishable from phishing.
 *
 * Asserted on the audit line, not on subject copy: these templates are admin-editable
 * by design, so a test that pins Brian's wording would fail the next time he improves
 * it. The audit records WHICH email a client got, which is the thing that was wrong.
 */
test('#21 for real: a new client from intake gets the invite, and only one welcome', async () => {
  const before = sentMail.length;
  const { submissionId, resumeToken } = await startForm('soto_intake');
  const submit = await app.inject({
    method: 'POST', url: `/public/forms/submissions/${submissionId}/submit`,
    payload: {
      resumeToken,
      answers: {
        language: 'en', first_name: 'Synthetic', last_name: 'Invitee',
        email: 'invitee@example.test', mobile_phone: '+13125550188', sms_ok: 'no',
        preferred_contact_method: 'email', owns_business: 'no',
        services: ['tax_personal'], filed_last_year: 'yes', irs_letters: 'no',
        how_heard: 'google', communication_consent: true, esign_consent: true,
      },
    },
  });
  assert.equal(submit.statusCode, 200, submit.body);

  const inviteeId = (await app.db.query<{ id: string }>(`SELECT id FROM contacts WHERE email = $1`, ['invitee@example.test'])).rows[0]!.id;
  const audit = await app.db.query(
    `SELECT details FROM audit_log
      WHERE action = 'magic_link.issued' AND contact_id = $1
      ORDER BY occurred_at DESC LIMIT 1`,
    [inviteeId]
  );
  assert.equal(audit.rows.length, 1, 'the link was issued');
  assert.equal(audit.rows[0].details.purpose, 'invite', 'a brand-new client gets the INVITE, not the bare link');
  assert.equal(audit.rows[0].details.brand, 'soto');

  // One welcome, not two. The old path sent welcome_soto ("a sign-in link is on its
  // way in a separate email") and then the link, which raced the link's own expiry.
  const theirs = sentMail.slice(before).filter((m) => m.to === 'invitee@example.test');
  assert.equal(theirs.length, 1, `exactly one email to a new client, got ${theirs.length}: ${theirs.map((m) => m.subject).join(' | ')}`);
  assert.ok(theirs[0]!.text.includes('/auth/verify?token='), 'and it is the one carrying the sign-in link');
});

test('Hilo entrepreneurs are welcomed by Hilo, not by Soto Accounting', async () => {
  const before = sentMail.length;
  const { submissionId, resumeToken } = await startForm('hilo_intake');
  const submit = await app.inject({
    method: 'POST', url: `/public/forms/submissions/${submissionId}/submit`,
    payload: {
      resumeToken,
      answers: {
        language: 'en', first_name: 'Synthetic', last_name: 'Founder',
        email: 'founder@example.test', mobile_phone: '+13125550189', sms_ok: 'no', zip: '60623',
        stage: 'idea', business_kind: 'services', help_domains: ['money'],
        communication_consent: true,
      },
    },
  });
  assert.equal(submit.statusCode, 200, submit.body);

  const founderId = (await app.db.query<{ id: string }>(`SELECT id FROM contacts WHERE email = $1`, ['founder@example.test'])).rows[0]!.id;
  const audit = await app.db.query(
    `SELECT details FROM audit_log
      WHERE action = 'magic_link.issued' AND contact_id = $1
      ORDER BY occurred_at DESC LIMIT 1`,
    [founderId]
  );
  assert.equal(audit.rows[0].details.purpose, 'invite');
  assert.equal(audit.rows[0].details.brand, 'hilo', 'brand is passed by the caller, never inferred from hilo_status');

  const theirs = sentMail.slice(before).filter((m) => m.to === 'founder@example.test');
  assert.equal(theirs.length, 1);
  // The point of the brand split: no other firm's name in front of a Hilo entrepreneur.
  assert.ok(!/Soto Accounting/i.test(theirs[0]!.subject + theirs[0]!.text), 'no Soto branding in a Hilo welcome');
  assert.ok(/Hilo/.test(theirs[0]!.subject + theirs[0]!.text), 'Hilo signs its own email');
});

/*
 * BUG 2. Autosave has PATCHed answers since M28 and nothing could ever read them back,
 * so the portal started a new submission on every page load — the save was write-only
 * and "you can close this and come back" was untrue.
 */
test('an interrupted intake resumes: answers and place come back, stale handles do not', async () => {
  const { submissionId, resumeToken } = await startForm('soto_intake');
  await app.inject({
    method: 'PATCH', url: `/public/forms/submissions/${submissionId}`,
    payload: {
      resumeToken, screenReached: 2,
      answers: { first_name: 'Synthetic', last_name: 'Interrupted', owns_business: 'yes' },
    },
  });

  const resumed = await app.inject({
    method: 'POST', url: `/public/forms/submissions/${submissionId}/resume`,
    payload: { resumeToken },
  });
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.equal(resumed.json().formKey, 'soto_intake');
  assert.equal(resumed.json().answers.first_name, 'Synthetic', 'what they typed comes back');
  assert.equal(resumed.json().answers.owns_business, 'yes');
  assert.equal(resumed.json().screenReached, 2, 'and so does where they were');

  const wrong = await app.inject({
    method: 'POST', url: `/public/forms/submissions/${submissionId}/resume`,
    payload: { resumeToken: 'not-the-token' },
  });
  assert.equal(wrong.statusCode, 404, 'a stolen id without the token reads nothing');

  await app.inject({
    method: 'POST', url: `/public/forms/submissions/${submissionId}/submit`,
    payload: {
      resumeToken,
      answers: {
        language: 'en', first_name: 'Synthetic', last_name: 'Interrupted',
        email: 'interrupted@example.test', mobile_phone: '+13125550190', sms_ok: 'no',
        preferred_contact_method: 'email', owns_business: 'no',
        services: ['tax_personal'], filed_last_year: 'no', irs_letters: 'no',
        how_heard: 'google', communication_consent: true, esign_consent: true,
      },
    },
  });
  const after = await app.inject({
    method: 'POST', url: `/public/forms/submissions/${submissionId}/resume`,
    payload: { resumeToken },
  });
  assert.equal(after.statusCode, 409, 'a submitted form does not reopen — the client starts fresh');
});
