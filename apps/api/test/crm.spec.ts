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

/**
 * A contact who is genuinely ACTIVE by the #42 ladder: signed Master plus an open
 * engagement. Fixtures used to pass sotoStatus:'active' in the create payload, which the
 * ruling removed — a status is derived from what happened, never asserted.
 */
async function makeActive(contactId: string) {
  await app.db.query(
    `INSERT INTO engagement_packets (contact_id, master_template_key, master_version, schedule_codes, status, signed_at, signature_method)
     VALUES ($1, 'engagement_master', 1, ARRAY[]::text[], 'signed', now(), 'portal_esign')`,
    [contactId]
  );
  const { refreshContactStatus } = await import('../src/modules/crm/lifecycle.ts');
  await refreshContactStatus(app, contactId, 'test_fixture');
}

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
    payload: { firstName: 'Synthetic', lastName: 'Walkthrough', language: 'es' },
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

test('the client directory finds people by BUSINESS name, and carries what a row needs', async () => {
  // A large part of this book bills under a business rather than a person — the
  // migration flagged 35 such clients. Searching only people made them unfindable,
  // which is half of why /clients/[id] sat orphaned with no way in.
  const created = await app.inject({
    method: 'POST', url: '/contacts', headers: auth(brian),
    payload: { firstName: 'Synthetic', lastName: 'Quietowner', email: 'quietowner@example.test' },
  });
  const contactId = created.json().id as string;
  // Creating it under the contact links the membership for us.
  const biz = await app.inject({
    method: 'POST', url: `/contacts/${contactId}/businesses`, headers: auth(brian),
    payload: { name: 'Zebra Fabrication Partners LLC' },
  });
  assert.equal(biz.statusCode, 201, biz.body);

  // The owner's NAME does not contain "zebra" — only the business does.
  const found = await app.inject({ method: 'GET', url: '/contacts?search=zebra', headers: auth(brian) });
  assert.equal(found.statusCode, 200, found.body);
  const rows = found.json().contacts as Array<{
    id: string; business_name: string | null; is_test: boolean; active_engagements: number;
  }>;
  const row = rows.find((r) => r.id === contactId);
  assert.ok(row, 'found by business name');
  assert.equal(row.business_name, 'Zebra Fabrication Partners LLC', 'the row shows which business');
  assert.equal(row.is_test, false, 'so the directory can badge a rehearsal record');
  assert.equal(row.active_engagements, 0);

  // A total independent of the page, so the list can say "showing 25 of 426"
  // instead of leaving you unsure whether the search matched more.
  const paged = await app.inject({ method: 'GET', url: '/contacts?limit=1', headers: auth(brian) });
  const body = paged.json() as { contacts: unknown[]; total: number };
  assert.equal(body.contacts.length, 1);
  assert.ok(body.total > 1, 'total counts matches, not the page');

  // NO SEARCH must work. The search clause references $1 unconditionally now,
  // because binding $1 without referencing it made Postgres reject every
  // unfiltered request ("bind message supplies 1 parameters, but prepared
  // statement requires 0").
  const unfiltered = await app.inject({ method: 'GET', url: '/contacts', headers: auth(brian) });
  assert.equal(unfiltered.statusCode, 200, unfiltered.body);
  const filteredOnly = await app.inject({
    method: 'GET', url: '/contacts?sotoStatus=active', headers: auth(brian),
  });
  assert.equal(filteredOnly.statusCode, 200, 'filtering without searching works too');
});

test('the row shows the business that MATCHED, not an unrelated primary one', async () => {
  // Searching "dishroulette" in production returned a client displaying
  // "BREAK BREAD CHICAGO LLC" — he owns several businesses, the search hit one, and
  // the row showed another. Correct by the old rule and still wrong to read.
  const created = await app.inject({
    method: 'POST', url: '/contacts', headers: auth(brian),
    payload: { firstName: 'Synthetic', lastName: 'Multiowner', email: 'multiowner@example.test' },
  });
  const contactId = created.json().id as string;

  const primary = await app.inject({
    method: 'POST', url: `/contacts/${contactId}/businesses`, headers: auth(brian),
    payload: { name: 'Aardvark Primary Holdings LLC' },
  });
  assert.equal(primary.statusCode, 201, primary.body);
  await app.db.query(
    `UPDATE business_members SET is_primary = true WHERE contact_id = $1 AND business_id = $2`,
    [contactId, primary.json().id]
  );
  const second = await app.inject({
    method: 'POST', url: `/contacts/${contactId}/businesses`, headers: auth(brian),
    payload: { name: 'Umbrella Side Venture LLC' },
  });
  assert.equal(second.statusCode, 201, second.body);
  await app.db.query(
    `UPDATE business_members SET is_primary = false WHERE contact_id = $1 AND business_id = $2`,
    [contactId, second.json().id]
  );

  // Searching the NON-primary business must display that business.
  const matched = await app.inject({ method: 'GET', url: '/contacts?search=umbrella', headers: auth(brian) });
  const row = (matched.json().contacts as Array<{ id: string; business_name: string }>)
    .find((r) => r.id === contactId);
  assert.ok(row, 'found by the side venture');
  assert.equal(
    row.business_name, 'Umbrella Side Venture LLC',
    'shows what matched, not the primary the searcher never typed'
  );

  // With no search, the PRIMARY is still the right thing to show.
  const noSearch = await app.inject({ method: 'GET', url: '/contacts?search=multiowner', headers: auth(brian) });
  const plain = (noSearch.json().contacts as Array<{ id: string; business_name: string }>)
    .find((r) => r.id === contactId);
  assert.equal(plain?.business_name, 'Aardvark Primary Holdings LLC', 'name match → primary business');
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
      assignedManagerId: jackson.id, clientSince: '2026-01-01',
    },
  });
  const redId = red.json().id as string;
  await makeActive(redId);
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
        assignedManagerId: jackson.id, clientSince: '2020-01-01',
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
    // A tenured, paying, logging-in client is an ACTIVE one, and under #42 that means a
    // signed Master — not a status typed into the create payload.
    await makeActive(id);
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
    payload: { firstName: 'Synthetic', lastName: 'Attest', email: 'attest@example.test' },
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
    `INSERT INTO contacts (first_name, last_name, email, source)
     VALUES ('Synthetic', 'Dormant', 'dormant-hb@example.test', 'dubsado') RETURNING id`
  );
  const dormantId = dormant.rows[0]!.id;
  // From the client book, so the ladder puts them at dormant — a real relationship whose
  // history predates SAOS. 'zoho' would make them a prospect, which is a different thing.
  {
    const { refreshContactStatus } = await import('../src/modules/crm/lifecycle.ts');
    await refreshContactStatus(app, dormantId, 'test_fixture');
  }

  // Engaged + one ACTUAL signal (overdue document request).
  const signal = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, soto_status)
     VALUES ('Synthetic', 'Signal', 'signal-hb@example.test', 'active') RETURNING id`
  );
  const signalId = signal.rows[0]!.id;
  await app.db.query(
    `INSERT INTO engagements (contact_id, service_line, status) VALUES ($1, 'tax', 'active')`,
    [signalId]
  );
  await makeActive(signalId);
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
  // 'active' is not a label you can type on (#42) — give this client what an active
  // client has, or the health cohort correctly excludes them.
  await app.db.query(
    `INSERT INTO engagements (contact_id, service_line, status) VALUES ($1, 'tax', 'active')`,
    [cleanId]
  );
  await makeActive(cleanId);
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

/*
 * #32 — PORTAL ACCESS IS FOUR STATES, NOT A BOOLEAN (Brian, 2026-08-16).
 *
 * The client record carried `has_portal_access`, which conflated a client who was
 * invited and never arrived with one who is using the portal. The first is the state
 * that needs a person to follow up, and it was invisible everywhere.
 */
test('portal access reads not_invited → invited → active, and revoked is its own state', async () => {
  const created = await app.inject({
    method: 'POST', url: '/contacts', headers: auth(brian),
    payload: { firstName: 'Synthetic', lastName: 'Portalstate', email: 'portalstate@example.test' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const contactId = created.json().id as string;

  const fresh = await app.inject({ method: 'GET', url: `/contacts/${contactId}`, headers: auth(brian) });
  assert.equal(fresh.statusCode, 200, fresh.body);
  /*
   * "No account" is the ABSENCE of a portal_users row, so this has to survive a
   * subquery that returns nothing at all — a CASE arm inside it would never be reached.
   */
  assert.equal(fresh.json().contact.portal_state, 'not_invited');
  assert.equal(fresh.json().contact.portal_link_sent_at, null, 'nothing sent yet');

  // Grant access the way the client record does.
  const granted = await app.inject({
    method: 'POST', url: '/portal-users', headers: auth(brian),
    payload: { contactId },
  });
  assert.equal(granted.statusCode, 201, granted.body);

  const invited = await app.inject({ method: 'GET', url: `/contacts/${contactId}`, headers: auth(brian) });
  assert.equal(invited.json().contact.portal_state, 'invited', 'asked, not yet arrived — the state worth chasing');
  assert.ok(invited.json().contact.portal_link_sent_at, 'and WHEN we asked, because links expire in minutes');
  assert.equal(invited.json().contact.portal_last_login_at, null);
  assert.ok(invited.json().magicLinkTtlMinutes > 0, 'the screen can say whether that link still works');

  // They arrive.
  await app.db.query(`UPDATE portal_users SET last_login_at = now() WHERE contact_id = $1`, [contactId]);
  const active = await app.inject({ method: 'GET', url: `/contacts/${contactId}`, headers: auth(brian) });
  assert.equal(active.json().contact.portal_state, 'active');
  assert.ok(active.json().contact.portal_last_login_at);

  /*
   * Revoked is a FOURTH state and must never read as merely "not invited" — someone
   * whose access was deliberately taken away should not be re-granted by reflex.
   */
  await app.db.query(`UPDATE portal_users SET is_active = false WHERE contact_id = $1`, [contactId]);
  const revoked = await app.inject({ method: 'GET', url: `/contacts/${contactId}`, headers: auth(brian) });
  assert.equal(revoked.json().contact.portal_state, 'revoked');
  assert.notEqual(revoked.json().contact.portal_state, 'not_invited', 'revoked is not the same as never asked');
});

test('granting portal access needs the permission, and an intern does not have it', async () => {
  const created = await app.inject({
    method: 'POST', url: '/contacts', headers: auth(brian),
    payload: { firstName: 'Synthetic', lastName: 'Notyours', email: 'notyours@example.test' },
  });
  const contactId = created.json().id as string;

  const refused = await app.inject({
    method: 'POST', url: '/portal-users', headers: auth(intern),
    payload: { contactId },
  });
  assert.equal(refused.statusCode, 403, 'the inline button is still permission-gated');

  const still = await app.inject({ method: 'GET', url: `/contacts/${contactId}`, headers: auth(brian) });
  assert.equal(still.json().contact.portal_state, 'not_invited', 'and nothing was created by the attempt');
});

/*
 * #33 — THE CLIENT RECORD AS AN OPERATING SURFACE (Brian, 2026-08-16).
 *
 * Two rulings carry the weight, and both are enforced server-side rather than in the
 * buttons:
 *
 *   STAFF NEVER TAKE A CARD. "Take payment" means sending the client their pay link.
 *   The Stripe session is created under the CLIENT's own portal session, so there is no
 *   staff-side checkout to abuse and card data never comes near us.
 *
 *   THE CALENDAR CROSS-CHECK RUNS OR THE BUTTON DOES NOT SHIP. A client with something
 *   already booked cannot get a second scheduling task through this route.
 */
test('a reminder sends the pay link and moves no money — there is no staff-side checkout', async () => {
  const created = await app.inject({
    method: 'POST', url: '/contacts', headers: auth(brian),
    payload: { firstName: 'Synthetic', lastName: 'Remindme', email: 'remindme@example.test' },
  });
  const contactId = created.json().id as string;

  const inv = await app.db.query<{ id: string }>(
    `INSERT INTO invoices (contact_id, invoice_number, status, total_cents)
     VALUES ($1, 'SA-REMIND-0001', 'sent', 42000) RETURNING id`,
    [contactId]
  );
  const invoiceId = inv.rows[0]!.id;

  const sent = await app.inject({
    method: 'POST', url: `/invoices/${invoiceId}/remind`, headers: auth(brian),
  });
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(sent.json().to, 'remindme@example.test');

  // Nothing about the money changed. The only path that marks an invoice paid is the
  // one Stripe confirms (#24), and a reminder is not it.
  const after = await app.db.query<{ status: string; amount_paid_cents: number }>(
    `SELECT status, amount_paid_cents FROM invoices WHERE id = $1`,
    [invoiceId]
  );
  assert.equal(after.rows[0]!.status, 'sent', 'still unpaid — a reminder is a message, not a payment');
  assert.equal(after.rows[0]!.amount_paid_cents, 0);

  // Who decided is on the record: this send is a person's choice, not an automation.
  const audit = await app.db.query<{ details: { manual?: boolean } }>(
    `SELECT details FROM audit_log WHERE action = 'invoice.reminder_sent' AND object_id = $1`,
    [invoiceId]
  );
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0]!.details.manual, true);

  // A paid invoice has nothing to chase, and saying so is better than sending it.
  await app.db.query(`UPDATE invoices SET status = 'paid', paid_at = now() WHERE id = $1`, [invoiceId]);
  const again = await app.inject({
    method: 'POST', url: `/invoices/${invoiceId}/remind`, headers: auth(brian),
  });
  assert.equal(again.statusCode, 409, 'no chasing a paid invoice');
});

test('the calendar cross-check is in the endpoint: an existing session refuses a second task', async () => {
  const created = await app.inject({
    method: 'POST', url: '/contacts', headers: auth(brian),
    payload: { firstName: 'Synthetic', lastName: 'Alreadybooked', email: 'alreadybooked@example.test' },
  });
  const contactId = created.json().id as string;

  // Nothing booked → a task is warranted, and it is the ONLY circumstance in which
  // one is.
  const first = await app.inject({
    method: 'POST', url: `/contacts/${contactId}/schedule-session`, headers: auth(brian),
    payload: {},
  });
  assert.equal(first.statusCode, 201, first.body);

  const task = await app.db.query<{ source_type: string; sop_link: string | null }>(
    `SELECT source_type, sop_link FROM tasks WHERE id = $1`,
    [first.json().taskId]
  );
  assert.equal(task.rows[0]!.source_type, 'client_session_scheduling');
  assert.ok(task.rows[0]!.sop_link, 'a task-generating feature ships with its SOP hook');

  // Now put something on their calendar.
  await app.db.query(
    `INSERT INTO client_sessions (contact_id, starts_at, status, is_recurring)
     VALUES ($1, now() + interval '7 days', 'scheduled', true)`,
    [contactId]
  );

  /*
   * THE HARD RULE: never create a session-scheduling task without checking for an
   * existing session — attach to that one instead. Enforced here rather than in the UI,
   * so a second surface that forgets to look cannot double-book through this route.
   */
  const refused = await app.inject({
    method: 'POST', url: `/contacts/${contactId}/schedule-session`, headers: auth(brian),
    payload: {},
  });
  assert.equal(refused.statusCode, 409, 'a client with a session on the calendar is not booked again');
  assert.equal(refused.json().error, 'session_already_scheduled');
});

test('a meeting can only be scoped to an OPEN engagement belonging to this client', async () => {
  const mine = await app.inject({
    method: 'POST', url: '/contacts', headers: auth(brian),
    payload: { firstName: 'Synthetic', lastName: 'Scoped', email: 'scoped@example.test' },
  });
  const contactId = mine.json().id as string;
  const other = await app.inject({
    method: 'POST', url: '/contacts', headers: auth(brian),
    payload: { firstName: 'Synthetic', lastName: 'Elsewhere', email: 'elsewhere@example.test' },
  });
  const otherId = other.json().id as string;

  const version = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions ORDER BY version_number DESC LIMIT 1`
  );
  const theirs = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status, price_book_version_id)
     VALUES ($1, 'bookkeeping', 'active', $2) RETURNING id`,
    [otherId, version.rows[0]!.id]
  );
  const closed = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status, price_book_version_id, ended_on)
     VALUES ($1, 'tax', 'completed', $2, CURRENT_DATE) RETURNING id`,
    [contactId, version.rows[0]!.id]
  );

  const wrongClient = await app.inject({
    method: 'POST', url: `/contacts/${contactId}/schedule-session`, headers: auth(brian),
    payload: { engagementId: theirs.rows[0]!.id },
  });
  assert.equal(wrongClient.statusCode, 404, 'a meeting cannot be "for" someone else’s work');

  const finished = await app.inject({
    method: 'POST', url: `/contacts/${contactId}/schedule-session`, headers: auth(brian),
    payload: { engagementId: closed.rows[0]!.id },
  });
  assert.equal(finished.statusCode, 404, 'nor for work that finished');
});

/*
 * #42 — CONTACT LIFECYCLE (Brian, 2026-08-16).
 *
 * RC2 read "lead · from native" while holding a signed Master, an answered §7216, a paid
 * invoice and a live portal session. The old field was hand-set at creation and nothing
 * ever moved it, so it was wrong in the direction of whatever it was first set to.
 *
 * The ladder is EVENT-DRIVEN: nothing here passes a status, it tells the module what
 * happened and the state is recomputed from the record.
 */
test('lifecycle climbs from what happened, and never from a hand-set value', async () => {
  const { deriveLifecycle, refreshContactStatus } = await import('../src/modules/crm/lifecycle.ts');
  const created = await app.inject({
    method: 'POST', url: '/contacts', headers: auth(brian),
    payload: { firstName: 'Synthetic', lastName: 'Lifecycle', email: 'lifecycle@example.test' },
  });
  const contactId = created.json().id as string;

  assert.equal(await deriveLifecycle(app, contactId), 'lead', 'no accepted quote yet');

  const version = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions ORDER BY version_number DESC LIMIT 1`
  );
  await app.db.query(
    `INSERT INTO quotes (contact_id, status, total_cents, price_book_version_id)
     VALUES ($1, 'accepted', 50000, $2)`,
    [contactId, version.rows[0]!.id]
  );
  await refreshContactStatus(app, contactId, 'test');
  assert.equal((await app.db.query(`SELECT contact_status FROM contacts WHERE id = $1`, [contactId])).rows[0].contact_status,
    'onboarding', 'acceptance advances lead → onboarding');

  /*
   * A signed Master ALONE is not active — the ruling is signature AND an open engagement.
   * This is the case RC2 exposed, so it is asserted in both halves.
   */
  await app.db.query(
    `INSERT INTO engagement_packets (contact_id, master_template_key, master_version, schedule_codes, status, signed_at, signature_method)
     VALUES ($1, 'engagement_master', 1, ARRAY[]::text[], 'signed', now(), 'portal_esign')`,
    [contactId]
  );
  await refreshContactStatus(app, contactId, 'test');
  assert.equal(await deriveLifecycle(app, contactId), 'onboarding', 'signature without an engagement is not active');

  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status, price_book_version_id)
     VALUES ($1, 'tax', 'active', $2) RETURNING id`,
    [contactId, version.rows[0]!.id]
  );
  await refreshContactStatus(app, contactId, 'test');
  const nowRow = await app.db.query<{ contact_status: string; soto_status: string }>(
    `SELECT contact_status, soto_status FROM contacts WHERE id = $1`, [contactId]
  );
  assert.equal(nowRow.rows[0]!.contact_status, 'active', 'signature + open engagement = active');
  // The legacy mirror moves with it — one writer, so the two cannot disagree while the
  // hundred-odd readers of soto_status are migrated.
  assert.equal(nowRow.rows[0]!.soto_status, 'active');

  // Work concludes: no open engagements, relationship intact.
  await app.db.query(`UPDATE engagements SET status = 'completed', ended_on = CURRENT_DATE WHERE id = $1`, [eng.rows[0]!.id]);
  await refreshContactStatus(app, contactId, 'test');
  assert.equal((await app.db.query(`SELECT contact_status FROM contacts WHERE id = $1`, [contactId])).rows[0].contact_status,
    'dormant', 'the last engagement closing moves active → dormant');

  // And a new accepted quote takes them back up the same ladder.
  await app.db.query(
    `INSERT INTO engagements (contact_id, service_line, status, price_book_version_id)
     VALUES ($1, 'bookkeeping', 'active', $2)`,
    [contactId, version.rows[0]!.id]
  );
  await refreshContactStatus(app, contactId, 'test');
  assert.equal((await app.db.query(`SELECT contact_status FROM contacts WHERE id = $1`, [contactId])).rows[0].contact_status,
    'active', 'a returning client walks the same ladder');
});

test('archived is the only hand-set state, it needs a reason, and no sweep undoes it', async () => {
  const { archiveContact, refreshContactStatus } = await import('../src/modules/crm/lifecycle.ts');
  const created = await app.inject({
    method: 'POST', url: '/contacts', headers: auth(brian),
    payload: { firstName: 'Synthetic', lastName: 'Archived', email: 'archived-lc@example.test' },
  });
  const contactId = created.json().id as string;

  await archiveContact(app, contactId, 'Closed the business — confirmed by phone.', { id: brian.id, email: brian.email });
  const row = await app.db.query<{ contact_status: string; archived_reason: string }>(
    `SELECT contact_status, archived_reason FROM contacts WHERE id = $1`, [contactId]
  );
  assert.equal(row.rows[0]!.contact_status, 'archived');
  assert.match(row.rows[0]!.archived_reason, /Closed the business/);

  /*
   * Closing someone out is deliberate. A recompute must not quietly reopen them just
   * because the record no longer shows a reason to be archived — that reason lives with
   * the person who made the call.
   */
  await refreshContactStatus(app, contactId, 'sweep');
  assert.equal((await app.db.query(`SELECT contact_status FROM contacts WHERE id = $1`, [contactId])).rows[0].contact_status,
    'archived', 'a sweep never undoes a deliberate archive');

  // And the database refuses an archived contact with no reason, not just this function.
  await assert.rejects(
    app.db.query(`UPDATE contacts SET archived_reason = NULL WHERE id = $1`, [contactId]),
    /contacts_archived_has_reason/
  );
});
