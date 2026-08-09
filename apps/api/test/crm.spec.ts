// M6 "Prove it": CRM walkthrough (contact → business → entity group →
// enrichment gaps → engagement), §7216 gate tests, health job with Red alert
// and §7216-gated upsell, attest independence check incl. Brian-only
// override. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeStaff, auditRows, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { has7216Consent, require7216Consent, record7216Consent } from '../src/modules/compliance/consent.ts';
import { runHealthRefresh } from '../src/modules/crm/health.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let jackson: TestStaff & { token: string };
let intern: TestStaff & { token: string };

function totpCode(secret: string): string {
  return new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
}

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret,
  });
  const res = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email, password: staff.password, totp: totpCode(secret) },
  });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

before(async () => {
  config = await createTestConfig('crm');
  app = buildServer(config);
  await app.ready();
  brian = await staffWithToken('brian-test@example.test', 'ceo');
  jackson = await staffWithToken('jackson-test@example.test', 'ed_coo');
  intern = await staffWithToken('intern-crm@example.test', 'intern');
});

after(async () => {
  await app.close();
});

test('CRM walkthrough: contact → business → gaps shrink as data lands → entity group', async () => {
  // Intern (no contacts.write) cannot create.
  const refused = await app.inject({
    method: 'POST', url: '/contacts', headers: auth(intern),
    payload: { firstName: 'Synthetic', lastName: 'Refused' },
  });
  assert.equal(refused.statusCode, 403);

  // Create a contact with no email/phone → gaps say so.
  const created = await app.inject({
    method: 'POST', url: '/contacts', headers: auth(brian),
    payload: { firstName: 'Synthetic', lastName: 'Walkthrough', language: 'es', sotoStatus: 'lead' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const contactId = created.json().id as string;

  let detail = await app.inject({ method: 'GET', url: `/contacts/${contactId}`, headers: auth(brian) });
  assert.deepEqual(detail.json().enrichmentGaps, ['email', 'phone']);
  assert.ok((await auditRows(app.db, 'contact.viewed', brian.email)) >= 1, 'PII view must be audited');

  // Add a business missing EIN/entity type/industry → gaps grow.
  const biz = await app.inject({
    method: 'POST', url: `/contacts/${contactId}/businesses`, headers: auth(brian),
    payload: { name: 'Synthetic Tacos LLC', zip: '60608' },
  });
  assert.equal(biz.statusCode, 201, biz.body);
  const businessId = biz.json().id as string;

  detail = await app.inject({ method: 'GET', url: `/contacts/${contactId}`, headers: auth(brian) });
  assert.deepEqual(detail.json().enrichmentGaps, ['ein', 'email', 'entity_type', 'industry', 'phone']);

  // Backfill everything → gaps resolve.
  await app.inject({
    method: 'PATCH', url: `/contacts/${contactId}`, headers: auth(brian),
    payload: { email: 'walkthrough@example.test', phone: '+13125550100' },
  });
  const patched = await app.inject({
    method: 'PATCH', url: `/businesses/${businessId}`, headers: auth(brian),
    payload: { ein: '12-3456789', entityType: 'llc', industry: 'food_beverage' },
  });
  assert.equal(patched.statusCode, 200, patched.body);

  detail = await app.inject({ method: 'GET', url: `/contacts/${contactId}`, headers: auth(brian) });
  assert.deepEqual(detail.json().enrichmentGaps, []);
  const resolved = await app.db.query(
    `SELECT resolved_at FROM enrichment_queue WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [contactId]
  );
  assert.ok(resolved.rows[0].resolved_at, 'queue row must be resolved');

  // Entity group with the contact + business as members.
  const group = await app.inject({
    method: 'POST', url: '/entity-groups', headers: auth(brian),
    payload: { name: 'Synthetic Tacos + Owner' },
  });
  const groupId = group.json().id as string;
  const m1 = await app.inject({
    method: 'POST', url: `/entity-groups/${groupId}/members`, headers: auth(brian),
    payload: { businessId, memberRole: 'entity' },
  });
  assert.equal(m1.statusCode, 201);
  const m2 = await app.inject({
    method: 'POST', url: `/entity-groups/${groupId}/members`, headers: auth(brian),
    payload: { contactId, memberRole: 'owner' },
  });
  assert.equal(m2.statusCode, 201);

  // Exactly one of businessId/contactId — both is a validation error.
  const both = await app.inject({
    method: 'POST', url: `/entity-groups/${groupId}/members`, headers: auth(brian),
    payload: { businessId, contactId },
  });
  assert.equal(both.statusCode, 400);

  const groupDetail = await app.inject({ method: 'GET', url: `/entity-groups/${groupId}`, headers: auth(brian) });
  assert.equal(groupDetail.json().members.length, 2);

  // Search finds the contact by partial name and by email fragment.
  const byName = await app.inject({ method: 'GET', url: '/contacts?search=walkthr', headers: auth(brian) });
  assert.equal(byName.json().contacts.length, 1);
  const byEmail = await app.inject({ method: 'GET', url: '/contacts?search=walkthrough@', headers: auth(brian) });
  assert.equal(byEmail.json().contacts.length, 1);
});

test('§7216 gate: blocked until a signed consent is recorded', async () => {
  const created = await app.inject({
    method: 'POST', url: '/contacts', headers: auth(brian),
    payload: { firstName: 'Synthetic', lastName: 'Consent', email: 'consent@example.test' },
  });
  const contactId = created.json().id as string;

  assert.equal(await has7216Consent(app.db, contactId), false, 'default is not_on_file');
  await assert.rejects(
    require7216Consent(app.db, contactId),
    (err: { code?: string }) => err.code === 'consent_7216_required'
  );

  await record7216Consent(app, { contactId, type: '7216_use', method: 'wet_signature', actorLabel: 'test' });
  assert.equal(await has7216Consent(app.db, contactId), true);
  await require7216Consent(app.db, contactId); // must not throw
  assert.ok((await auditRows(app.db, 'consent.7216_recorded')) >= 1);

  const row = await app.db.query(`SELECT consent_7216_status FROM contacts WHERE id = $1`, [contactId]);
  assert.equal(row.rows[0].consent_7216_status, 'signed');
});

test('health job: red transition alerts the assigned manager; green+tenure upsell is §7216-gated', async () => {
  // RED case: active client, assigned to Jackson, overdue payment, no logins.
  const red = await app.inject({
    method: 'POST', url: '/contacts', headers: auth(brian),
    payload: {
      firstName: 'Synthetic', lastName: 'Redclient', email: 'red@example.test',
      sotoStatus: 'active', assignedManagerId: jackson.id, clientSince: '2026-01-01',
    },
  });
  const redId = red.json().id as string;
  const redEng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status) VALUES ($1, 'tax', 'active') RETURNING id`,
    [redId]
  );
  await app.db.query(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, payment_status, docs_requested_at, docs_received_at)
     VALUES ($1, 2025, '1040', 'overdue', now() - interval '40 days', now() - interval '10 days')`,
    [redEng.rows[0]!.id]
  );

  // GREEN cases: tenured, logins, paid — one WITH consent, one WITHOUT.
  const mkGreen = async (last: string, email: string): Promise<string> => {
    const res = await app.inject({
      method: 'POST', url: '/contacts', headers: auth(brian),
      payload: {
        firstName: 'Synthetic', lastName: last, email,
        sotoStatus: 'active', assignedManagerId: jackson.id, clientSince: '2020-01-01',
      },
    });
    const id = res.json().id as string;
    const eng = await app.db.query<{ id: string }>(
      `INSERT INTO engagements (contact_id, service_line, status) VALUES ($1, 'tax', 'active') RETURNING id`,
      [id]
    );
    await app.db.query(
      `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, payment_status)
       VALUES ($1, 2025, '1040', 'paid')`,
      [eng.rows[0]!.id]
    );
    for (let i = 0; i < 4; i++) {
      await app.db.query(
        `INSERT INTO audit_log (actor_type, action, contact_id) VALUES ('client', 'portal.login', $1)`,
        [id]
      );
    }
    return id;
  };
  const greenConsented = await mkGreen('Greenyes', 'green-yes@example.test');
  const greenUnconsented = await mkGreen('Greenno', 'green-no@example.test');
  await record7216Consent(app, { contactId: greenConsented, type: '7216_use', method: 'wet_signature' });

  const summary = await runHealthRefresh(app);
  assert.ok(summary.scored >= 3);

  const redRow = await app.db.query(`SELECT health_score, health_components FROM contacts WHERE id = $1`, [redId]);
  assert.ok(redRow.rows[0].health_score < 40, `red client score ${redRow.rows[0].health_score} must be < 40`);
  assert.equal(redRow.rows[0].health_components.payment_history, 0);

  const greenRow = await app.db.query(`SELECT health_score FROM contacts WHERE id = $1`, [greenConsented]);
  assert.ok(greenRow.rows[0].health_score >= 70, `green client score ${greenRow.rows[0].health_score} must be >= 70`);

  const redAlert = await app.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'health_red' AND contact_id = $1 AND staff_id = $2`,
    [redId, jackson.id]
  );
  assert.equal(redAlert.rows[0].n, 1, 'red alert must reach the assigned manager');

  const upsellYes = await app.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'upsell_candidate' AND contact_id = $1`,
    [greenConsented]
  );
  assert.equal(upsellYes.rows[0].n, 1, 'consented green+tenure client flags upsell');

  const upsellNo = await app.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'upsell_candidate' AND contact_id = $1`,
    [greenUnconsented]
  );
  assert.equal(upsellNo.rows[0].n, 0, '§7216 gate: no consent → NO upsell flag');

  // Re-run: transition-based alerts do not duplicate.
  await runHealthRefresh(app);
  const redAlert2 = await app.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'health_red' AND contact_id = $1`,
    [redId]
  );
  assert.equal(redAlert2.rows[0].n, 1);
});

test('attest independence: blocked with active bookkeeping; Brian-only documented override', async () => {
  const res = await app.inject({
    method: 'POST', url: '/contacts', headers: auth(brian),
    payload: { firstName: 'Synthetic', lastName: 'Attest', email: 'attest@example.test', sotoStatus: 'active' },
  });
  const contactId = res.json().id as string;
  await app.db.query(
    `INSERT INTO engagements (contact_id, service_line, status, title) VALUES ($1, 'bookkeeping', 'active', 'Monthly books')`,
    [contactId]
  );

  // Blocked without an override.
  const blocked = await app.inject({
    method: 'POST', url: '/engagements', headers: auth(brian),
    payload: { contactId, serviceLine: 'attest', title: 'FY26 review' },
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().error, 'independence_conflict');

  // Jackson (equal access, but not the CPA) cannot override.
  const jacksonTry = await app.inject({
    method: 'POST', url: '/engagements', headers: auth(jackson),
    payload: {
      contactId, serviceLine: 'attest', title: 'FY26 review',
      independenceOverrideNote: 'attempting override as ED/COO',
    },
  });
  assert.equal(jacksonTry.statusCode, 403);
  assert.equal(jacksonTry.json().error, 'independence_override_requires_ceo');

  // Brian's documented override works and is audited.
  const overridden = await app.inject({
    method: 'POST', url: '/engagements', headers: auth(brian),
    payload: {
      contactId, serviceLine: 'attest', title: 'FY26 review',
      independenceOverrideNote: 'Safeguards documented per firm policy; bookkeeping performed by separate staff.',
    },
  });
  assert.equal(overridden.statusCode, 201, overridden.body);
  assert.equal(overridden.json().independenceOverridden, true);
  assert.equal(await auditRows(app.db, 'engagement.independence_override'), 1);

  const row = await app.db.query(
    `SELECT independence_override_by_id, independence_override_note, price_book_version_id
     FROM engagements WHERE id = $1`,
    [overridden.json().id]
  );
  assert.equal(row.rows[0].independence_override_by_id, brian.id);
  assert.ok(row.rows[0].independence_override_note.includes('Safeguards'));
  assert.ok(row.rows[0].price_book_version_id, 'engagement must pin the price book version in force');

  // A clean client needs no override.
  const clean = await app.inject({
    method: 'POST', url: '/contacts', headers: auth(brian),
    payload: { firstName: 'Synthetic', lastName: 'Cleanattest', email: 'clean-attest@example.test' },
  });
  const cleanAttest = await app.inject({
    method: 'POST', url: '/engagements', headers: auth(brian),
    payload: { contactId: clean.json().id, serviceLine: 'attest', title: 'FY26 audit' },
  });
  assert.equal(cleanAttest.statusCode, 201);
  assert.equal(cleanAttest.json().independenceOverridden, false);
});

test('health baseline (2026-08-09): never-engaged = gray; yellow only on signals; active+clean = green', async () => {
  // Migrated, never engaged: no logins, engagements, doc requests, messages.
  const dormant = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, soto_status, source)
     VALUES ('Synthetic', 'Dormant', 'dormant-hb@example.test', 'active', 'zoho') RETURNING id`
  );
  const dormantId = dormant.rows[0]!.id;

  // Engaged + one ACTUAL signal (overdue document request).
  const signal = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, soto_status)
     VALUES ('Synthetic', 'Signal', 'signal-hb@example.test', 'active') RETURNING id`
  );
  const signalId = signal.rows[0]!.id;
  await app.db.query(
    `INSERT INTO document_requests (contact_id, title_en, status, due_date)
     VALUES ($1, 'Overdue docs', 'open', CURRENT_DATE - 5)`,
    [signalId]
  );

  // Engaged + clean: a portal login on record, nothing negative.
  const clean = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, soto_status)
     VALUES ('Synthetic', 'Clean', 'clean-hb@example.test', 'active') RETURNING id`
  );
  const cleanId = clean.rows[0]!.id;
  await app.db.query(
    `INSERT INTO audit_log (actor_type, action, contact_id) VALUES ('client', 'portal.login', $1)`,
    [cleanId]
  );

  await runHealthRefresh(app);

  const bands = await app.db.query<{ id: string; health_band: string }>(
    `SELECT id, health_band FROM contacts WHERE id = ANY($1::uuid[])`,
    [[dormantId, signalId, cleanId]]
  );
  const byId = Object.fromEntries(bands.rows.map((r) => [r.id, r.health_band]));
  assert.equal(byId[dormantId], 'gray', 'migrated-but-never-engaged is NEUTRAL, not a warning');
  assert.equal(byId[signalId], 'yellow', 'yellow is reserved for actual signals (overdue docs)');
  assert.equal(byId[cleanId], 'green', 'active and clean is green even at a middling score');
});
