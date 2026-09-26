// Publishing a price-book version refuses a deposit above its price (Brian, 2026-09-26, R55).
//
// A version is published whole and never edited afterwards, so the one moment to catch a line whose
// deposit exceeds the price it is taken against is the publish. The constraint from 0053 sits behind
// this as the backstop (it was added NOT VALID over four version-4 rows and cannot be validated until
// they are Brian's to fix); the route's own refusal comes first and names the lines, which is what
// these tests tell apart: a 409 deposit_over_price, never a 409 check_violation.
// Synthetic data only; every amount is read from the book, never typed here.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'x' }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

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

/** A flat line of the latest version that carries both a price and a deposit, with its numbers. */
async function flatLineWithDeposit(): Promise<{ item_code: string; amount_cents: number; deposit_cents: number }> {
  const { rows } = await app.db.query<{ item_code: string; amount_cents: number; deposit_cents: number }>(
    `SELECT i.item_code, i.amount_cents, i.deposit_cents FROM price_book_items i
       JOIN price_book_versions v ON v.id = i.version_id
      WHERE v.version_number = (SELECT max(version_number) FROM price_book_versions)
        AND i.unit = 'flat' AND i.amount_cents IS NOT NULL AND i.deposit_cents IS NOT NULL
      ORDER BY i.item_code LIMIT 1`
  );
  assert.ok(rows[0], 'the seeded book has a flat line with a deposit');
  return rows[0]!;
}
async function hourlyLine(): Promise<{ item_code: string; amount_cents: number }> {
  const { rows } = await app.db.query<{ item_code: string; amount_cents: number }>(
    `SELECT i.item_code, i.amount_cents FROM price_book_items i
       JOIN price_book_versions v ON v.id = i.version_id
      WHERE v.version_number = (SELECT max(version_number) FROM price_book_versions)
        AND i.unit = 'per_hour' AND i.amount_cents IS NOT NULL
      ORDER BY i.item_code LIMIT 1`
  );
  assert.ok(rows[0], 'the seeded book has a per-hour line');
  return rows[0]!;
}
async function versionCount(): Promise<number> {
  const { rows } = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM price_book_versions`);
  return rows[0]!.n;
}
let day = 1;
/** Each publish must start after the last; a fresh day per call. */
const nextDay = () => new Date(Date.now() + 86_400_000 * ++day).toISOString().slice(0, 10);
const publish = (changes: unknown[]) => app.inject({
  method: 'POST', url: '/admin/price-book/versions', headers: auth(brian),
  payload: { effectiveFrom: nextDay(), note: 'synthetic publish', changes },
});

before(async () => {
  config = await createTestConfig('pb_publish');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  brian = await staffWithToken('brian-pbpublish@example.test', 'ceo');
});
after(async () => { await app.close(); });

test('a publish whose change puts a flat line\'s deposit above its price is refused by name, and nothing is written', async () => {
  const line = await flatLineWithDeposit();
  const before = await versionCount();
  const res = await publish([{ itemCode: line.item_code, depositCents: line.amount_cents + 1 }]);
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error, 'deposit_over_price', 'the route refuses in its own words, before the constraint does');
  assert.match(res.json().message, new RegExp(line.item_code));
  assert.equal(await versionCount(), before, 'no version row was written by the refused publish');
});

test('the price moving under an existing deposit is refused the same way — the check reads the rows the version WOULD hold', async () => {
  const line = await flatLineWithDeposit();
  const res = await publish([{ itemCode: line.item_code, amountCents: line.deposit_cents - 1 }]);
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error, 'deposit_over_price');
  assert.match(res.json().message, new RegExp(line.item_code));
});

test('two offending lines are both named', async () => {
  const { rows } = await app.db.query<{ item_code: string; amount_cents: number }>(
    `SELECT i.item_code, i.amount_cents FROM price_book_items i
       JOIN price_book_versions v ON v.id = i.version_id
      WHERE v.version_number = (SELECT max(version_number) FROM price_book_versions)
        AND i.unit = 'flat' AND i.amount_cents IS NOT NULL AND i.deposit_cents IS NOT NULL
      ORDER BY i.item_code LIMIT 2`
  );
  assert.equal(rows.length, 2);
  const res = await publish(rows.map((r) => ({ itemCode: r.item_code, depositCents: r.amount_cents + 1 })));
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error, 'deposit_over_price');
  for (const r of rows) assert.match(res.json().message, new RegExp(r.item_code));
  assert.match(res.json().message, /these lines/);
});

test('a deposit equal to the price publishes; a per-hour line above one hour\'s price publishes (flat rows only are compared)', async () => {
  const line = await flatLineWithDeposit();
  const equal = await publish([{ itemCode: line.item_code, depositCents: line.amount_cents }]);
  assert.equal(equal.statusCode, 201, equal.body);

  const hourly = await hourlyLine();
  const perHour = await publish([{ itemCode: hourly.item_code, depositCents: hourly.amount_cents * 3 }]);
  assert.equal(perHour.statusCode, 201, perHour.body);
});
