/*
 * PRICE BOOK v6 AND THE HILO REFERRAL DISCOUNT (Brian, 2026-09-27, R75). Synthetic data only.
 *
 * Two databases, because v6 has two proofs that cannot share a calendar:
 *   ON ITS DATE   v6 published through the version door with the change set as written (effective
 *                 2026-10-01): the prior version closes on that day (in force through 2026-09-30); the
 *                 two 990 lines at the change set's price with BIZ_990's deposit; the discount rule;
 *                 every line keeps its catalog group and every package is copied (two defects of the
 *                 old copy); the R55 check refuses a new line whose deposit exceeds its price.
 *   IN FORCE      the same change set published effective today, so quotes are written under it:
 *                 half off the tax-return and entity lines of a Hilo-referred client's first
 *                 engagement and nothing else; its own line; the deposit on the discounted lines; a
 *                 client not referred, or not on a first engagement, pays full price; recomputed at
 *                 acceptance; the engagement carries the rule and the final-fee invoice shows the line;
 *                 the money line counts it as a discount; the CEO alone removes it, with a reason, and
 *                 nothing widens it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { businessFor, createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { versionRequestFor } from '../src/modules/admin/price-book-change-set.ts';
import { createQuote, sendQuote, acceptQuote } from '../src/modules/pricing/quotes.ts';
import { invoiceForFiledEngagement } from '../src/modules/billing/service.ts';
import { moneyLineToday } from '../src/modules/billing/money-digest.ts';
import { todayChicago } from '../src/modules/tax/deadlines.ts';
import { EXPLICIT_ONLY_PERMISSIONS } from '../src/plugins/auth.ts';
// @ts-expect-error — the change set is plain JavaScript data under packages/db, where the book lives.
import { PRICE_BOOK_V6 } from '../../../packages/db/seeds/data/price_book_v6.mjs';

/** The CEO as the service functions take an actor (the routes build the same shape from the session). */
const asActor = (s: TestStaff) => ({ id: s.id, email: s.email, fullName: 'Synthetic CEO', roleKey: 'ceo' as const, permissions: ['*'], sessionId: 'test' });
const silent: Mailer = { transport: 'console', async send() { return { id: 'x' }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(app: FastifyInstance, config: Config, email: string, role: string, name: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

let dated: FastifyInstance; let datedConfig: Config; let datedCeo: TestStaff & { token: string };
let now: FastifyInstance; let nowConfig: Config; let ceo: TestStaff & { token: string }; let preparer: TestStaff & { token: string };

before(async () => {
  datedConfig = await createTestConfig('price_book_v6_dated');
  dated = buildServer(datedConfig, { mailer: silent });
  await dated.ready();
  datedCeo = await staffWithToken(dated, datedConfig, 'ceo-v6d@example.test', 'ceo', 'Synthetic CEO');

  nowConfig = await createTestConfig('price_book_v6_now');
  now = buildServer(nowConfig, { mailer: silent });
  await now.ready();
  ceo = await staffWithToken(now, nowConfig, 'ceo-v6@example.test', 'ceo', 'Synthetic CEO');
  preparer = await staffWithToken(now, nowConfig, 'prep-v6@example.test', 'tax_preparer', 'Synthetic Preparer');
  // v6, effective today in this database, through the same door.
  const body = await versionRequestFor(now.db, PRICE_BOOK_V6, { effectiveFrom: todayChicago() });
  const res = await now.inject({ method: 'POST', url: '/admin/price-book/versions', headers: auth(ceo), payload: body });
  assert.equal(res.statusCode, 201, res.body);
});
after(async () => { await dated.close(); await now.close(); });

test('R55 applies to a new line: a deposit above its price is refused by name, and nothing is written', async () => {
  const body = await versionRequestFor(dated.db, PRICE_BOOK_V6);
  const tooCheap = { ...body, additions: body.additions.map((a) => (a.itemCode === 'BIZ_990T' ? { ...a, amountCents: 100 } : a)) };
  const before = await dated.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM price_book_versions`);
  const res = await dated.inject({ method: 'POST', url: '/admin/price-book/versions', headers: auth(datedCeo), payload: tooCheap });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error, 'deposit_over_price');
  assert.match(res.json().message, /BIZ_990T/);
  const afterRes = await dated.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM price_book_versions`);
  assert.equal(afterRes.rows[0]!.n, before.rows[0]!.n, 'no version written');
});

test('v6 on its date: the prior version closes 2026-10-01 (in force through 2026-09-30); the 990-PF and 990-T lines; the rule; groups and packages carried whole', async () => {
  const prior = await dated.db.query<{ id: string; version_number: number }>(`SELECT id, version_number FROM price_book_versions ORDER BY version_number DESC LIMIT 1`);
  const body = await versionRequestFor(dated.db, PRICE_BOOK_V6);
  assert.equal(body.effectiveFrom, '2026-10-01');
  const res = await dated.inject({ method: 'POST', url: '/admin/price-book/versions', headers: auth(datedCeo), payload: body });
  assert.equal(res.statusCode, 201, res.body);
  const v6 = res.json() as { id: string; versionNumber: number };
  assert.equal(v6.versionNumber, prior.rows[0]!.version_number + 1);
  const closes = await dated.db.query<{ effective_to: string; last_day: string }>(
    `SELECT effective_to::text AS effective_to, (effective_to - 1)::text AS last_day FROM price_book_versions WHERE id = $1`, [prior.rows[0]!.id]);
  assert.equal(closes.rows[0]!.effective_to, '2026-10-01');
  assert.equal(closes.rows[0]!.last_day, '2026-09-30', 'the prior book is in force through 2026-09-30');

  const lines = await dated.db.query<{ item_code: string; amount_cents: number; deposit_cents: number | null; group_key: string | null; pricing_mode: string; service_line: string }>(
    `SELECT item_code, amount_cents, deposit_cents, group_key, pricing_mode::text AS pricing_mode, service_line::text AS service_line
       FROM price_book_items WHERE version_id = $1 AND item_code IN ('BIZ_990', 'BIZ_990PF', 'BIZ_990T') ORDER BY sort_order`, [v6.id]);
  const byCode = new Map(lines.rows.map((r) => [r.item_code, r]));
  const at = (c: string) => byCode.get(c)!;
  for (const code of ['BIZ_990PF', 'BIZ_990T']) {
    const a = PRICE_BOOK_V6.additions.find((x: { itemCode: string }) => x.itemCode === code);
    assert.equal(at(code).amount_cents, a.amountCents, `${code} at the change set's price`);
    assert.equal(at(code).pricing_mode, 'flat');
    assert.equal(at(code).deposit_cents, at('BIZ_990').deposit_cents, `${code}: the same deposit as BIZ_990`);
    assert.equal(at(code).group_key, 'business_returns');
    assert.equal(at(code).service_line, 'business_tax');
  }
  assert.deepEqual(lines.rows.map((r) => r.item_code), ['BIZ_990', 'BIZ_990PF', 'BIZ_990T'], 'beside BIZ_990 in the catalog');

  const rule = await dated.db.query<{ rule_code: string; percent_rate: string; lines: string[]; condition: string; scope: string }>(
    `SELECT rule_code, percent_rate::text AS percent_rate, applies_to_service_lines::text[] AS lines, condition, scope
       FROM price_book_discount_rules WHERE version_id = $1`, [v6.id]);
  assert.equal(rule.rows.length, 1);
  assert.equal(Number(rule.rows[0]!.percent_rate), 50);
  assert.deepEqual(rule.rows[0]!.lines.sort(), ['business_tax', 'entity_services', 'individual_tax']);
  assert.equal(rule.rows[0]!.condition, 'referred_by_hilo');
  assert.equal(rule.rows[0]!.scope, 'first_engagement');

  const groups = await dated.db.query<{ same: boolean }>(
    `SELECT bool_and(n.group_key IS NOT DISTINCT FROM o.group_key) AS same
       FROM price_book_items o JOIN price_book_items n ON n.item_code = o.item_code AND n.version_id = $2
      WHERE o.version_id = $1`, [prior.rows[0]!.id, v6.id]);
  assert.equal(groups.rows[0]!.same, true, 'every copied line keeps its catalog group');
  // R81 (0133): the display names are presentation metadata too, and ride every copy.
  const names = await dated.db.query<{ same: boolean; single: string | null }>(
    `SELECT bool_and(n.display_name_en IS NOT DISTINCT FROM o.display_name_en AND n.display_name_es IS NOT DISTINCT FROM o.display_name_es) AS same,
            max(n.display_name_en) FILTER (WHERE n.item_code = 'IND_BASE_SINGLE') AS single
       FROM price_book_items o JOIN price_book_items n ON n.item_code = o.item_code AND n.version_id = $2
      WHERE o.version_id = $1`, [prior.rows[0]!.id, v6.id]);
  assert.equal(names.rows[0]!.same, true, 'every copied line keeps its display name');
  assert.equal(names.rows[0]!.single, 'Form 1040 — Single');
  const packages = await dated.db.query<{ version_id: string; bundles: number; components: number }>(
    `SELECT b.version_id, count(DISTINCT b.id)::int AS bundles, count(c.id)::int AS components
       FROM bundles b LEFT JOIN bundle_components c ON c.bundle_id = b.id
      WHERE b.version_id IN ($1, $2) GROUP BY b.version_id`, [prior.rows[0]!.id, v6.id]);
  const of = (v: string) => packages.rows.find((r) => r.version_id === v) ?? { bundles: 0, components: 0 };
  assert.ok(of(prior.rows[0]!.id).bundles > 0, 'the prior version has packages to carry');
  assert.equal(of(v6.id).bundles, of(prior.rows[0]!.id).bundles, 'every package carried');
  assert.equal(of(v6.id).components, of(prior.rows[0]!.id).components, 'with every component');

  const audit = await dated.db.query<{ details: { additions: string[]; discount_rules: Array<{ code: string }> } }>(
    `SELECT details FROM audit_log WHERE action = 'price_book.version_created' AND object_id = $1`, [v6.id]);
  assert.deepEqual(audit.rows[0]!.details.additions, ['BIZ_990PF', 'BIZ_990T']);
  assert.equal(audit.rows[0]!.details.discount_rules[0]!.code, 'HILO_REFERRAL');
});

/* ─── the discount, with v6 in force ─── */

async function item(line: string, extra = ''): Promise<{ code: string; amount: number; deposit: number | null }> {
  const { rows } = await now.db.query<{ item_code: string; amount_cents: number; deposit_cents: number | null }>(
    `SELECT pbi.item_code, pbi.amount_cents, pbi.deposit_cents
       FROM price_book_items pbi JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
        AND pbi.is_active AND pbi.display_on_quote AND pbi.pricing_mode = 'flat' AND pbi.amount_cents > 0
        AND pbi.service_line = $1::price_service_line ${extra}
      ORDER BY pbi.sort_order, pbi.item_code LIMIT 1`, [line]);
  assert.ok(rows[0], `the book in force has a flat ${line} line`);
  return { code: rows[0]!.item_code, amount: rows[0]!.amount_cents, deposit: rows[0]!.deposit_cents };
}
let seq = 0;
async function referredClient(referred = true): Promise<string> {
  seq += 1;
  const c = await makeContact(now.db, { firstName: 'Synthetic', lastName: `Hilo${seq}`, email: `hilo-${seq}@example.test` });
  if (referred) await now.db.query(`UPDATE contacts SET br1_referred_by_hilo = true WHERE id = $1`, [c.id]);
  return c.id;
}

test('a Hilo-referred client\'s first quote: half off the tax-return line, not the recurring line; its own line; the deposit on the discounted total; the client reads it', async () => {
  const ind = await item('individual_tax', `AND pbi.item_code = 'IND_BASE_SINGLE'`);
  const rec = await item('recurring_accounting');
  const contactId = await referredClient();
  const q = await createQuote(now, { contactId, businessId: await businessFor(now.db, contactId), lines: [{ itemCode: ind.code }, { itemCode: rec.code }] }, asActor(ceo));
  const row = await now.db.query<{ subtotal_cents: number; referral_discount_cents: number; total_cents: number; referral_discount_label_en: string }>(
    `SELECT subtotal_cents, referral_discount_cents, total_cents, referral_discount_label_en FROM quotes WHERE id = $1`, [q.id]);
  const r = row.rows[0]!;
  assert.equal(r.subtotal_cents, ind.amount + rec.amount);
  assert.equal(r.referral_discount_cents, Math.round(ind.amount / 2), 'half of the tax-return line, none of the recurring line');
  assert.equal(r.total_cents, ind.amount + rec.amount - Math.round(ind.amount / 2));
  assert.equal(r.referral_discount_label_en, 'Hilo referral discount');

  const staffView = await now.inject({ method: 'GET', url: `/quotes/${q.id}`, headers: auth(ceo) });
  const expectedDeposit = Math.round((ind.deposit ?? 0) / 2) + (rec.deposit ?? 0);
  assert.equal(staffView.json().deposit.standardCents, expectedDeposit, 'the deposit is computed on the discounted lines');

  const sent = await sendQuote(now, q.id, asActor(ceo));
  const pub = await now.inject({ method: 'GET', url: `/public/quote/${sent.url.split('/').pop()}` });
  const view = pub.json() as { referralDiscount: { labelEn: string; labelEs: string; rate: number; cents: number } | null; lines: Array<{ item_code: string; referral_reached: boolean }>; deposit: { dueCents: number } };
  assert.deepEqual(view.referralDiscount, { labelEn: 'Hilo referral discount', labelEs: 'Descuento por referencia de Hilo', rate: 50, cents: Math.round(ind.amount / 2) });
  assert.deepEqual(view.lines.map((l) => [l.item_code, l.referral_reached]), [[ind.code, true], [rec.code, false]]);
  assert.equal(view.deposit.dueCents, expectedDeposit);
});

test('no discount for a client Hilo did not refer, nor on a referred client\'s second engagement; the builder\'s preview says why', async () => {
  const ind = await item('individual_tax', `AND pbi.item_code = 'IND_BASE_SINGLE'`);
  const plain = await referredClient(false);
  const q1 = await createQuote(now, { contactId: plain, lines: [{ itemCode: ind.code }] }, asActor(ceo));
  const r1 = await now.db.query<{ c: number; code: string | null }>(`SELECT referral_discount_cents AS c, referral_discount_rule_code AS code FROM quotes WHERE id = $1`, [q1.id]);
  assert.deepEqual(r1.rows[0], { c: 0, code: null });
  const why1 = await now.inject({ method: 'GET', url: `/quotes/referral-discount?contactId=${plain}`, headers: auth(ceo) });
  assert.deepEqual(why1.json(), { applies: false, why: 'not_referred_by_hilo' });

  const second = await referredClient();
  // R78: the earlier engagement is tax work (a line the rule reaches), so this one is not the first.
  await now.db.query(`INSERT INTO engagements (contact_id, service_line, title, status, ended_on) VALUES ($1, 'tax', 'Earlier return', 'completed', CURRENT_DATE)`, [second]);
  const q2 = await createQuote(now, { contactId: second, lines: [{ itemCode: ind.code }] }, asActor(ceo));
  const r2 = await now.db.query<{ c: number }>(`SELECT referral_discount_cents AS c FROM quotes WHERE id = $1`, [q2.id]);
  assert.equal(r2.rows[0]!.c, 0, 'not the first engagement: full price');
  const why2 = await now.inject({ method: 'GET', url: `/quotes/referral-discount?contactId=${second}`, headers: auth(ceo) });
  assert.deepEqual(why2.json(), { applies: false, why: 'not_first_engagement' });

  const first = await referredClient();
  const yes = await now.inject({ method: 'GET', url: `/quotes/referral-discount?contactId=${first}`, headers: auth(ceo) });
  assert.equal(yes.json().applies, true);
  assert.equal(yes.json().rule.rate, 50);
});

test('R78: a prior bookkeeping-only engagement does not consume the discount, and a withdrawn engagement never does', async () => {
  const ind = await item('individual_tax', `AND pbi.item_code = 'IND_BASE_SINGLE'`);
  const half = Math.round(ind.amount / 2);

  // Bookkeeping only before: no eligible line, so the first tax engagement is still ahead.
  const books = await referredClient();
  await now.db.query(`INSERT INTO engagements (contact_id, service_line, title, status) VALUES ($1, 'bookkeeping', 'Monthly books', 'active')`, [books]);
  const preview = await now.inject({ method: 'GET', url: `/quotes/referral-discount?contactId=${books}`, headers: auth(ceo) });
  assert.equal(preview.json().applies, true, 'the builder offers it');
  const q1 = await createQuote(now, { contactId: books, lines: [{ itemCode: ind.code }] }, asActor(ceo));
  const r1 = await now.db.query<{ c: number }>(`SELECT referral_discount_cents AS c FROM quotes WHERE id = $1`, [q1.id]);
  assert.equal(r1.rows[0]!.c, half, 'half off: bookkeeping did not consume the first engagement');
  const s1 = await sendQuote(now, q1.id, asActor(ceo));
  await acceptQuote(now, s1.url.split('/').pop()!, {});
  const a1 = await now.db.query<{ c: number; code: string | null }>(`SELECT referral_discount_cents AS c, referral_discount_rule_code AS code FROM quotes WHERE id = $1`, [q1.id]);
  assert.deepEqual(a1.rows[0], { c: half, code: 'HILO_REFERRAL' }, 'and it holds at acceptance, where the same test runs again');

  // A withdrawn tax engagement before: it never happened, so it consumes nothing.
  const withdrawn = await referredClient();
  await now.db.query(`INSERT INTO engagements (contact_id, service_line, title, status, ended_on, close_reason) VALUES ($1, 'tax', 'Withdrawn return', 'withdrawn', CURRENT_DATE, 'Synthetic: withdrawn before any work')`, [withdrawn]);
  const q2 = await createQuote(now, { contactId: withdrawn, lines: [{ itemCode: ind.code }] }, asActor(ceo));
  const r2 = await now.db.query<{ c: number }>(`SELECT referral_discount_cents AS c FROM quotes WHERE id = $1`, [q2.id]);
  assert.equal(r2.rows[0]!.c, half, 'half off: a withdrawn engagement never consumes it');
});

test('removal: the CEO alone, with a reason; the total and the deposit return to the book; nothing widens it', async () => {
  assert.ok(EXPLICIT_ONLY_PERMISSIONS.has('quotes.referral_discount.remove'), 'the wildcard does not reach it');
  const holders = await now.db.query<{ key: string }>(
    `SELECT r.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission = 'quotes.referral_discount.remove'`);
  assert.deepEqual(holders.rows.map((r) => r.key), ['ceo'], 'seeded to the CEO alone');
  const ind = await item('individual_tax', `AND pbi.item_code = 'IND_BASE_SINGLE'`);
  const contactId = await referredClient();
  const q = await createQuote(now, { contactId, lines: [{ itemCode: ind.code }] }, asActor(ceo));
  const url = `/quotes/${q.id}/referral-discount/remove`;

  const refused = await now.inject({ method: 'POST', url, headers: auth(preparer), payload: { reason: 'Synthetic: the preparer tries the CEO door.' } });
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().message, 'This session does not hold quotes.referral_discount.remove.');
  const noReason = await now.inject({ method: 'POST', url, headers: auth(ceo), payload: {} });
  assert.equal(noReason.statusCode, 400, 'a reason is required');
  const widen = await now.inject({ method: 'POST', url, headers: auth(ceo), payload: { reason: 'Synthetic: trying to set an amount.', amountCents: 1 } });
  assert.equal(widen.statusCode, 400, 'the door takes no amount: nothing widens the discount');

  const ok = await now.inject({ method: 'POST', url, headers: auth(ceo), payload: { reason: 'The referral was a family member of staff; full price agreed.' } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().removedCents, Math.round(ind.amount / 2));
  assert.equal(ok.json().totalCents, ind.amount, 'the total returns to the book');
  assert.equal(ok.json().deposit.standardCents, ind.deposit, 'and the deposit to the book\'s');
  const row = await now.db.query<{ c: number; reason: string; by: string }>(
    `SELECT referral_discount_cents AS c, referral_discount_removed_reason AS reason, referral_discount_removed_by AS by FROM quotes WHERE id = $1`, [q.id]);
  assert.deepEqual(row.rows[0], { c: 0, reason: 'The referral was a family member of staff; full price agreed.', by: ceo.id });
  const audit = await now.db.query(`SELECT 1 FROM audit_log WHERE action = 'quote.referral_discount_removed' AND object_id = $1`, [q.id]);
  assert.equal(audit.rowCount, 1);
  const again = await now.inject({ method: 'POST', url, headers: auth(ceo), payload: { reason: 'The referral was a family member of staff; full price agreed.' } });
  assert.equal(again.statusCode, 409);
});

test('acceptance: recomputed over the chosen lines; the tax engagement carries the rule, the bookkeeping one does not; the final-fee invoice shows the line; the money line counts a discount', async () => {
  const ind = await item('individual_tax', `AND pbi.item_code = 'IND_BASE_SINGLE'`);
  const rec = await item('recurring_accounting');
  const contactId = await referredClient();
  const q = await createQuote(now, { contactId, businessId: await businessFor(now.db, contactId), lines: [{ itemCode: ind.code }, { itemCode: rec.code }] }, asActor(ceo));
  const sent = await sendQuote(now, q.id, asActor(ceo));
  const accepted = await acceptQuote(now, sent.url.split('/').pop()!, {});
  const engs = await now.db.query<{ id: string; service_line: string; code: string | null; rate: string | null }>(
    `SELECT id, service_line::text AS service_line, referral_discount_rule_code AS code, referral_discount_rate::text AS rate
       FROM engagements WHERE contact_id = $1 ORDER BY service_line`, [contactId]);
  const tax = engs.rows.find((e) => e.service_line === 'tax')!;
  const books = engs.rows.find((e) => e.service_line === 'bookkeeping')!;
  assert.equal(tax.code, 'HILO_REFERRAL');
  assert.equal(Number(tax.rate), 50);
  assert.equal(books.code, null, 'the recurring engagement carries nothing');
  const quote = await now.db.query<{ total_cents: number; referral_discount_cents: number }>(`SELECT total_cents, referral_discount_cents FROM quotes WHERE id = $1`, [q.id]);
  assert.equal(quote.rows[0]!.referral_discount_cents, Math.round(ind.amount / 2));
  const deposit = await now.db.query<{ total_cents: number }>(`SELECT total_cents FROM invoices WHERE id = $1`, [accepted.depositInvoiceId]);
  assert.equal(deposit.rows[0]!.total_cents, Math.round((ind.deposit ?? 0) / 2) + (rec.deposit ?? 0), 'the deposit invoice asks the discounted deposit');

  // The return is filed at a final fee; the filed-return factory raises the invoice.
  const te = await now.db.query<{ id: string }>(`SELECT id FROM tax_engagements WHERE engagement_id = $1`, [tax.id]);
  const fee = ind.amount;
  await now.db.query(`UPDATE tax_engagements SET final_fee_cents = $2 WHERE id = $1`, [te.rows[0]!.id, fee]);
  const done = await invoiceForFiledEngagement(now, { staffId: null, label: 'filed automation' }, te.rows[0]!.id);
  assert.equal(done.invoiced, true);
  const inv = await now.db.query<{ id: string; total_cents: number }>(
    `SELECT id, total_cents FROM invoices WHERE tax_engagement_id = $1 ORDER BY created_at DESC LIMIT 1`, [te.rows[0]!.id]);
  const lines = await now.db.query<{ description: string; total_cents: number }>(
    `SELECT description, total_cents FROM invoice_line_items WHERE invoice_id = $1 ORDER BY sort_order`, [inv.rows[0]!.id]);
  const discountLine = lines.rows.find((l) => l.description.startsWith('Hilo referral discount'));
  assert.ok(discountLine, `its own line: ${JSON.stringify(lines.rows)}`);
  assert.equal(discountLine!.description, 'Hilo referral discount (50%)');
  assert.equal(discountLine!.total_cents, -Math.round(fee / 2));
  const recorded = await now.db.query<{ amount_cents: number }>(`SELECT amount_cents FROM invoice_discount_lines WHERE invoice_id = $1`, [inv.rows[0]!.id]);
  assert.equal(recorded.rows[0]!.amount_cents, Math.round(fee / 2));

  const line = await moneyLineToday(now, todayChicago());
  const counted = line.discounts.filter((d) => d.invoiceNumber !== null && d.amountCents === Math.round(fee / 2));
  assert.ok(counted.length >= 1, 'the money line counts it as a discount');
  assert.ok(!line.byStaff.some((a) => a.action === 'Referral discount'), 'never a staff money action');
});
