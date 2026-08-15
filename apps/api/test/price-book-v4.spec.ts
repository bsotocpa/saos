// Price book v4 (Brian, 2026-08-14): deposits separated from service pricing.
//
// "The current sheet conflates deposits with service pricing, which is why the 13
// confirmations have stalled."
//
// Before v4 a deposit was its OWN sellable price-book item and a quote picked exactly
// one via quotes.deposit_item_code, so a multi-line quote could not compose a deposit at
// all. Now `deposit_cents` is an attribute of the line that starts the work and a quote's
// deposit is the SUM of its lines' deposits.
//
// The two rules that are easy to get wrong, and are therefore what these tests are for:
//   · the deposit does NOT multiply with quantity, unlike every price beside it
//   · a quote written under one version keeps quoting that version's deposits
// Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { resolveDeposit } from '../src/modules/pricing/quotes.ts';

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
  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  const res = await app.inject({
    method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code },
  });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

async function draftQuote(
  label: string,
  lines: Array<{ itemCode: string; quantity?: number }>,
  extra: Record<string, unknown> = {}
): Promise<string> {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: label, email: `${label.toLowerCase()}-v4@example.test`,
  });
  const res = await app.inject({
    method: 'POST', url: '/quotes', headers: auth(brian),
    payload: { contactId: c.id, lines, ...extra },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
}

/** The deposit on a price-book line, read from the version in force. */
async function lineDeposit(itemCode: string): Promise<number> {
  const { rows } = await app.db.query<{ deposit_cents: number | null }>(
    `SELECT i.deposit_cents FROM price_book_items i
       JOIN price_book_versions v ON v.id = i.version_id
      WHERE v.effective_to IS NULL AND i.item_code = $1`,
    [itemCode]
  );
  const d = rows[0]?.deposit_cents;
  assert.ok(d !== null && d !== undefined, `${itemCode} should carry a deposit`);
  return d;
}

before(async () => {
  config = await createTestConfig('pbv4');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  brian = await staffWithToken('brian-pbv4@example.test', 'ceo');
});

after(async () => {
  await app.close();
});

test('pricing_mode records intent that was previously only inferable from which column was filled', async () => {
  const { rows } = await app.db.query<{ item_code: string; pricing_mode: string }>(
    `SELECT i.item_code, i.pricing_mode::text AS pricing_mode
       FROM price_book_items i JOIN price_book_versions v ON v.id = i.version_id
      WHERE v.effective_to IS NULL AND i.pricing_mode = 'range'`
  );
  assert.equal(rows.length, 1, 'exactly one seeded line is a range');
  assert.equal(rows[0]!.item_code, 'IND_CPA_LETTER');

  // No line is seeded as hourly: Brian's ruling is that the three per_hour lines
  // migrate as flat rate cards and go to his queue. Confirming them is what would
  // trigger building the mode.
  const hourly = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM price_book_items i JOIN price_book_versions v ON v.id = i.version_id
      WHERE v.effective_to IS NULL AND i.pricing_mode = 'hourly'`
  );
  assert.equal(hourly.rows[0]!.n, 0, 'the enum value exists; nothing constructs it yet');
});

test('the mode CHECK refuses a row whose shape contradicts its mode', async () => {
  const v = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions WHERE effective_to IS NULL LIMIT 1`
  );
  const versionId = v.rows[0]!.id;
  const attempt = async (label: string, cols: string, vals: string): Promise<boolean> => {
    try {
      await app.db.query(
        `INSERT INTO price_book_items (version_id, item_code, service_line, name_en, name_es, ${cols})
         VALUES ($1, $2, 'individual_tax', 'x', 'x', ${vals})`,
        [versionId, `V4TEST_${label}`]
      );
      await app.db.query(`DELETE FROM price_book_items WHERE item_code = $1`, [`V4TEST_${label}`]);
      return true;
    } catch {
      return false;
    }
  };

  assert.equal(await attempt('FLATOK', 'pricing_mode, amount_cents', `'flat', 10000`), true);
  assert.equal(
    await attempt('FLATRANGE', 'pricing_mode, amount_cents, price_min_cents, price_max_cents', `'flat', 10000, 100, 200`),
    false, 'a flat line may not also carry a range'
  );
  assert.equal(await attempt('FLATNONE', 'pricing_mode', `'flat'`), false, 'a flat line must have an amount');
  assert.equal(
    await attempt('RANGEAMT', 'pricing_mode, amount_cents, price_min_cents, price_max_cents', `'range', 5000, 10000, 20000`),
    false, 'a range line may not also carry an amount'
  );
  // hourly is meaningless without a per-hour unit — the two would silently disagree.
  assert.equal(
    await attempt('HOURBAD', 'pricing_mode, amount_cents, unit', `'hourly', 7500, 'flat'`),
    false, 'hourly requires unit = per_hour'
  );
  assert.equal(await attempt('HOUROK', 'pricing_mode, amount_cents, unit', `'hourly', 7500, 'per_hour'`), true);
  assert.equal(
    await attempt('NEGDEP', 'pricing_mode, amount_cents, deposit_cents', `'flat', 10000, -1`),
    false, 'a negative deposit is not a discount'
  );
});

test('a multi-line quote sums its lines’ deposits — the thing the old model could not do', async () => {
  const ind = await lineDeposit('IND_BASE_MFJ');
  const biz = await lineDeposit('BIZ_1120S');

  const quoteId = await draftQuote('Sumtwo', [{ itemCode: 'IND_BASE_MFJ' }, { itemCode: 'BIZ_1120S' }]);
  const resolved = await resolveDeposit(app, null, null, quoteId);

  assert.equal(resolved.standardCents, ind + biz, 'both work-start commitments are asked for');
  assert.equal(resolved.chargeCents, ind + biz);
  assert.equal(resolved.treatment, 'standard');
});

test('the deposit does NOT multiply with quantity, unlike the price beside it', async () => {
  const one = await lineDeposit('IND_BASE_MFJ');

  // Three of the same line. Brian's ruling: "one line = one work-start commitment
  // regardless of units." Reusing the line-total path here would triple it.
  const quoteId = await draftQuote('Qtythree', [{ itemCode: 'IND_BASE_MFJ', quantity: 3 }]);
  const resolved = await resolveDeposit(app, null, null, quoteId);
  assert.equal(resolved.standardCents, one, `qty 3 still asks for one deposit, not ${one * 3}`);

  // And prove the quote genuinely carried qty 3, so this is not passing because the
  // quantity silently failed to apply.
  const { rows } = await app.db.query<{ quantity: string }>(
    `SELECT quantity::text AS quantity FROM quote_line_items WHERE quote_id = $1`, [quoteId]
  );
  assert.equal(Number(rows[0]!.quantity), 3, 'the line really is qty 3');
});

test('a quote of lines that carry no deposit asks for none — which is not the same as zero', async () => {
  const quoteId = await draftQuote('Nodep', [{ itemCode: 'IND_SCH_A' }, { itemCode: 'IND_F8863' }]);
  const resolved = await resolveDeposit(app, null, null, quoteId);
  assert.equal(resolved.standardCents, null, 'no deposit at all');
  assert.equal(resolved.chargeCents, null);
  assert.equal(resolved.treatment, null, 'null treatment, not "waived" — nobody waived anything');
});

test('an override still applies to the SUM, and the treatment stays derived', async () => {
  const ind = await lineDeposit('IND_BASE_MFJ');
  const biz = await lineDeposit('BIZ_1120S');
  const total = ind + biz;
  const quoteId = await draftQuote('Overridesum', [{ itemCode: 'IND_BASE_MFJ' }, { itemCode: 'BIZ_1120S' }]);

  const reduced = await resolveDeposit(app, null, total - 10000, quoteId);
  assert.equal(reduced.standardCents, total, 'the standard is still the summed book figure');
  assert.equal(reduced.chargeCents, total - 10000);
  assert.equal(reduced.treatment, 'reduced');
  assert.equal(reduced.isOverridden, true);

  const waived = await resolveDeposit(app, null, 0, quoteId);
  assert.equal(waived.treatment, 'waived');

  // An "override" that happens to equal the standard is honestly recorded as standard,
  // so A/R is not handed a phantom exception to chase.
  const same = await resolveDeposit(app, null, total, quoteId);
  assert.equal(same.treatment, 'standard');
  assert.equal(same.isOverridden, false);
});

test('the deposit follows the quote’s LOCKED version, not whatever the book says today', async () => {
  const original = await lineDeposit('IND_BASE_MFJ');
  const quoteId = await draftQuote('Locked', [{ itemCode: 'IND_BASE_MFJ' }]);

  // A new version HALVES the deposit, effective tomorrow. Halved, not doubled: these
  // lines are full prepay, so doubling would put the deposit above the price and the
  // 0053 constraint would refuse it — correctly.
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const res = await app.inject({
    method: 'POST', url: '/admin/price-book/versions', headers: auth(brian),
    payload: {
      effectiveFrom: tomorrow,
      note: 'synthetic deposit change',
      changes: [{ itemCode: 'IND_BASE_MFJ', depositCents: Math.round(original / 2) }],
    },
  });
  assert.equal(res.statusCode, 201, res.body);

  const resolved = await resolveDeposit(app, null, null, quoteId);
  assert.equal(resolved.standardCents, original, 'the quote keeps the deposit it was written with');

  // And the new version really did carry the change — otherwise the assertion above
  // would pass for the wrong reason.
  const { rows } = await app.db.query<{ deposit_cents: number }>(
    `SELECT i.deposit_cents FROM price_book_items i JOIN price_book_versions v ON v.id = i.version_id
      WHERE i.item_code = 'IND_BASE_MFJ' ORDER BY v.version_number DESC LIMIT 1`
  );
  assert.equal(rows[0]!.deposit_cents, Math.round(original / 2), 'the new version has the halved deposit');
});

test('a new version carries pricing_mode and deposit_cents forward instead of resetting them', async () => {
  // The version copy lists every column explicitly, so a field added to the table and
  // not to that INSERT is silently reset to its default one version later.
  const { rows } = await app.db.query<{ version_number: number; n_deposits: number; n_range: number }>(
    `SELECT v.version_number,
            count(*) FILTER (WHERE i.deposit_cents IS NOT NULL)::int AS n_deposits,
            count(*) FILTER (WHERE i.pricing_mode = 'range')::int    AS n_range
       FROM price_book_versions v JOIN price_book_items i ON i.version_id = v.id
      GROUP BY v.version_number ORDER BY v.version_number`
  );
  assert.ok(rows.length >= 2, 'the previous test created a second version');
  const [first, second] = [rows[0]!, rows[rows.length - 1]!];
  assert.ok(first.n_deposits > 0, 'v1 seeds deposits');
  assert.equal(second.n_deposits, first.n_deposits, 'the copy kept every deposit');
  assert.equal(second.n_range, first.n_range, 'and kept the range mode');
});

/*
 * The deposit items were briefly left ACTIVE and flagged, because retiring them broke
 * Lane 1 — the booking flow invoiced them directly. Brian then ruled: "retire the
 * direct-deposit invoice path entirely ... deposits exist ONLY on accepted quotes.
 * Discovery and all bookings are free." The rows survive because two accepted quotes are
 * price-locked against DEPOSIT_1040 and must keep reading true.
 */
test('the retired deposit items are unsellable, and their questions are answered', async () => {
  const { rows } = await app.db.query<{
    item_code: string; is_active: boolean;
    needs_confirmation: boolean; structure_needs_confirmation: boolean;
  }>(
    `SELECT i.item_code, i.is_active, i.needs_confirmation, i.structure_needs_confirmation
       FROM price_book_items i JOIN price_book_versions v ON v.id = i.version_id
      WHERE v.effective_to IS NULL AND i.service_line = 'deposit' ORDER BY i.item_code`
  );
  assert.equal(rows.length, 2, 'both rows survive — deleting them would rewrite history');
  for (const r of rows) {
    assert.equal(r.is_active, false, `${r.item_code} cannot be sold or invoiced`);
    // Brian's ruling ANSWERED both questions these carried, so they must not still sit
    // in his queue asking something he has decided.
    assert.equal(r.needs_confirmation, false, `${r.item_code}: the price question is answered`);
    assert.equal(r.structure_needs_confirmation, false, `${r.item_code}: and the structure question`);
  }

  // And the legacy read still resolves one for a pre-v4 quote whose own lines carry no
  // deposit — the two accepted quotes price-locked against DEPOSIT_1040 depend on it.
  const quoteId = await draftQuote('Legacy', [{ itemCode: 'IND_SCH_A' }]);
  const legacy = await resolveDeposit(app, 'DEPOSIT_1040', null, quoteId);
  assert.ok(legacy.standardCents && legacy.standardCents > 0, 'a historical quote still resolves its deposit');
  assert.match(legacy.label, /1040/, 'and still names the item it was quoted under');
});

test('a structure question does NOT make a quote provisional the way a price question does', async () => {
  // IND_BASE_MFJ carries a flagged DEPOSIT but a settled PRICE. Overloading one flag for
  // both marked every 1040 quote as having an unconfirmed price, which was wrong.
  const { rows } = await app.db.query<{ needs: boolean; structure: boolean }>(
    `SELECT i.needs_confirmation AS needs, i.structure_needs_confirmation AS structure
       FROM price_book_items i JOIN price_book_versions v ON v.id = i.version_id
      WHERE v.effective_to IS NULL AND i.item_code = 'IND_BASE_MFJ'`
  );
  assert.equal(rows[0]!.structure, true, 'its deposit assignment awaits a ruling');
  assert.equal(rows[0]!.needs, false, 'its $200 price does not');

  const quoteId = await draftQuote('Provisional', [{ itemCode: 'IND_BASE_MFJ' }]);
  const res = await app.inject({ method: 'GET', url: `/quotes/${quoteId}`, headers: auth(brian) });
  assert.equal(res.statusCode, 200, res.body);
  const flagged = JSON.stringify(res.json()).includes('"needsConfirmation":true');
  assert.equal(flagged, false, 'the quote does not report an unconfirmed price');
});

test('confirming the price and confirming the structure are separate taps', async () => {
  const code = 'IND_BASE_HOH';
  // Confirming the structure clears ONLY the structure flag.
  const res = await app.inject({
    method: 'POST', url: `/admin/price-book/items/${code}/confirm?kind=structure`, headers: auth(brian),
  });
  assert.equal(res.statusCode, 200, res.body);
  const after = await app.db.query<{ needs: boolean; structure: boolean }>(
    `SELECT i.needs_confirmation AS needs, i.structure_needs_confirmation AS structure
       FROM price_book_items i
      WHERE i.item_code = $1 AND i.version_id = (SELECT id FROM price_book_versions ORDER BY version_number DESC LIMIT 1)`,
    [code]
  );
  assert.equal(after.rows[0]!.structure, false, 'the deposit question is answered');

  // Re-confirming the same question is a 404, not a silent success.
  const again = await app.inject({
    method: 'POST', url: `/admin/price-book/items/${code}/confirm?kind=structure`, headers: auth(brian),
  });
  assert.equal(again.statusCode, 404, 'already confirmed');
});

/*
 * A deposit may EQUAL the price — Brian confirmed full prepay on small engagements as
 * intentional — but never exceed it. Price book v4 asked $250 on base returns priced
 * $150–$200, so a single filer would have prepaid $250 for a $150 engagement and been
 * owed $100 back before any work began. The v4 script carried the old deposit amount
 * across without asking whether a deposit could be bigger than the thing it deposits on.
 */
test('a deposit may equal the price but never exceed it — and only flat lines are compared', async () => {
  const versionId = (
    await app.db.query<{ id: string }>(`SELECT id FROM price_book_versions WHERE effective_to IS NULL LIMIT 1`)
  ).rows[0]!.id;

  const attempt = async (label: string, unit: string, amount: number, deposit: number): Promise<boolean> => {
    try {
      await app.db.query(
        `INSERT INTO price_book_items (version_id, item_code, service_line, name_en, name_es,
                                       pricing_mode, unit, amount_cents, deposit_cents)
         VALUES ($1, $2, 'individual_tax', 'x', 'x', 'flat', $3::price_unit, $4, $5)`,
        [versionId, `VDEP_${label}`, unit, amount, deposit]
      );
      await app.db.query(`DELETE FROM price_book_items WHERE item_code = $1`, [`VDEP_${label}`]);
      return true;
    } catch {
      return false;
    }
  };

  assert.equal(await attempt('UNDER', 'flat', 20000, 5000), true, 'a deposit below the price is normal');
  assert.equal(await attempt('EQUAL', 'flat', 20000, 20000), true, 'full prepay is the LIMIT, not a violation');
  assert.equal(await attempt('OVER', 'flat', 15000, 25000), false, 'exactly the v4 defect: $250 on a $150 line');
  // A per-hour line has no total until it is quoted, so its deposit is legitimately
  // larger than its unit price — ACCT_CATCHUP_HOURLY is $75/hr with a $200 deposit.
  assert.equal(await attempt('HOURLY', 'per_hour', 7500, 20000), true, 'per-unit lines are not compared');
});
