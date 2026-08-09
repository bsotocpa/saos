// M26.5 "Prove it" (v4.6): the tax resolution lane + the bundle builder.
//
// The hard rules under test:
//   · filing lane DERIVES from the year — current + 2 prior e-file, older
//     PAPER — and staff can never route an old year to e-file
//   · refund statute = 3 years from the ORIGINAL due date, surfaced as plain
//     language, and honest once it has passed
//   · one engagement per year (+ reconstruction pairs), chained
//     OLDEST-YEAR-FIRST with real task dependencies
//   · 8821 authorizes transcripts; 2848 authorizes REPRESENTATION, per year
//   · every dollar comes from the price book, and the +$100 prior-year
//     surcharge applies automatically — bundled or not

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import {
  currentTaxYear, filingLane, lookbackYears, planResolution, refundStatuteExpiry,
  statuteNote, surchargeApplies,
} from '../src/modules/tax/resolution.ts';

let app: FastifyInstance;
let config: Config;
let ana: TestStaff & { token: string };

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });
const TODAY = '2026-08-09'; // current tax year = 2025 → e-file 2025/2024/2023

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
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
  config = await createTestConfig('resolution');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  ana = await staffWithToken('ana-res@example.test', 'tax_preparer');
  await makeStaff(app.db, config, {
    email: 'marian-res@example.test', name: 'Synthetic Marian', role: 'bookkeeper',
    password: 'bookkeeper-password-123456',
  });
});

after(async () => {
  await app.close();
});

test('filing lane and surcharge derive from the tax year — never chosen', () => {
  assert.equal(currentTaxYear(TODAY), 2025);
  // Current + two prior file electronically.
  assert.equal(filingLane(2025, TODAY), 'efile');
  assert.equal(filingLane(2024, TODAY), 'efile');
  assert.equal(filingLane(2023, TODAY), 'efile');
  // Everything older is PAPER — no exceptions, no override path.
  assert.equal(filingLane(2022, TODAY), 'paper');
  assert.equal(filingLane(2019, TODAY), 'paper');
  // The surcharge shares the same boundary.
  assert.equal(surchargeApplies(2023, TODAY), false);
  assert.equal(surchargeApplies(2022, TODAY), true);
  // The boundary MOVES with the calendar — no fixed years anywhere.
  assert.equal(filingLane(2023, '2027-08-09'), 'paper', 'a year ages out on its own');
  // Six-year norm, oldest first.
  assert.deepEqual(lookbackYears(TODAY), [2020, 2021, 2022, 2023, 2024, 2025]);
  assert.deepEqual(lookbackYears(TODAY, 3), [2023, 2024, 2025]);
});

test('refund statute = 3 years from the original due date, and says so honestly once passed', () => {
  // 2022 1040: original Apr 18 2023 (Apr 15 = Sat, Emancipation observed Mon)
  // → statute Apr 18 2026.
  assert.equal(refundStatuteExpiry('1040', 2022), '2026-04-20');
  assert.equal(refundStatuteExpiry('1065', 2023), '2027-03-15');
  assert.equal(refundStatuteExpiry('w7_itin', 2022), null, 'no standalone deadline → no statute');

  const live = statuteNote('1040', 2024, 'en', TODAY);
  assert.match(live!, /preserves any refund/);
  const gone = statuteNote('1040', 2019, 'en', TODAY);
  assert.match(gone!, /no longer available/, 'honest when the money is already forfeited');
  const es = statuteNote('1040', 2024, 'es', TODAY);
  assert.match(es!, /conserva cualquier reembolso/);
});

test('plan sorts oldest-first and pairs reconstruction where books are partial or missing', () => {
  const plan = planResolution({
    years: [
      { taxYear: 2024, returnType: '1040' },
      { taxYear: 2021, returnType: '1040', booksExist: 'no' },
      { taxYear: 2022, returnType: '1040', booksExist: 'partial' },
    ],
  }, TODAY);
  assert.deepEqual(plan.map((p) => p.taxYear), [2021, 2022, 2024], 'oldest first — carryforwards flow forward');
  assert.deepEqual(plan.map((p) => p.lane), ['paper', 'paper', 'efile']);
  assert.deepEqual(plan.map((p) => p.needsReconstruction), [true, true, false]);
  assert.deepEqual(plan.map((p) => p.surcharge), [true, true, false]);
});

test('spawning a case: one engagement per year + reconstruction pairs, chained oldest-first, 8821 queued', async () => {
  const nino = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Nonfiler', email: 'nonfiler@example.test' });

  const spawned = await app.inject({
    method: 'POST', url: '/resolution/cases', headers: auth(ana),
    payload: {
      contactId: nino.id,
      asOf: TODAY,
      years: [
        { taxYear: 2023, returnType: '1040' },
        { taxYear: 2021, returnType: '1040', booksExist: 'no' },
        { taxYear: 2022, returnType: '1040', booksExist: 'partial' },
      ],
    },
  });
  assert.equal(spawned.statusCode, 201, spawned.body);
  const { caseId, engagements, f8821EnvelopeId } = spawned.json();

  // 3 returns + 2 reconstructions = 5 engagements, in work order.
  assert.equal(engagements.length, 5);
  assert.deepEqual(
    engagements.map((e: { taxYear: number; kind: string }) => `${e.taxYear}:${e.kind}`),
    ['2021:reconstruction', '2021:return', '2022:reconstruction', '2022:return', '2023:return'],
    'reconstruction precedes its year; years ascend'
  );
  // Lanes came from the years, not from the caller.
  assert.deepEqual(
    engagements.filter((e: { kind: string }) => e.kind === 'return').map((e: { lane: string }) => e.lane),
    ['paper', 'paper', 'efile']
  );

  // THE CHAIN is real task dependencies: each step blocked by the previous.
  const view = await app.inject({ method: 'GET', url: `/resolution/cases/${caseId}`, headers: auth(ana) });
  assert.equal(view.statusCode, 200, view.body);
  const years = view.json().years;
  const firstStep = years.find((y: { tax_year: number; is_reconstruction: boolean }) => y.tax_year === 2021 && y.is_reconstruction);
  assert.equal(firstStep.blocked_by, 0, 'the oldest step is ready to start');
  for (const y of years.filter((r: { tax_year: number }) => r.tax_year > 2021)) {
    assert.ok(y.blocked_by >= 1, `${y.tax_year} waits on the year before it`);
  }

  // Paper years carry the certified-mail checklist in their task.
  const paperTask = await app.db.query<{ description: string }>(
    `SELECT t.description FROM tasks t
     JOIN tax_engagements te ON te.id = t.source_id::uuid
     WHERE t.source_type = 'resolution_year' AND te.tax_year = 2021 AND NOT te.is_reconstruction`
  );
  assert.match(paperTask.rows[0]!.description, /PAPER LANE/);
  assert.match(paperTask.rows[0]!.description, /certified/i);

  // Statute clocks are stored per year, and 2021's is already gone.
  const statutes = await app.db.query<{ tax_year: number; refund_statute_expiry: string }>(
    `SELECT tax_year, refund_statute_expiry::text AS refund_statute_expiry
     FROM tax_engagements WHERE resolution_case_id = $1 AND NOT is_reconstruction ORDER BY tax_year`,
    [caseId]
  );
  assert.equal(statutes.rows[0]!.refund_statute_expiry, refundStatuteExpiry('1040', 2021));

  // 8821 first: envelope created + a send task, and NO transcript task yet.
  const env = await app.db.query<{ type: string; status: string }>(
    `SELECT type::text, status::text FROM signature_envelopes WHERE id = $1`, [f8821EnvelopeId]
  );
  assert.equal(env.rows[0]!.type, 'f8821');
  const sendTask = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'f8821_send' AND source_id = $1`, [caseId]
  );
  assert.equal(sendTask.rows[0]!.n, 1);
  const noTranscripts = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'transcript_request' AND source_id = $1`, [caseId]
  );
  assert.equal(noTranscripts.rows[0]!.n, 0, 'transcripts wait for the signature');

  // Signing the 8821 auto-creates the transcript-request task.
  const { onF8821Signed } = await import('../src/modules/tax/resolution-case.ts');
  await onF8821Signed(app, f8821EnvelopeId);
  const transcripts = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'transcript_request' AND source_id = $1`, [caseId]
  );
  assert.equal(transcripts.rows[0]!.n, 1);
  const signed = await app.db.query<{ f8821_signed_at: Date | null }>(
    `SELECT f8821_signed_at FROM resolution_cases WHERE id = $1`, [caseId]
  );
  assert.ok(signed.rows[0]!.f8821_signed_at);
});

test('representation gate: 8821 is not a POA — abatement work needs a 2848 covering THAT year', async () => {
  const rep = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Represent', email: 'represent@example.test' });
  const spawned = await app.inject({
    method: 'POST', url: '/resolution/cases', headers: auth(ana),
    payload: { contactId: rep.id, asOf: TODAY, years: [{ taxYear: 2021, returnType: '1040' }, { taxYear: 2022, returnType: '1040' }] },
  });
  const caseId = spawned.json().caseId as string;

  // No 2848 at all → refused.
  const noPoa = await app.inject({
    method: 'POST', url: `/resolution/cases/${caseId}/representation-check`, headers: auth(ana),
    payload: { taxYear: 2021 },
  });
  assert.equal(noPoa.statusCode, 409, noPoa.body);
  assert.equal(noPoa.json().error, 'f2848_required');

  // 2848 covering 2021 only.
  const recorded = await app.inject({
    method: 'POST', url: `/resolution/cases/${caseId}/f2848`, headers: auth(ana),
    payload: { scopeYears: [2021] },
  });
  assert.equal(recorded.statusCode, 200, recorded.body);

  const covered = await app.inject({
    method: 'POST', url: `/resolution/cases/${caseId}/representation-check`, headers: auth(ana),
    payload: { taxYear: 2021 },
  });
  assert.equal(covered.statusCode, 200, covered.body);

  // A year OUTSIDE the POA scope is still refused — scope is per year.
  const uncovered = await app.inject({
    method: 'POST', url: `/resolution/cases/${caseId}/representation-check`, headers: auth(ana),
    payload: { taxYear: 2022 },
  });
  assert.equal(uncovered.statusCode, 409, uncovered.body);
  assert.equal(uncovered.json().error, 'f2848_year_not_covered');
});

test('paper lane: certified mailing requires tracking and is refused on an e-file year', async () => {
  const mail = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Papermail', email: 'papermail@example.test' });
  const spawned = await app.inject({
    method: 'POST', url: '/resolution/cases', headers: auth(ana),
    payload: { contactId: mail.id, asOf: TODAY, years: [{ taxYear: 2020, returnType: '1040' }, { taxYear: 2025, returnType: '1040' }] },
  });
  const ids = spawned.json().engagements as Array<{ taxEngagementId: string; taxYear: number }>;
  const paperTe = ids.find((e) => e.taxYear === 2020)!.taxEngagementId;
  const efileTe = ids.find((e) => e.taxYear === 2025)!.taxEngagementId;

  const mailed = await app.inject({
    method: 'POST', url: `/tax-engagements/${paperTe}/paper-mailing`, headers: auth(ana),
    payload: { mailedOn: '2026-08-10', tracking: '9407 1111 2222 3333 4444 55' },
  });
  assert.equal(mailed.statusCode, 200, mailed.body);
  const row = await app.db.query<{ certified_tracking: string; paper_mailed_on: string }>(
    `SELECT certified_tracking, paper_mailed_on::text AS paper_mailed_on FROM tax_engagements WHERE id = $1`,
    [paperTe]
  );
  assert.equal(row.rows[0]!.paper_mailed_on, '2026-08-10');
  assert.match(row.rows[0]!.certified_tracking, /9407/);

  // Certified mail on an e-file year is a category error — refused.
  const wrongLane = await app.inject({
    method: 'POST', url: `/tax-engagements/${efileTe}/paper-mailing`, headers: auth(ana),
    payload: { mailedOn: '2026-08-10', tracking: '9407 0000' },
  });
  assert.equal(wrongLane.statusCode, 409, wrongLane.body);
  assert.equal(wrongLane.json().error, 'not_paper_lane');
});

test('quote grid: every dollar from the price book, +$100 surcharge automatic past two years', async () => {
  const grid = await app.inject({
    method: 'POST', url: '/resolution/quote-grid', headers: auth(ana),
    payload: {
      asOf: TODAY,
      years: [
        { taxYear: 2024, returnType: '1040', itemCode: 'IND_BASE_SINGLE' },              // e-file, no surcharge
        { taxYear: 2022, returnType: '1040', itemCode: 'IND_BASE_SINGLE' },              // paper, surcharge
        { taxYear: 2021, returnType: '1040', itemCode: 'IND_BASE_SINGLE', booksExist: 'no', reconstructionHours: 4 },
      ],
    },
  });
  assert.equal(grid.statusCode, 200, grid.body);
  const rows = grid.json().rows;
  assert.deepEqual(rows.map((r: { taxYear: number }) => r.taxYear), [2021, 2022, 2024], 'oldest first');

  const y2024 = rows.find((r: { taxYear: number }) => r.taxYear === 2024);
  assert.equal(y2024.returnCents, 15000, 'IND_BASE_SINGLE from the book');
  assert.equal(y2024.surchargeCents, 0);
  assert.equal(y2024.lane, 'efile');

  const y2022 = rows.find((r: { taxYear: number }) => r.taxYear === 2022);
  assert.equal(y2022.surchargeCents, 10000, '+$100 automatically, from PRIOR_YEAR_SURCHARGE');
  assert.equal(y2022.lineTotalCents, 25000);
  assert.equal(y2022.lane, 'paper');
  assert.match(y2022.statuteNote, /refund/i);

  const y2021 = rows.find((r: { taxYear: number }) => r.taxYear === 2021);
  assert.equal(y2021.reconstructionCents, 30000, '4h × $75 reconstruction from the book');
  assert.equal(y2021.lineTotalCents, 15000 + 10000 + 30000);

  // Subtotal + admin multi-year discount.
  assert.equal(grid.json().subtotalCents, 15000 + 25000 + 55000);
  const discounted = await app.inject({
    method: 'POST', url: '/resolution/quote-grid', headers: auth(ana),
    payload: {
      asOf: TODAY, multiYearDiscountPercent: 10,
      years: [{ taxYear: 2022, returnType: '1040', itemCode: 'IND_BASE_SINGLE' }],
    },
  });
  assert.equal(discounted.json().discountCents, 2500);
  assert.equal(discounted.json().totalCents, 22500);

  // An item outside the price book is refused, not invented.
  const bogus = await app.inject({
    method: 'POST', url: '/resolution/quote-grid', headers: auth(ana),
    payload: { years: [{ taxYear: 2024, returnType: '1040', itemCode: 'NOT_A_REAL_ITEM' }] },
  });
  assert.equal(bogus.statusCode, 400, bogus.body);
  assert.equal(bogus.json().error, 'unknown_price_items');
});

test('bundles compose from the price book: components priced, optional add-ons excluded until chosen', async () => {
  const listed = await app.inject({ method: 'GET', url: '/bundles', headers: auth(ana) });
  assert.equal(listed.statusCode, 200, listed.body);
  const slugs = listed.json().bundles.map((b: { slug: string }) => b.slug);
  assert.ok(slugs.includes('s-corp-conversion'));
  assert.ok(slugs.includes('tax-resolution'), 'the resolution lane IS a bundle instance');

  const scorp = await app.inject({ method: 'GET', url: '/bundles/s-corp-conversion', headers: auth(ana) });
  assert.equal(scorp.statusCode, 200, scorp.body);
  const body = scorp.json();

  // Fixed components: 2553 $250 + 1120-S $700 + cleanup $75/h + QBO $250 +
  // payroll $250 + tax planning $500 — every figure straight from the book.
  const fixed = body.lines.filter((l: { isOptional: boolean }) => !l.isOptional);
  assert.equal(fixed.length, 6);
  assert.equal(body.subtotalCents, 25000 + 70000 + 7500 + 25000 + 25000 + 50000);
  // No discount is set yet (admin sets it at publish) → total = subtotal.
  assert.equal(body.discount.kind, 'none');
  assert.equal(body.totalCents, body.subtotalCents);
  // The optional quarterly package is quoted separately until chosen.
  assert.equal(body.optionalAddOnCents, 60000);
  // Components still awaiting Brian's price confirmation are surfaced.
  assert.ok(body.unconfirmedItems.includes('SPEC_TAX_PLANNING'));

  // Choosing the optional component folds it into the total.
  const withAddOn = await app.inject({
    method: 'GET', url: '/bundles/s-corp-conversion?include=ACCT_QUARTERLY', headers: auth(ana),
  });
  assert.equal(withAddOn.json().subtotalCents, body.subtotalCents + 60000);
  assert.equal(withAddOn.json().optionalAddOnCents, 0);

  // A percent discount applies to the composed total, never to an ad-hoc price.
  await app.db.query(`UPDATE bundles SET discount_percent = 15 WHERE slug = 's-corp-conversion'`);
  const discounted = await app.inject({ method: 'GET', url: '/bundles/s-corp-conversion', headers: auth(ana) });
  assert.equal(discounted.json().discount.kind, 'percent');
  assert.equal(discounted.json().discount.amountCents, Math.round(body.subtotalCents * 0.15));
  assert.equal(discounted.json().totalCents, body.subtotalCents - Math.round(body.subtotalCents * 0.15));

  // An override price replaces the sum outright.
  await app.db.query(`UPDATE bundles SET discount_percent = NULL, override_cents = 150000 WHERE slug = 's-corp-conversion'`);
  const override = await app.inject({ method: 'GET', url: '/bundles/s-corp-conversion', headers: auth(ana) });
  assert.equal(override.json().discount.kind, 'override');
  assert.equal(override.json().totalCents, 150000);
  await app.db.query(`UPDATE bundles SET override_cents = NULL WHERE slug = 's-corp-conversion'`);
});

test('bundle_components cannot carry a price — the schema has no column for one', async () => {
  // Structural guarantee, not a convention: if someone adds an amount column
  // to bundle_components, a bundle could hold an ad-hoc price. Fail loudly.
  const { rows } = await app.db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'bundle_components'`
  );
  const names = rows.map((r) => r.column_name);
  for (const forbidden of ['amount_cents', 'price_cents', 'unit_cents', 'override_cents']) {
    assert.ok(!names.includes(forbidden), `bundle_components must not have ${forbidden} — bundles compose from the price book`);
  }
});
