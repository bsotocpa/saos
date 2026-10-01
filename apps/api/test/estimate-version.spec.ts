// R109 (Brian, 2026-09-30): "Estimate locked … (price book vN)" names the version the lock was made
// under, never the book in force when the page is read. Brian's 1040 was locked under v5 and read "v6"
// once v6 came into force. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { currentPriceBookVersion } from '../src/modules/pricing/service.ts';
import { todayChicago } from '../src/modules/tax/deadlines.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff & { token: string };
const auth = () => ({ authorization: `Bearer ${ceo.token}` });

before(async () => {
  config = await createTestConfig('estimateversion');
  app = buildServer(config);
  await app.ready();
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const s = await makeStaff(app.db, config, { email: 'ceo-estver@example.test', name: 'Synthetic ceo', role: 'ceo', password: 'ceo-password-123456', totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: s.email, password: s.password, totp: code } });
  ceo = { ...s, token: res.json().token as string };
});
after(async () => { await app.close(); });

test('a locked estimate names the version it was locked under after a newer version comes into force', async () => {
  const lockedUnder = await currentPriceBookVersion(app.db);
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Estver', email: 'estver@example.test' });
  const e = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status, price_book_version_id) VALUES ($1, 'tax', 'active', $2) RETURNING id`,
    [c.id, lockedUnder.id]
  );
  const te = await app.db.query<{ id: string }>(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, stage, original_deadline) VALUES ($1, 2025, '1040', 'intake_started', '2026-10-15') RETURNING id`,
    [e.rows[0]!.id]
  );
  const lock = await app.inject({ method: 'POST', url: `/tax-engagements/${te.rows[0]!.id}/estimate`, headers: auth(), payload: { minCents: 44000, maxCents: 44000 } });
  assert.equal(lock.statusCode, 200, lock.body);

  // A newer version comes into force today in Chicago; the one the lock used ends.
  await app.db.query(`UPDATE price_book_versions SET effective_to = $2::date WHERE id = $1`, [lockedUnder.id, todayChicago()]);
  await app.db.query(
    `INSERT INTO price_book_versions (version_number, effective_from, note) VALUES ($1, $2::date, 'R109 spec: the newer book')`,
    [lockedUnder.versionNumber + 1, todayChicago()]
  );
  assert.equal((await currentPriceBookVersion(app.db)).versionNumber, lockedUnder.versionNumber + 1, 'the newer version is in force');

  const read = await app.inject({ method: 'GET', url: `/tax-engagements/${te.rows[0]!.id}`, headers: auth() });
  assert.equal(read.statusCode, 200, read.body);
  assert.deepEqual(read.json().quoted_range, { min_cents: 44000, max_cents: 44000, price_book_version: lockedUnder.versionNumber }, 'the label reads the version the lock used');
});
