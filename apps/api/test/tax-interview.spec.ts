// The guided tax interview (walkthrough finding C).
//
// The bug: tax quotes priced the base correctly and UNDERSTATED everything else,
// because additional schedules only reached a quote if a staffer remembered to add
// the chips. These tests assert the understatement specifically — that quantities
// carry through, and that a derived quote is bigger than a base-only one by exactly
// the price-book arithmetic.
//
// Brian's two rulings, both asserted:
//   · counts, not yes/no — three rentals price as three
//   · derived schedules EXACT; the range widens the base only

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { deriveTaxQuote, interviewQuestions } from '../src/modules/pricing/tax-interview.ts';
import { createQuote } from '../src/modules/pricing/quotes.ts';
import type { AuthedStaff } from '../src/types.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let ceo: AuthedStaff;

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

/** The seeded price for an item, so assertions read from the book, not literals. */
async function price(code: string): Promise<number> {
  const { rows } = await app.db.query<{ amount_cents: number }>(
    `SELECT i.amount_cents FROM price_book_items i
     JOIN price_book_versions v ON v.id = i.version_id AND v.version_number = 1
     WHERE i.item_code = $1`,
    [code]
  );
  assert.ok(rows[0], `${code} must exist in the price book`);
  return rows[0].amount_cents;
}

before(async () => {
  config = await createTestConfig('taxinterview');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  brian = await staffWithToken('brian-ti@example.test', 'ceo');
  ceo = { id: brian.id, email: brian.email, permissions: ['*'], roleKey: 'ceo' } as AuthedStaff;
});

after(async () => {
  await app.close();
});

test('the interview is seeded, bilingual, and every question can price itself', async () => {
  const en = await interviewQuestions(app, 'en');
  const es = await interviewQuestions(app, 'es');
  assert.ok(en.length >= 9, 'the full question set is seeded');
  assert.equal(en.length, es.length);
  assert.notEqual(en[0]!.prompt, es[0]!.prompt, 'prompts are actually translated');

  const base = en.filter((q) => q.isBase);
  assert.equal(base.length, 1, 'exactly one question sets the base return');
  assert.deepEqual(base[0]!.options?.sort(), ['hoh', 'mfj', 'mfs', 'single']);

  // Counts exist for the per-unit schedules — this is the fix for the understatement.
  const counts = en.filter((q) => q.answerType === 'count').map((q) => q.key);
  for (const key of ['rental_count', 'k1_count', 'self_employment_count', 'extra_states']) {
    assert.ok(counts.includes(key), `${key} must be a COUNT, not a yes/no`);
  }
});

test('THE UNDERSTATEMENT: three rentals price as three, not one', async () => {
  const rental = await price('IND_SCH_E_RENTAL');
  const one = await deriveTaxQuote(app, { filing_status: 'single', rental_count: 1 });
  const three = await deriveTaxQuote(app, { filing_status: 'single', rental_count: 3 });

  assert.equal(three.derivedCents - one.derivedCents, rental * 2, 'each extra rental adds its own price');
  const line = three.lines.find((l) => l.itemCode === 'IND_SCH_E_RENTAL')!;
  assert.equal(line.quantity, 3);
  assert.equal(line.lineCents, rental * 3);
  assert.equal(line.unit, 'per_property', 'priced per property, which is why a boolean could not work');
  assert.match(line.because, /rental properties.*3/is, 'the line says which answer produced it');
});

test('a full interview derives every schedule the answers imply', async () => {
  const [baseMfj, schC, schE, k1, state, bd, schA] = await Promise.all([
    price('IND_BASE_MFJ'), price('IND_SCH_C'), price('IND_SCH_E_RENTAL'),
    price('IND_SCH_E_K1'), price('IND_ADDL_STATE'), price('IND_SCH_B_D'), price('IND_SCH_A'),
  ]);

  const derived = await deriveTaxQuote(app, {
    filing_status: 'mfj',
    self_employment_count: 2,
    rental_count: 3,
    k1_count: 1,
    extra_states: 2,
    investments: true,
    itemize: true,
    household_employee: false,     // false adds nothing
    earned_income_credit: false,
  });

  const expectedDerived = schC * 2 + schE * 3 + k1 * 1 + state * 2 + bd + schA;
  assert.equal(derived.baseCents, baseMfj, 'the base is the filing-status item');
  assert.equal(derived.derivedCents, expectedDerived, 'derived total is price-book arithmetic');
  assert.equal(derived.subtotalCents, baseMfj + expectedDerived);

  // A 'no' answer must not appear as a line at all.
  assert.ok(!derived.lines.some((l) => l.itemCode === 'IND_SCH_H'));
  assert.ok(!derived.lines.some((l) => l.itemCode === 'IND_SCH_EIC'));

  // Versus what the old flow produced when someone forgot the chips: base only.
  const baseOnly = await deriveTaxQuote(app, { filing_status: 'mfj' });
  assert.equal(baseOnly.subtotalCents, baseMfj);
  assert.ok(
    derived.subtotalCents > baseOnly.subtotalCents * 2,
    'the understated version was less than half the real price'
  );
});

test('THE RANGE: derived schedules are exact, only the base widens', async () => {
  const derived = await deriveTaxQuote(app, {
    filing_status: 'single', rental_count: 3, investments: true,
  });
  const band = derived.bandPercent;

  assert.equal(derived.rangeMinCents, derived.subtotalCents, 'the bottom is the composed price');
  const expectedMax = derived.derivedCents + Math.round(derived.baseCents * (1 + band / 100));
  assert.equal(derived.rangeMaxCents, expectedMax, 'only the base is widened');

  // And the narrowed range is genuinely tighter than banding the whole total.
  const wholeTotalBand = Math.round(derived.subtotalCents * (1 + band / 100));
  assert.ok(
    derived.rangeMaxCents < wholeTotalBand,
    'a client who told us the counts sees precision, not vagueness'
  );
});

test('a quote built from the interview stores the answers and narrows its own range', async () => {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Interviewed', email: 'interviewed@example.test',
  });
  const answers = { filing_status: 'mfj', rental_count: 2, investments: true };
  const derived = await deriveTaxQuote(app, answers);

  const quote = await createQuote(
    app,
    {
      contactId: c.id,
      lines: derived.lines.map((l) => ({ itemCode: l.itemCode, quantity: l.quantity })),
      asRange: true,
      rangeBasis: 'base_only',
      baseCents: derived.baseCents,
      interviewAnswers: answers,
    },
    ceo
  );
  assert.equal(quote.totalCents, derived.subtotalCents, 'the quote agrees with the derivation');
  assert.equal(quote.rangeMinCents, derived.subtotalCents);
  assert.equal(quote.rangeMaxCents, derived.rangeMaxCents, 'the narrowed range survives into the quote');

  const row = await app.db.query<{ interview_answers: Record<string, unknown>; range_basis: string }>(
    `SELECT interview_answers, range_basis FROM quotes WHERE id = $1`, [quote.id]
  );
  assert.equal(row.rows[0]!.range_basis, 'base_only');
  assert.equal(
    row.rows[0]!.interview_answers.rental_count, 2,
    'the answers are kept so "you told us two rentals" is answerable later'
  );
});

test('bad answers are refused with something a person can act on', async () => {
  await assert.rejects(
    deriveTaxQuote(app, { rental_count: 2 }),
    (err: { code?: string; message?: string }) => {
      assert.equal(err.code, 'base_answer_required');
      assert.match(String(err.message), /base price/i);
      return true;
    },
    'no filing status means no base return'
  );
  await assert.rejects(
    deriveTaxQuote(app, { filing_status: 'married' }),
    (err: { code?: string }) => err.code === 'invalid_choice'
  );
  await assert.rejects(
    deriveTaxQuote(app, { filing_status: 'single', rental_count: 2.5 }),
    (err: { code?: string }) => err.code === 'invalid_count'
  );
  await assert.rejects(
    deriveTaxQuote(app, { filing_status: 'single', rental_count: 400 }),
    (err: { code?: string; message?: string }) => {
      assert.equal(err.code, 'implausible_count');
      assert.match(String(err.message), /typo/i, 'it suggests the likely cause');
      return true;
    }
  );
  await assert.rejects(
    deriveTaxQuote(app, { filing_status: 'single', favourite_colour: 'blue' }),
    (err: { code?: string }) => err.code === 'unknown_interview_keys'
  );
});

test('the interview is reachable over HTTP and needs a session', async () => {
  const anon = await app.inject({ method: 'GET', url: '/quotes/tax-interview' });
  assert.equal(anon.statusCode, 401);

  const qs = await app.inject({ method: 'GET', url: '/quotes/tax-interview?language=es', headers: auth(brian) });
  assert.equal(qs.statusCode, 200, qs.body);
  assert.ok((qs.json().questions as unknown[]).length >= 9);

  const derived = await app.inject({
    method: 'POST', url: '/quotes/tax-interview/derive', headers: auth(brian),
    payload: { answers: { filing_status: 'hoh', k1_count: 2 } },
  });
  assert.equal(derived.statusCode, 200, derived.body);
  const body = derived.json() as { lines: Array<{ itemCode: string; quantity: number }>; warnings: string[] };
  assert.equal(body.lines.find((l) => l.itemCode === 'IND_SCH_E_K1')?.quantity, 2);
});

test('a RANGE-priced item is not passed off as exact — it widens the range instead', async () => {
  // Found by writing this test: IND_CPA_LETTER has no flat amount, only $250–$500.
  // The first implementation priced it at the MINIMUM inside a line labelled exact,
  // which is the same understatement this whole feature exists to fix.
  await app.db.query(
    `UPDATE tax_interview_questions SET item_code = 'IND_CPA_LETTER' WHERE key = 'household_employee'`
  );
  try {
    const withRange = await deriveTaxQuote(app, { filing_status: 'single', household_employee: true });
    const line = withRange.lines.find((l) => l.itemCode === 'IND_CPA_LETTER');
    assert.ok(line, 'it is still quoted — dropping it would understate too');
    assert.equal(line.isRangePriced, true, 'flagged as range-priced rather than exact');
    assert.equal(line.unitCents, 25000, 'included at the low end');
    assert.equal(line.maxUnitCents, 50000);
    assert.ok(
      withRange.warnings.some((w) => /quoted as a range/i.test(w)),
      'staff are told to set a firm figure before sending'
    );

    // The spread reaches the range: max must exceed base-only widening by $250.
    const baseline = await deriveTaxQuote(app, { filing_status: 'single' });
    const baseWidening = baseline.rangeMaxCents - baseline.rangeMinCents;
    assert.equal(
      withRange.rangeMaxCents - withRange.rangeMinCents,
      baseWidening + 25000,
      'the range brackets reality instead of pretending $250–$500 is exactly $250'
    );
  } finally {
    await app.db.query(
      `UPDATE tax_interview_questions SET item_code = 'IND_SCH_H' WHERE key = 'household_employee'`
    );
  }
});

test('an item with no price at all is left off with a warning, never priced as zero', async () => {
  const { rows } = await app.db.query<{ item_code: string }>(
    `SELECT i.item_code FROM price_book_items i
     JOIN price_book_versions v ON v.id = i.version_id AND v.version_number = 1
     WHERE i.amount_cents IS NULL AND i.price_min_cents IS NULL AND i.is_active LIMIT 1`
  );
  if (!rows[0]) return; // no such item seeded; nothing to assert
  await app.db.query(
    `UPDATE tax_interview_questions SET item_code = $1 WHERE key = 'household_employee'`,
    [rows[0].item_code]
  );
  try {
    const derived = await deriveTaxQuote(app, { filing_status: 'single', household_employee: true });
    assert.ok(derived.unpriced.includes(rows[0].item_code));
    assert.ok(!derived.lines.some((l) => l.itemCode === rows[0]!.item_code), 'never priced as zero');
  } finally {
    await app.db.query(
      `UPDATE tax_interview_questions SET item_code = 'IND_SCH_H' WHERE key = 'household_employee'`
    );
  }
});
