// R81 (Brian, 2026-09-27): display names carry the form number. Presentation metadata (0133), never a
// price-book version: the book's own names stay as priced; the builders' catalog and the line a new
// quote snapshots (which the client's proposal reads) carry "Form 1040 — Single" and "Schedule B/D (1040)
// — …", in both languages, so the filter finds "1040". Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createQuote, sendQuote } from '../src/modules/pricing/quotes.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff & { token: string };
const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });
const actor = () => ({ id: ceo.id, email: ceo.email, fullName: 'Synthetic CEO', roleKey: 'ceo' as const, permissions: ['*'], sessionId: 'test' });

before(async () => {
  config = await createTestConfig('dispnames');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email: 'ceo-dispnames@example.test', name: 'Synthetic ceo', role: 'ceo', password: 'ceo-password-1234567', totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: staff.email, password: staff.password, totp: code } });
  ceo = { ...staff, token: res.json().token as string };
});
after(async () => { await app.close(); });

test('the catalog reads the display names; the book keeps its own names; nothing is a new version', async () => {
  const versions = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM price_book_versions`);
  const res = await app.inject({ method: 'GET', url: '/quotes/catalog', headers: auth(ceo) });
  assert.equal(res.statusCode, 200, res.body);
  const items = res.json().items as Array<{ item_code: string; name_en: string; name_es: string }>;
  const by = new Map(items.map((i) => [i.item_code, i]));
  assert.equal(by.get('IND_BASE_SINGLE')!.name_en, 'Form 1040 — Single');
  assert.equal(by.get('IND_BASE_SINGLE')!.name_es, 'Formulario 1040 — Soltero(a)');
  assert.equal(by.get('IND_BASE_MFJ')!.name_en, 'Form 1040 — Married filing jointly');
  assert.equal(by.get('IND_SCH_B_D')!.name_en, 'Schedule B/D (1040) — interest, dividends, capital gains');
  assert.equal(by.get('BIZ_1120S')!.name_en, 'Form 1120-S — S corporation', 'an item with no display name reads its own name');
  const with1040 = items.filter((i) => i.name_en.includes('1040')).map((i) => i.item_code);
  for (const code of ['IND_BASE_SINGLE', 'IND_BASE_MFJ', 'IND_BASE_MFS', 'IND_BASE_HOH', 'IND_SCH_A', 'IND_SCH_B_D', 'IND_SCH_C', 'IND_SCH_E_RENTAL', 'IND_SCH_E_K1']) {
    assert.ok(with1040.includes(code), `"1040" finds ${code}`);
  }
  const book = await app.db.query<{ name_en: string }>(`SELECT DISTINCT name_en FROM price_book_items WHERE item_code = 'IND_BASE_SINGLE'`);
  assert.deepEqual(book.rows.map((r) => r.name_en), ['Individual return — Single'], 'the book\'s own name is untouched');
  const after = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM price_book_versions`);
  assert.equal(after.rows[0]!.n, versions.rows[0]!.n, 'no version written');
});

test('a new quote snapshots the display name in both languages, so the proposal reads it', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Dispnames', email: 'dispnames@example.test', language: 'es' });
  await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [c.id]);
  const q = await createQuote(app, { contactId: c.id, lines: [{ itemCode: 'IND_BASE_MFJ' }, { itemCode: 'IND_SCH_B_D' }] }, actor());
  const lines = await app.db.query<{ item_code: string; description_en: string; description_es: string }>(
    `SELECT item_code, description_en, description_es FROM quote_line_items WHERE quote_id = $1 ORDER BY item_code`, [q.id]);
  assert.deepEqual(lines.rows.map((l) => [l.item_code, l.description_en, l.description_es]), [
    ['IND_BASE_MFJ', 'Form 1040 — Married filing jointly', 'Formulario 1040 — Casados en conjunto'],
    ['IND_SCH_B_D', 'Schedule B/D (1040) — interest, dividends, capital gains', 'Anexos B/D (1040) — intereses, dividendos, ganancias'],
  ]);
  const sent = await sendQuote(app, q.id, actor());
  const pub = await app.inject({ method: 'GET', url: `/public/quote/${sent.url.split('/').pop()}` });
  assert.equal(pub.statusCode, 200, pub.body);
  assert.match(pub.body, /Formulario 1040 — Casados en conjunto|Form 1040 — Married filing jointly/, 'the proposal reads the display name');
});

test('the seed skips a retired version\'s grandfathered row (deposit above price) instead of failing on it', async () => {
  // Production's v4 carried base returns whose deposit exceeded the price; R55's CHECK is NOT VALID, so those rows stay as
  // history, and an UPDATE that touched one failed the whole seed on the 2026-09-28 deploy. Rebuild that row here.
  const v = await app.db.query<{ id: string }>(`SELECT id FROM price_book_versions ORDER BY version_number LIMIT 1`);
  const row = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_items WHERE version_id = $1 AND item_code = 'IND_BASE_SINGLE'`, [v.rows[0]!.id]);
  await app.db.query(`ALTER TABLE price_book_items DROP CONSTRAINT price_book_items_deposit_not_over_price`);
  await app.db.query(`UPDATE price_book_items SET unit = 'flat', amount_cents = 15000, deposit_cents = 25000, display_name_en = NULL, display_name_es = NULL WHERE id = $1`, [row.rows[0]!.id]);
  await app.db.query(`ALTER TABLE price_book_items ADD CONSTRAINT price_book_items_deposit_not_over_price
    CHECK (deposit_cents IS NULL OR unit <> 'flat' OR amount_cents IS NULL OR deposit_cents <= amount_cents) NOT VALID`);
  await app.db.query(`UPDATE price_book_items SET display_name_en = NULL, display_name_es = NULL WHERE item_code = 'IND_BASE_MFJ'`);
  // @ts-expect-error — the seed is plain JavaScript under packages/db.
  const { seedPriceBookDisplayNames } = await import('../../../packages/db/seeds/data/price_book_display_names.mjs');
  const said = await seedPriceBookDisplayNames(app.db);
  assert.match(said, /1 grandfathered row\(s\) of a retired version skipped/);
  const left = await app.db.query<{ display_name_en: string | null }>(`SELECT display_name_en FROM price_book_items WHERE id = $1`, [row.rows[0]!.id]);
  assert.equal(left.rows[0]!.display_name_en, null, 'the grandfathered row is left as history');
  const named = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM price_book_items WHERE item_code = 'IND_BASE_MFJ' AND display_name_en = 'Form 1040 — Married filing jointly'`);
  assert.ok(named.rows[0]!.n > 0, 'every other row is named');
});
