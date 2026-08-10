// "Prove it": the S CORP SESSION FLOOR at configuration time.
//
// CLAUDE.md, non-negotiable: "the engagement configurator must not allow an
// active S corp client below 2 CPA sessions/year."
//
// The report shows existing violations; this gate prevents new ones. So the
// tests here are mostly attempts to GET AROUND the gate:
//   · configure straight to annual sessions
//   · configure legally, then reconfigure down
//   · sneak down via maintenance mode (the likeliest real-world path)
//   · rely on entity_type being unset, and file an 1120-S instead
// Plus the spec's other configurator rule (sessions never more frequent than
// prep) and the price-book discipline (refuse what the book cannot price).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import {
  PREP_ITEM, SESSIONS_PER_YEAR, S_CORP_SESSION_FLOOR, sElectionEvidence,
} from '../src/modules/engagements/configurator.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
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

/** A bookkeeping engagement, ready to configure. */
async function engagementFor(contactId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/engagements', headers: auth(brian),
    payload: { contactId, serviceLine: 'bookkeeping', status: 'active', title: 'Synthetic recurring' },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
}

async function makeSCorpOwner(label: string): Promise<{ id: string }> {
  const owner = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: label, email: `${label.toLowerCase()}-cfg@example.test`,
  });
  await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [owner.id]);
  const biz = await app.db.query<{ id: string }>(
    `INSERT INTO businesses (name, entity_type, state) VALUES ($1, 's_corp', 'IL') RETURNING id`,
    [`Synthetic ${label} Inc`]
  );
  await app.db.query(
    `INSERT INTO business_members (business_id, contact_id, is_primary) VALUES ($1, $2, true)`,
    [biz.rows[0]!.id, owner.id]
  );
  return owner;
}

before(async () => {
  config = await createTestConfig('configurator');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  brian = await staffWithToken('brian-cfg@example.test', 'ceo');
});

after(async () => {
  await app.close();
});

test('cadence maths: the floor is a constant and sessions-per-year derive from the dial', () => {
  assert.equal(S_CORP_SESSION_FLOOR, 2);
  assert.deepEqual(SESSIONS_PER_YEAR, {
    weekly: 52, biweekly: 26, monthly: 12, quarterly: 4, semi_annual: 2, annual: 1,
  });
  // semi_annual sits exactly ON the floor and must be allowed; annual is the
  // only cadence an S corp can never have.
  assert.ok(SESSIONS_PER_YEAR.semi_annual >= S_CORP_SESSION_FLOOR);
  assert.ok(SESSIONS_PER_YEAR.annual < S_CORP_SESSION_FLOOR);
  // Brian's pricing ruling (2026-08-09) priced the weekly dial position, so every
  // cadence now maps to a prep COMPONENT. (Before the ruling weekly was
  // deliberately unpriced and refused; see pricing-rulings.spec.ts.)
  assert.equal(PREP_ITEM.weekly, 'ACCT_PREP_WEEKLY');
  assert.equal(PREP_ITEM.monthly, 'ACCT_PREP_MONTHLY');
});

test('a NON-S-corp client can be configured to annual sessions', async () => {
  const client = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'SoleProp', email: 'soleprop-cfg@example.test' });
  const engId = await engagementFor(client.id);

  const res = await app.inject({
    method: 'POST', url: `/engagements/${engId}/configure`, headers: auth(brian),
    payload: { prepCadence: 'semi_annual', sessionCadence: 'annual', scopeRung: 'full_management' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const cfg = res.json();
  assert.equal(cfg.sessionsPerYear, 1);
  assert.equal(cfg.sCorpFloorApplied, false, 'the floor did not bind — there is no S election');

  // Price derives from the book's components: semi-annual prep × 2 close periods
  // + 1 annual session. Nothing here is a literal — both figures are read back.
  const book = await app.db.query<{ item_code: string; amount_cents: number }>(
    `SELECT i.item_code, i.amount_cents FROM price_book_items i
     JOIN price_book_versions v ON v.id = i.version_id
     WHERE v.effective_to IS NULL AND i.item_code = ANY($1)`,
    [['ACCT_PREP_SEMI_ANNUAL', 'CPA_SESSION']]
  );
  const cents = Object.fromEntries(book.rows.map((r) => [r.item_code, r.amount_cents]));
  const expectedAnnual = cents.ACCT_PREP_SEMI_ANNUAL! * 2 + 1 * cents.CPA_SESSION!;
  assert.equal(cfg.annualCents, expectedAnnual);
  assert.equal(cfg.monthlyEquivalentCents, Math.round(expectedAnnual / 12));
  // One annual session ≠ the semi-annual package, so this is a derived figure.
  assert.equal(cfg.clientFacing.fromPackageItem, false);
});

test('THE GATE: an active S corp cannot be configured below the floor, on any path', async () => {
  const owner = await makeSCorpOwner('Scorpone');
  const engId = await engagementFor(owner.id);

  // Path 1 — straight to annual sessions.
  const direct = await app.inject({
    method: 'POST', url: `/engagements/${engId}/configure`, headers: auth(brian),
    payload: { prepCadence: 'quarterly', sessionCadence: 'annual' },
  });
  assert.equal(direct.statusCode, 409, direct.body);
  assert.equal(direct.json().error, 's_corp_session_floor');
  assert.match(direct.json().message, /2 CPA sessions a year/);
  assert.match(direct.json().message, /S corp entity on file: Synthetic Scorpone Inc/, 'the refusal shows its evidence');

  // Nothing was written — a refused configuration is not a partial one.
  const untouched = await app.db.query<{ sessions_per_year: number | null; prep_cadence: string | null }>(
    `SELECT sessions_per_year, prep_cadence::text FROM engagements WHERE id = $1`, [engId]
  );
  assert.equal(untouched.rows[0]!.sessions_per_year, null);
  assert.equal(untouched.rows[0]!.prep_cadence, null);
  assert.equal(
    (await app.db.query(`SELECT 1 FROM engagement_config_history WHERE engagement_id = $1`, [engId])).rows.length,
    0,
    'no history row for a configuration that never happened'
  );

  // Path 2 — configure legally at the floor, then try to reconfigure down.
  const ok = await app.inject({
    method: 'POST', url: `/engagements/${engId}/configure`, headers: auth(brian),
    payload: { prepCadence: 'quarterly', sessionCadence: 'semi_annual' },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().sessionsPerYear, 2, 'exactly on the floor is allowed');
  assert.equal(ok.json().sCorpFloorApplied, true, 'and it is recorded that the floor bound this config');

  const down = await app.inject({
    method: 'POST', url: `/engagements/${engId}/configure`, headers: auth(brian),
    payload: { prepCadence: 'quarterly', sessionCadence: 'annual' },
  });
  assert.equal(down.statusCode, 409);
  assert.equal(down.json().error, 's_corp_session_floor');

  // The earlier good configuration survived the refused change.
  const still = await app.db.query<{ sessions_per_year: number }>(
    `SELECT sessions_per_year FROM engagements WHERE id = $1`, [engId]
  );
  assert.equal(still.rows[0]!.sessions_per_year, 2);

  // Path 3 — maintenance mode, the likeliest real-world route down.
  const maint = await app.inject({
    method: 'POST', url: `/engagements/${engId}/maintenance-mode`, headers: auth(brian),
    payload: { sessionCadence: 'annual', note: 'Client asked to cut back' },
  });
  assert.equal(maint.statusCode, 409, maint.body);
  assert.equal(maint.json().error, 's_corp_session_floor', 'maintenance mode runs through the gate, not around it');
});

test('maintenance mode works for a client the floor does not bind, and holds prep cadence', async () => {
  const client = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Maint', email: 'maint-cfg@example.test' });
  const engId = await engagementFor(client.id);
  await app.inject({
    method: 'POST', url: `/engagements/${engId}/configure`, headers: auth(brian),
    payload: { prepCadence: 'monthly', sessionCadence: 'monthly', scopeRung: 'full_management' },
  });

  const maint = await app.inject({
    method: 'POST', url: `/engagements/${engId}/maintenance-mode`, headers: auth(brian),
    payload: { sessionCadence: 'quarterly' },
  });
  assert.equal(maint.statusCode, 200, maint.body);
  assert.equal(maint.json().prepCadence, 'monthly', 'prep cadence is HELD — that is the point of maintenance mode');
  assert.equal(maint.json().sessionsPerYear, 4);
  assert.equal(maint.json().maintenanceMode, true);
  assert.equal(maint.json().scopeRung, 'full_management', 'the scope rung carries over');

  // It is a downgrade path, not an upgrade path.
  const up = await app.inject({
    method: 'POST', url: `/engagements/${engId}/maintenance-mode`, headers: auth(brian),
    payload: { sessionCadence: 'weekly' },
  });
  assert.equal(up.statusCode, 400);
  assert.equal(up.json().error, 'not_a_reduction');

  // Every change is in the history, so a later downgrade is answerable.
  const history = await app.db.query<{ session_cadence: string; maintenance_mode: boolean }>(
    `SELECT session_cadence::text, maintenance_mode FROM engagement_config_history
     WHERE engagement_id = $1 ORDER BY created_at`,
    [engId]
  );
  assert.deepEqual(history.rows.map((h) => h.session_cadence), ['monthly', 'quarterly']);
  assert.deepEqual(history.rows.map((h) => h.maintenance_mode), [false, true]);
});

test('the S election is detected from a 1120-S filing too, not just entity_type', async () => {
  const client = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Untyped', email: 'untyped-cfg@example.test' });
  // No business record at all — the entity_type signal is absent.
  let evidence = await sElectionEvidence(app, client.id);
  assert.equal(evidence.hasActiveSElection, false);

  // But they file an 1120-S.
  const taxEng = await app.inject({
    method: 'POST', url: '/engagements', headers: auth(brian),
    payload: { contactId: client.id, serviceLine: 'tax', status: 'active' },
  });
  await app.db.query(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, stage)
     VALUES ($1, 2025, '1120s', 'intake_started')`,
    [taxEng.json().id]
  );

  evidence = await sElectionEvidence(app, client.id);
  assert.equal(evidence.hasActiveSElection, true, 'filing an 1120-S IS an active S election');
  assert.match(evidence.reasons.join(' '), /1120-S engagement/);

  // And the gate binds on that evidence alone.
  const engId = await engagementFor(client.id);
  const refused = await app.inject({
    method: 'POST', url: `/engagements/${engId}/configure`, headers: auth(brian),
    payload: { prepCadence: 'quarterly', sessionCadence: 'annual' },
  });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error, 's_corp_session_floor');
});

test('sessions can never be more frequent than prep, and unpriced cadences are refused', async () => {
  const client = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Dials', email: 'dials-cfg@example.test' });
  const engId = await engagementFor(client.id);

  const tooOften = await app.inject({
    method: 'POST', url: `/engagements/${engId}/configure`, headers: auth(brian),
    payload: { prepCadence: 'quarterly', sessionCadence: 'monthly' },
  });
  assert.equal(tooOften.statusCode, 400, tooOften.body);
  assert.equal(tooOften.json().error, 'session_exceeds_prep');
  assert.match(tooOften.json().message, /cannot be more frequent/);

  // Equal cadences are fine — quarterly books, quarterly sessions.
  const equal = await app.inject({
    method: 'POST', url: `/engagements/${engId}/configure`, headers: auth(brian),
    payload: { prepCadence: 'quarterly', sessionCadence: 'quarterly' },
  });
  assert.equal(equal.statusCode, 200, equal.body);

  // Weekly prep is priced as of Brian's ruling, so this now succeeds.
  const weekly = await app.inject({
    method: 'POST', url: `/engagements/${engId}/configure`, headers: auth(brian),
    payload: { prepCadence: 'weekly', sessionCadence: 'monthly' },
  });
  assert.equal(weekly.statusCode, 200, weekly.body);

  // The refusal for an UNPRICEABLE cadence still stands, though — deactivate the
  // component and the configurator declines rather than estimating. This is the
  // guard that made the weekly gap visible in the first place, so it stays tested.
  await app.db.query(
    `UPDATE price_book_items SET is_active = false
     WHERE item_code = 'ACCT_PREP_QUARTERLY'
       AND version_id = (SELECT id FROM price_book_versions WHERE effective_to IS NULL
                         ORDER BY version_number DESC LIMIT 1)`
  );
  const unpriced = await app.inject({
    method: 'POST', url: `/engagements/${engId}/configure`, headers: auth(brian),
    payload: { prepCadence: 'quarterly', sessionCadence: 'quarterly' },
  });
  assert.equal(unpriced.statusCode, 400, unpriced.body);
  assert.equal(unpriced.json().error, 'cadence_not_priced');
  assert.match(unpriced.json().message, /Admin → Pricing/);
  assert.match(unpriced.json().message, /will not estimate/);
  await app.db.query(`UPDATE price_book_items SET is_active = true WHERE item_code = 'ACCT_PREP_QUARTERLY'`);
});

test('tax engagements have no cadence dials', async () => {
  const client = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'TaxOnly', email: 'taxonly-cfg@example.test' });
  const taxEng = await app.inject({
    method: 'POST', url: '/engagements', headers: auth(brian),
    payload: { contactId: client.id, serviceLine: 'tax', status: 'active' },
  });
  const res = await app.inject({
    method: 'POST', url: `/engagements/${taxEng.json().id}/configure`, headers: auth(brian),
    payload: { prepCadence: 'monthly', sessionCadence: 'monthly' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'not_recurring');
});

test('the options endpoint tells the UI what the floor forbids, before anyone picks it', async () => {
  const owner = await makeSCorpOwner('Scorptwo');
  const res = await app.inject({
    method: 'GET', url: `/contacts/${owner.id}/configurator-options`, headers: auth(brian),
  });
  assert.equal(res.statusCode, 200, res.body);
  const o = res.json();
  assert.equal(o.sElection.hasActiveSElection, true);
  assert.equal(o.sessionFloor, 2);

  const blocked = o.sessionCadences.filter((s: { allowed: boolean }) => !s.allowed).map((s: { value: string }) => s.value);
  assert.deepEqual(blocked, ['annual'], 'only annual falls below the floor');
  const annual = o.sessionCadences.find((s: { value: string }) => s.value === 'annual');
  assert.match(annual.reason, /below the 2-session floor/i);

  // Every prep cadence is priced as of Brian's ruling, weekly included — so the
  // UI offers all four rather than disabling one.
  for (const p of o.prepCadences) {
    assert.equal(p.priced, true, `${p.value} should be priced`);
    assert.ok(p.itemCode, `${p.value} should name its component item`);
  }
  const weekly = o.prepCadences.find((p: { value: string }) => p.value === 'weekly');
  assert.equal(weekly.itemCode, 'ACCT_PREP_WEEKLY');

  // A client with no S election has every cadence available.
  const plain = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Plain', email: 'plain-cfg@example.test' });
  const open = await app.inject({
    method: 'GET', url: `/contacts/${plain.id}/configurator-options`, headers: auth(brian),
  });
  assert.equal(open.json().sElection.hasActiveSElection, false);
  assert.equal(open.json().sessionCadences.filter((s: { allowed: boolean }) => !s.allowed).length, 0);
});

test('utilization now measures against the configured entitlement, and says so when there is none', async () => {
  const { runReport } = await import('../src/modules/reports/service.ts');
  const client = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Utilized', email: 'utilized-cfg@example.test' });
  const engId = await engagementFor(client.id);
  await app.inject({
    method: 'POST', url: `/engagements/${engId}/configure`, headers: auth(brian),
    payload: { prepCadence: 'monthly', sessionCadence: 'quarterly' },
  });
  // Entitled to 4/year; two held in the trailing year.
  await app.db.query(
    `INSERT INTO client_sessions (contact_id, starts_at, status)
     VALUES ($1, now() - interval '60 days', 'completed'), ($1, now() - interval '20 days', 'completed')`,
    [client.id]
  );
  // Someone with sessions but no configured engagement.
  const unconfigured = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Adhoc', email: 'adhoc-cfg@example.test' });
  await app.db.query(
    `INSERT INTO client_sessions (contact_id, starts_at, status)
     VALUES ($1, now() - interval '10 days', 'completed')`,
    [unconfigured.id]
  );

  const result = await runReport(app, 'session_utilization', { from: '2020-01-01', to: '2030-12-31' });
  const row = result.rows.find((r) => String(r.client).includes('Utilized'))!;
  assert.equal(row.entitled_per_year, '4');
  assert.equal(row.utilization, '50%', '2 held of 4 entitled');

  const adhoc = result.rows.find((r) => String(r.client).includes('Adhoc'))!;
  assert.equal(adhoc.entitled_per_year, '—', 'unconfigured is not zero');
  assert.equal(adhoc.utilization, '—', 'and utilization against nothing is not 0%');
});
