// Schedule F — attest (SOTO_Schedule_F_Attest_FINALFORM).
//
// Attest is the firm's highest-liability work, so this suite is about refusals as
// much as capability:
//
//  · attest is now ASSEMBLABLE (it was refused outright before Schedule F)
//  · but NOT without a per-engagement Addendum — AU-C 210 / AR-C 90 require the
//    entity, statements, period, framework and fee to be agreed per engagement
//  · "hourly, hours unknown" is not agreed terms
//  · the fee comes from the PRICE BOOK, pinned, never typed
//  · the INDEPENDENCE GATE is exactly as it was: active bookkeeping/payroll/
//    management still blocks attest creation absent Brian's documented override
//  · and a schedule still flagged PLACEHOLDER cannot ride in a packet at all

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { createAttestAddendum } from '../src/modules/engagements/attest-addendum.ts';
import {
  createPacket, previewPacket, recordMasterSignature, renderScheduleF, resolveSchedules,
} from '../src/modules/engagements/packet.ts';
import type { AuthedStaff } from '../src/types.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let ana: TestStaff & { token: string };
let ceo: AuthedStaff;
let preparer: AuthedStaff;

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };

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

/** Schedule F ships flagged pending Brian's word; these tests need it final. */
async function makeScheduleFFinal(): Promise<void> {
  await app.db.query(`UPDATE templates SET is_placeholder = false WHERE schedule_code = 'F'`);
}

async function attestClient(name: string): Promise<{ contactId: string; engagementId: string }> {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: name, email: `${name.toLowerCase()}@example.test`,
  });
  const eng = await createEngagement(app, ceo, { contactId: c.id, serviceLine: 'attest', status: 'active' }, {});
  return { contactId: c.id, engagementId: eng.id };
}

const ADDENDUM = {
  entityName: 'Synthetic Manufacturing LLC',
  engagementType: 'audit' as const,
  statementsAndPeriods: 'Balance sheet and statements of income and cash flows, year ended 2025-12-31',
  reportingFramework: 'US GAAP',
  feeBasis: 'fixed' as const,
  depositItemCode: 'DEPOSIT_1040',
  expectedReportDate: '2026-04-30',
};

before(async () => {
  config = await createTestConfig('schedulef');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  brian = await staffWithToken('brian-sf@example.test', 'ceo');
  ana = await staffWithToken('ana-sf@example.test', 'tax_preparer');
  ceo = { id: brian.id, email: brian.email, permissions: ['*'], roleKey: 'ceo' } as AuthedStaff;
  preparer = { id: ana.id, email: ana.email, permissions: ['engagements.tax.manage'], roleKey: 'tax_preparer' } as AuthedStaff;
});

after(async () => {
  await app.close();
});

// ── The seed ──────────────────────────────────────────────────────────────────

test('Schedule F is loaded, mapped to attest, and queued for Spanish approval', async () => {
  const { rows } = await app.db.query<{
    key: string; kind: string; schedule_code: string; is_active: boolean;
    needs_es_review: boolean; body_es: string | null; is_placeholder: boolean;
  }>(
    `SELECT key, kind::text AS kind, schedule_code, is_active, needs_es_review, body_es, is_placeholder
     FROM templates WHERE schedule_code = 'F'`
  );
  assert.equal(rows.length, 1);
  const f = rows[0]!;
  assert.equal(f.kind, 'schedule');
  assert.equal(f.is_active, true);
  assert.equal(f.needs_es_review, true, 'English controls until Brian approves the translation');

  // This used to assert body_es === null. That was a PROXY for "no unapproved Spanish
  // ships", true only while no translations existed at all — and the translations now
  // exist, written and pending approval. Rather than drop the assertion, it now tests
  // the thing it was standing in for, which is also the stronger claim: an unapproved
  // Spanish body may be PRESENT, and a Spanish render must still return English.
  assert.ok(f.body_es && f.body_es.length > 0, 'Schedule F now has a pending translation');

  const { renderTemplate } = await import('../src/modules/templates/service.ts');
  // Schedule F carries the Addendum placeholders and renderTemplate refuses to render
  // with any of them missing — the "a template variable nobody fills is a document with
  // {{...}} in it" rule. Supply them; this test is about LANGUAGE, not the Addendum.
  const rendered = await renderTemplate(app, 'schedule_f_attest', 'es', {
    entity_name: 'Synthetic Entity LLC',
    engagement_type: 'review',
    statements_and_periods: 'FY2026',
    reporting_framework: 'US GAAP',
    fee_summary: 'per the Addendum',
    deposit_summary: 'per the Addendum',
    expected_report_date: '2026-10-01',
  });
  assert.match(
    rendered.body,
    /SCHEDULE F — ATTEST SERVICES/,
    'a Spanish render still returns the ENGLISH body while the translation is unapproved'
  );
  assert.doesNotMatch(rendered.body, /ATESTIGUAMIENTO/, 'the pending Spanish did not leak');
  assert.equal(f.is_placeholder, false, 'final: flag cleared 2026-08-10 on Brian’s ruling');

  const mapped = await app.db.query<{ lines: string[] }>(
    `SELECT service_lines::text[] AS lines FROM service_schedules WHERE schedule_code = 'F'`
  );
  assert.deepEqual(mapped.rows[0]!.lines, ['attest']);

  const body = await app.db.query<{ body_en: string }>(
    `SELECT body_en FROM templates WHERE schedule_code = 'F'`
  );
  // Spot-check clauses that carry real weight, verbatim from the attorney document.
  assert.match(body.rows[0]!.body_en, /Statements on Standards for Accounting and Review Services/);
  assert.match(body.rows[0]!.body_en, /reasonable — not absolute — assurance/);
  assert.match(body.rows[0]!.body_en, /independence may be impaired/);
  assert.match(body.rows[0]!.body_en, /signed representation letter/);
});

test('a schedule flagged PLACEHOLDER cannot ride in a packet at all', async () => {
  // Schedule F is final now, so flag it deliberately: the point is that the gate
  // protects a client whenever ANY schedule goes under review, not just today.
  // Before this, the placeholder gate checked only the Master — a packet could
  // carry an under-review schedule and a Master signature would record acceptance.
  await app.db.query(`UPDATE templates SET is_placeholder = true WHERE schedule_code = 'F'`);
  const { contactId } = await attestClient('FlaggedF');
  await assert.rejects(
    previewPacket(app, contactId),
    (err: { code?: string; message?: string }) => {
      assert.equal(err.code, 'schedule_not_final');
      assert.match(String(err.message), /Schedule F/);
      return true;
    },
    'a placeholder schedule blocks the whole packet — not just its own acceptance'
  );
  await makeScheduleFFinal();
});

// ── Attest is now assemblable, under a harder rule ────────────────────────────

test('attest resolves to Schedule F instead of being refused outright', async () => {
  await makeScheduleFFinal();
  const { contactId } = await attestClient('ResolvesF');
  const resolved = await resolveSchedules(app, contactId);
  assert.deepEqual(resolved.codes, ['F'], 'attest used to throw service_line_unscheduled; now it maps');
  assert.deepEqual(resolved.reasons.F, ['attest']);
});

test('an attest packet is REFUSED until the per-engagement Addendum exists', async () => {
  await makeScheduleFFinal();
  const { contactId } = await attestClient('NeedsAddendum');
  await assert.rejects(
    previewPacket(app, contactId),
    (err: { code?: string; message?: string }) => {
      assert.equal(err.code, 'attest_addendum_required');
      assert.match(String(err.message), /AU-C 210 \/ AR-C 90/);
      return true;
    }
  );
  const packets = await app.db.query(`SELECT 1 FROM engagement_packets WHERE contact_id = $1`, [contactId]);
  assert.equal(packets.rows.length, 0, 'and nothing was created');
});

test('a complete Addendum unlocks assembly and rides in the packet', async () => {
  await makeScheduleFFinal();
  const { contactId, engagementId } = await attestClient('CompleteAddendum');
  const addendum = await createAttestAddendum(app, ceo, { engagementId, ...ADDENDUM });
  assert.equal(addendum.feeCents, 500000, 'the audit fee is PINNED from ATTEST_AUDIT in the price book');
  assert.equal(addendum.depositCents, 25000);

  const preview = await previewPacket(app, contactId);
  assert.deepEqual(preview.codes, ['F']);
  assert.equal(preview.attestAddendum?.id, addendum.id);
  assert.equal(preview.attestAddendum?.feeSummary, '$5,000.00 fixed fee');

  const packet = await createPacket(app, contactId, ceo);
  const row = await app.db.query<{ attest_addendum_id: string | null }>(
    `SELECT attest_addendum_id FROM engagement_packets WHERE id = $1`, [packet.packetId]
  );
  assert.equal(row.rows[0]!.attest_addendum_id, addendum.id, 'the packet records WHICH Addendum was signed with it');

  // One signature covers the Master and Schedule F.
  await recordMasterSignature(app, packet.packetId);
  const acceptance = await app.db.query<{ via: string }>(
    `SELECT via::text AS via FROM schedule_acceptances WHERE contact_id = $1 AND schedule_code = 'F'`,
    [contactId]
  );
  assert.equal(acceptance.rows[0]!.via, 'master_signature');
});

test('the Addendum blanks are filled from the record — no client signs a blank form', async () => {
  await makeScheduleFFinal();
  const { contactId, engagementId } = await attestClient('RendersAddendum');
  await createAttestAddendum(app, ceo, {
    engagementId, ...ADDENDUM, engagementType: 'review', feeBasis: 'hourly', estimatedHours: 40,
  });
  const { body, addendum } = await renderScheduleF(app, contactId);
  assert.doesNotMatch(body, /\{\{/, 'no unfilled variable reaches a signer');
  assert.doesNotMatch(body, /_{4,}/, 'and no empty blank lines either');
  assert.match(body, /Synthetic Manufacturing LLC/);
  assert.match(body, /Review \(SSARS\)/);
  assert.match(body, /US GAAP/);
  assert.match(body, /per hour, estimated 40\.00 hours/);
  assert.equal(addendum.expectedReportDate, '2026-04-30');
});

test('"hourly, hours unknown" is not agreed terms — the service refuses, and so does the DB', async () => {
  await makeScheduleFFinal();
  const { engagementId } = await attestClient('HourlyNoHours');
  await assert.rejects(
    createAttestAddendum(app, ceo, { ...ADDENDUM, engagementId, feeBasis: 'hourly' }),
    (err: { code?: string }) => err.code === 'estimated_hours_required'
  );

  // And the constraint holds even if a future code path forgets to ask.
  const eng = await attestClient('HourlyNoHoursDb');
  const version = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions ORDER BY version_number DESC LIMIT 1`
  );
  await assert.rejects(
    app.db.query(
      `INSERT INTO attest_addenda
         (engagement_id, contact_id, entity_name, engagement_type, statements_and_periods,
          reporting_framework, price_book_version_id, fee_item_code, fee_basis,
          fee_hourly_rate_cents, deposit_cents, expected_report_date)
       VALUES ($1, $2, 'Synthetic Co', 'audit', 'FY2025 statements', 'US GAAP', $3,
               'IND_SPECIALIZED_HOURLY', 'hourly', 15000, 25000, '2026-04-30')`,
      [eng.engagementId, eng.contactId, version.rows[0]!.id]
    ),
    /attest_addenda_fee_agreed/,
    'hourly with no estimate is unstorable'
  );
});

test('an Addendum cannot be hung off a non-attest engagement', async () => {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'TaxNotAttest', email: 'taxnotattest@example.test',
  });
  const eng = await createEngagement(app, ceo, { contactId: c.id, serviceLine: 'tax', status: 'active' }, {});
  await assert.rejects(
    createAttestAddendum(app, ceo, { ...ADDENDUM, engagementId: eng.id }),
    (err: { code?: string }) => err.code === 'not_an_attest_engagement'
  );
});

// ── The independence gate: unchanged, and still the first thing that fires ────

test('INDEPENDENCE GATE UNCHANGED: active bookkeeping still blocks attest creation', async () => {
  await makeScheduleFFinal();
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'HasBooks', email: 'hasbooks@example.test',
  });
  await createEngagement(app, ceo, { contactId: c.id, serviceLine: 'bookkeeping', status: 'active' }, {});

  // Schedule F existing does NOT loosen this by one inch.
  await assert.rejects(
    createEngagement(app, ceo, { contactId: c.id, serviceLine: 'attest', status: 'active' }, {}),
    (err: { code?: string; message?: string }) => {
      assert.equal(err.code, 'independence_conflict');
      assert.match(String(err.message), /bookkeeping/);
      return true;
    },
    'loading Schedule F must not have opened an attest path around independence'
  );

  // A non-CEO cannot override, even with a note.
  await assert.rejects(
    createEngagement(
      app, preparer,
      { contactId: c.id, serviceLine: 'attest', status: 'active', independenceOverrideNote: 'Client insists on it.' },
      {}
    ),
    (err: { code?: string }) => err.code === 'independence_override_requires_ceo'
  );

  // Brian's documented override works, and is recorded.
  const overridden = await createEngagement(
    app, ceo,
    {
      contactId: c.id, serviceLine: 'attest', status: 'active',
      independenceOverrideNote: 'Bookkeeping is being transitioned out before fieldwork begins.',
    },
    {}
  );
  assert.equal(overridden.independenceOverridden, true);
  const audit = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log
     WHERE contact_id = $1 AND action = 'engagement.independence_override'`,
    [c.id]
  );
  assert.equal(audit.rows[0]!.n, 1, 'the override is audited by name');
});

test('an unknown price-book item is refused rather than defaulted to zero', async () => {
  const { engagementId } = await attestClient('BadPriceItem');
  await assert.rejects(
    createAttestAddendum(app, ceo, { ...ADDENDUM, engagementId, depositItemCode: 'NOT_A_REAL_ITEM' }),
    (err: { code?: string }) => err.code === 'price_item_unknown'
  );
});
