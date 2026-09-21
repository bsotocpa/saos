// THE QUOTE BUILDER REDESIGN (Brian, 2026-09-20): grouped catalog rows, lines priced off the book
// under one reason and one money action, custom lines, packages that fill editable lines and are
// saved by the CEO alone. Synthetic data only; every amount below is read from the book or is a
// delta on it.
//
//   · every catalog item carries a group the API names; the groups the API names are the groups
//     the book uses, and re-running the seed creates no price-book version
//   · an edited amount is refused without the one reason, refused with a chat artifact in it,
//     and accepted with a real one: the line carries the edit, the book price sits beside it, the
//     audit row lists the line, and the money line shows it for staff and not for the CEO
//   · a custom line needs the reason too, names its service line, and reaches the engagement
//   · pricing.packages.save is explicit-only: the preparer and the wildcard-less ED are refused,
//     the CEO saves, the package composes, and its discount applies to the edited lines

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { seedAll } from '@saos/db';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff, businessFor } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { EXPLICIT_ONLY_PERMISSIONS } from '../src/plugins/auth.ts';
import { CATALOG_GROUPS, GROUP_KEYS } from '../src/modules/pricing/groups.ts';
import { MONEY_ACTIONS, moneyLineToday } from '../src/modules/billing/money-digest.ts';
import { engagementLinesForQuote } from '../src/modules/pricing/engagement-lines.ts';
import { todayChicago } from '../src/modules/tax/deadlines.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let ana: TestStaff & { token: string };
let jackson: TestStaff & { token: string };

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });
const RETURN = 'BIZ_1120S';
const STATE = 'BIZ_ADDL_STATE';
const REASON = 'The second state is a short-year filing; priced below the book for this client.';

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${role}`, role, password: `${role}-password-1234567`, totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

let seq = 0;
async function client(): Promise<{ contactId: string; businessId: string }> {
  seq += 1;
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: `Builder${seq}`, email: `builder-${seq}@example.test` });
  return { contactId: c.id, businessId: await businessFor(app.db, c.id) };
}

async function bookAmount(code: string): Promise<number> {
  const { rows } = await app.db.query<{ amount_cents: number }>(
    `SELECT i.amount_cents FROM price_book_items i JOIN price_book_versions v ON v.id = i.version_id
     WHERE v.effective_to IS NULL AND i.item_code = $1`, [code]);
  return rows[0]!.amount_cents;
}

before(async () => {
  config = await createTestConfig('quotebuilder');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  brian = await staffWithToken('brian-qb@example.test', 'ceo');
  ana = await staffWithToken('ana-qb@example.test', 'tax_preparer');
  jackson = await staffWithToken('jackson-qb@example.test', 'ed_coo');
});

after(async () => {
  await app.close();
});

test('every catalog item carries a group the API names, and the seed creates no price-book version', async () => {
  const res = await app.inject({ method: 'GET', url: '/quotes/catalog', headers: auth(ana) });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as {
    items: Array<{ item_code: string; group_key: string | null; description_en: string | null; sort_order: number }>;
    groups: Array<{ key: string; label: string; fits: string }>;
    serviceLines: Array<{ key: string; label: string }>;
    bandPercent: number;
  };
  assert.ok(body.items.length > 40, 'the book is offered');
  for (const i of body.items) assert.ok(i.group_key && GROUP_KEYS.has(i.group_key), `${i.item_code} carries a known group, got ${i.group_key}`);
  assert.deepEqual(body.groups, CATALOG_GROUPS);
  assert.equal(typeof body.bandPercent, 'number');
  assert.ok(body.serviceLines.some((s) => s.key === 'business_tax'));
  assert.equal(body.items.find((i) => i.item_code === RETURN)?.group_key, 'business_returns');
  assert.equal(body.items.find((i) => i.item_code === 'IND_SCH_A')?.group_key, 'individual_forms');
  assert.ok('description_en' in body.items[0]!, 'the one-line description travels with the row');

  // Across EVERY version's rows: no item without a group, and the book's groups are exactly the API's.
  const all = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM price_book_items WHERE group_key IS NULL`);
  assert.equal(all.rows[0]!.n, 0, 'no price-book row without a group');
  const used = await app.db.query<{ group_key: string }>(`SELECT DISTINCT group_key FROM price_book_items ORDER BY 1`);
  assert.deepEqual(used.rows.map((r) => r.group_key).sort(), [...GROUP_KEYS].sort());

  const before = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM price_book_versions`);
  await seedAll(app.db);
  const afterSeed = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM price_book_versions`);
  assert.equal(afterSeed.rows[0]!.n, before.rows[0]!.n, 're-seeding is not a price-book version change');
});

test('an edited amount is refused without the reason, refused with a chat artifact, and recorded with a real one', async () => {
  const c = await client();
  const book = await bookAmount(STATE);
  const edited = book - 5000;
  const lines = [{ itemCode: RETURN }, { itemCode: STATE, quantity: 2, unitCents: edited }];

  const noReason = await app.inject({ method: 'POST', url: '/quotes', headers: auth(ana), payload: { contactId: c.contactId, businessId: c.businessId, lines } });
  assert.equal(noReason.statusCode, 400, noReason.body);
  assert.equal(noReason.json().error, 'price_change_reason_required');
  assert.equal(noReason.json().issues[0].path, 'priceChangeReason', 'the refusal names the control');

  const artifact = await app.inject({ method: 'POST', url: '/quotes', headers: auth(ana), payload: { contactId: c.contactId, businessId: c.businessId, lines, priceChangeReason: 'per ruling 3, the client agreed to it' } });
  assert.equal(artifact.statusCode, 400, artifact.body);
  const issue = (artifact.json().issues as Array<{ path: string; message: string }>).find((i) => i.path === 'priceChangeReason');
  assert.ok(issue && /a ruling number points into a conversation/.test(issue.message), artifact.body);

  const ok = await app.inject({ method: 'POST', url: '/quotes', headers: auth(ana), payload: { contactId: c.contactId, businessId: c.businessId, lines, priceChangeReason: REASON, asRange: false } });
  assert.equal(ok.statusCode, 201, ok.body);
  const quoteId = ok.json().id as string;
  assert.equal(ok.json().totalCents, (await bookAmount(RETURN)) + edited * 2, 'the total is the edited line times its quantity plus the book line');

  const view = await app.inject({ method: 'GET', url: `/quotes/${quoteId}`, headers: auth(ana) });
  assert.equal(view.statusCode, 200, view.body);
  const v = view.json() as { quote: { price_change_reason: string }; lines: Array<{ item_code: string; unit_cents: number; book_unit_cents: number | null; is_custom: boolean }> };
  assert.equal(v.quote.price_change_reason, REASON);
  const state = v.lines.find((l) => l.item_code === STATE)!;
  assert.equal(state.unit_cents, edited, 'the line carries the edit');
  assert.equal(state.book_unit_cents, book, 'and the book price sits beside it');
  const ret = v.lines.find((l) => l.item_code === RETURN)!;
  assert.equal(ret.unit_cents, ret.book_unit_cents, 'the untouched line is at the book');

  const audit = await app.db.query<{ details: { reason: string; amount_cents: number; lines: Array<{ item_code: string; book_unit_cents: number; unit_cents: number; quantity: number }> }; actor_label: string }>(
    `SELECT details, actor_label FROM audit_log WHERE action = 'quote.prices_changed' AND object_id = $1`, [quoteId]);
  assert.equal(audit.rows.length, 1, 'ONE money action for the whole quote');
  const d = audit.rows[0]!.details;
  assert.equal(d.reason, REASON);
  assert.deepEqual(d.lines.map((l) => l.item_code), [STATE], 'each changed line is listed, and only those');
  assert.equal(d.lines[0]!.book_unit_cents, book);
  assert.equal(d.lines[0]!.unit_cents, edited);
  assert.equal(d.amount_cents, (edited - book) * 2, 'the amount moved off the book, over the quantity');
  assert.ok(MONEY_ACTIONS.includes('quote.prices_changed'));

  // The money line: staff class for the preparer, with her name.
  const line = await moneyLineToday(app, todayChicago());
  const row = line.byStaff.find((r) => r.actorId === ana.id && r.action === 'Quote priced off the book');
  assert.ok(row, 'the preparer\'s change is on the money line');
  assert.equal(row!.actor, ana.fullName);
  assert.equal(row!.amountCents, (edited - book) * 2);
  assert.equal(row!.reason, REASON);
});

test('the CEO\'s own change is on neither money line', async () => {
  const c = await client();
  const book = await bookAmount(RETURN);
  const res = await app.inject({ method: 'POST', url: '/quotes', headers: auth(brian), payload: {
    contactId: c.contactId, businessId: c.businessId, lines: [{ itemCode: RETURN, unitCents: book + 10000 }],
    priceChangeReason: 'Three shareholders and two states; the return is larger than the base price assumes.',
  } });
  assert.equal(res.statusCode, 201, res.body);
  const line = await moneyLineToday(app, todayChicago());
  assert.ok(!line.byStaff.some((r) => r.actorId === brian.id), 'not "by staff"');
  assert.ok(!line.outsideTheDoor.some((r) => r.actorId === brian.id), 'not "outside the door"');
});

test('a custom line needs the reason, names its service line, and reaches the engagement', async () => {
  const c = await client();
  const custom = { custom: { name: 'Board minutes review for the election year', serviceLine: 'business_tax' }, unitCents: 12345 };

  const noAmount = await app.inject({ method: 'POST', url: '/quotes', headers: auth(ana), payload: { contactId: c.contactId, businessId: c.businessId, lines: [{ custom: custom.custom }], priceChangeReason: REASON } });
  assert.equal(noAmount.statusCode, 400, noAmount.body);
  assert.ok((noAmount.json().issues as Array<{ path: string }>).some((i) => /unitCents$/.test(i.path)), 'a custom line needs an amount');

  const noReason = await app.inject({ method: 'POST', url: '/quotes', headers: auth(ana), payload: { contactId: c.contactId, businessId: c.businessId, lines: [{ itemCode: RETURN }, custom] } });
  assert.equal(noReason.statusCode, 400, noReason.body);
  assert.equal(noReason.json().error, 'price_change_reason_required');

  const ok = await app.inject({ method: 'POST', url: '/quotes', headers: auth(ana), payload: { contactId: c.contactId, businessId: c.businessId, lines: [{ itemCode: RETURN }, custom], priceChangeReason: REASON, asRange: false } });
  assert.equal(ok.statusCode, 201, ok.body);
  const quoteId = ok.json().id as string;
  assert.equal(ok.json().totalCents, (await bookAmount(RETURN)) + custom.unitCents);

  const view = await app.inject({ method: 'GET', url: `/quotes/${quoteId}`, headers: auth(ana) });
  const l = (view.json().lines as Array<{ item_code: string; is_custom: boolean; service_line: string; book_unit_cents: number | null; description_en: string; unit_cents: number }>).find((x) => x.is_custom)!;
  assert.ok(l, 'the custom line is on the quote');
  assert.match(l.item_code, /^CUSTOM_[0-9A-F]{8}$/);
  assert.equal(l.service_line, 'business_tax');
  assert.equal(l.book_unit_cents, null, 'no book price behind it');
  assert.equal(l.description_en, custom.custom.name);
  assert.equal(l.unit_cents, custom.unitCents);

  const engagementLines = await engagementLinesForQuote(app, quoteId);
  assert.equal(engagementLines.length, 1, 'one engagement line: tax, from both lines');
  assert.equal(engagementLines[0]!.serviceLine, 'tax');
  assert.ok(engagementLines[0]!.itemCodes.includes(l.item_code), 'the custom line reaches the engagement scope');

  const audit = await app.db.query<{ details: { lines: Array<{ item_code: string; is_custom: boolean; book_unit_cents: number | null }> } }>(
    `SELECT details FROM audit_log WHERE action = 'quote.prices_changed' AND object_id = $1`, [quoteId]);
  assert.equal(audit.rows.length, 1);
  assert.deepEqual(audit.rows[0]!.details.lines.map((x) => [x.is_custom, x.book_unit_cents]), [[true, null]]);

  // A quote whose every line is at the book needs no reason and writes no money action.
  const plain = await app.inject({ method: 'POST', url: '/quotes', headers: auth(ana), payload: { contactId: c.contactId, businessId: c.businessId, lines: [{ itemCode: RETURN, unitCents: await bookAmount(RETURN) }, { itemCode: STATE }] } });
  assert.equal(plain.statusCode, 201, plain.body);
  const none = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'quote.prices_changed' AND object_id = $1`, [plain.json().id]);
  assert.equal(none.rows[0]!.n, 0, 'an amount equal to the book is not a change');
});

test('saving lines as a package is the CEO alone; the package composes and its discount applies to edited lines', async () => {
  assert.ok(EXPLICIT_ONLY_PERMISSIONS.has('pricing.packages.save'));
  const payload = { name: 'Harness first year', lines: [{ itemCode: RETURN }, { itemCode: STATE, quantity: 1 }] };

  const preparer = await app.inject({ method: 'POST', url: '/quotes/packages', headers: auth(ana), payload });
  assert.equal(preparer.statusCode, 403, preparer.body);
  assert.equal(preparer.json().message, 'This session does not hold pricing.packages.save.');
  const ed = await app.inject({ method: 'POST', url: '/quotes/packages', headers: auth(jackson), payload });
  assert.equal(ed.statusCode, 403, ed.body);

  const ceo = await app.inject({ method: 'POST', url: '/quotes/packages', headers: auth(brian), payload });
  assert.equal(ceo.statusCode, 201, ceo.body);
  assert.deepEqual(ceo.json(), { slug: 'harness-first-year', name: 'Harness first year', components: 2 });
  const again = await app.inject({ method: 'POST', url: '/quotes/packages', headers: auth(brian), payload });
  assert.equal(again.statusCode, 201, again.body);
  assert.equal(again.json().slug, 'harness-first-year-2', 'a second package of the same name is its own slug');

  const withCustom = await app.inject({ method: 'POST', url: '/quotes/packages', headers: auth(brian), payload: { name: 'Not a package', lines: [{ itemCode: 'CUSTOM_ABCDEF01' }] } });
  assert.equal(withCustom.statusCode, 400, withCustom.body);
  assert.equal(withCustom.json().error, 'custom_line_in_package');

  const composed = await app.inject({ method: 'GET', url: '/bundles/harness-first-year', headers: auth(ana) });
  assert.equal(composed.statusCode, 200, composed.body);
  assert.deepEqual((composed.json().lines as Array<{ itemCode: string }>).map((l) => l.itemCode), [RETURN, STATE]);
  assert.equal(composed.json().discount.kind, 'none', 'the discount is admin-set at publish, never here');

  // Admin sets a percent; the edited lines still get it.
  await app.db.query(`UPDATE bundles SET discount_percent = 10 WHERE slug = 'harness-first-year'`);
  const c = await client();
  const ret = await bookAmount(RETURN);
  const state = await bookAmount(STATE);
  const res = await app.inject({ method: 'POST', url: '/quotes', headers: auth(ana), payload: {
    contactId: c.contactId, businessId: c.businessId, bundleSlug: 'harness-first-year', asRange: false,
    lines: [{ itemCode: RETURN }, { itemCode: STATE, quantity: 3 }],
  } });
  assert.equal(res.statusCode, 201, res.body);
  const subtotal = ret + state * 3;
  assert.equal(res.json().totalCents, subtotal - Math.round(subtotal / 10), 'the package rule over the lines as they now stand');
  const q = await app.db.query<{ bundle_slug: string; discount_cents: number }>(`SELECT bundle_slug, discount_cents FROM quotes WHERE id = $1`, [res.json().id]);
  assert.equal(q.rows[0]!.bundle_slug, 'harness-first-year');
  assert.equal(q.rows[0]!.discount_cents, Math.round(subtotal / 10));
});
