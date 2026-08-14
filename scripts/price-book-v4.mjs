#!/usr/bin/env node
/**
 * PRICE BOOK v4 — deposits separated from service pricing (Brian, 2026-08-14).
 *
 * "The current sheet conflates deposits with service pricing, which is why the 13
 * confirmations have stalled." Shipped, in his words, "as effective-dated v4 with
 * migration".
 *
 * WHY THIS SCRIPT EXISTS AT ALL. Migration 0050 adds the columns and backfills
 * pricing_mode across every version. The SEED sets deposits and structure flags — but
 * the seed only ever writes v1, and the book in force is v3. So after the migration and
 * a deploy, the live book had the new columns and no deposits in them: the admin page
 * showed "no deposit" on every line and thirteen price flags, which is exactly what it
 * looked like before the work. Schema plus seed is not a data migration.
 *
 * A NEW VERSION, never an in-place edit — the same rule as the GATE 2 reclassification.
 * Quotes PIN a price-book version, so editing v3 in place would retroactively change
 * what already-quoted clients were told. v4 leaves every historical quote reading
 * exactly as it did.
 *
 * NO PRICE CHANGES. Amounts, ranges, units and price-confirmation flags are copied
 * forward untouched. Only deposit_cents and the structure flags are written, and the two
 * deposit amounts are carried from the existing DEPOSIT_1040 / DEPOSIT_BUSINESS_TAX
 * items rather than typed here — this file contains no dollar literal, and
 * `npm run check:prices` would fail if it did.
 *
 * EVERYTHING IT WRITES IS FLAGGED. Brian: "flag any line where deposit-vs-price is
 * ambiguous rather than guessing; those land in my confirmation queue with the 13."
 * These placements preserve today's behaviour for the ordinary single-return quote, but
 * WHICH lines carry a deposit is a pricing decision, so every one is queued for him.
 *
 * USAGE (inside saos-api-1, or locally against the dev DB):
 *   node price-book-v4.mjs            # dry run — prints the plan, writes nothing
 *   node price-book-v4.mjs --execute  # create v4
 */

import pg from 'pg';

const EXECUTE = process.argv.includes('--execute');

/*
 * Lines that START AN ENGAGEMENT carry the deposit; add-ons do not. A client adding a
 * second state or another K-1 is not starting a second piece of work.
 *
 * BIZ_SCH_C is deliberately absent: a Schedule C is a schedule on someone's 1040, not a
 * separate entity return, so its deposit is the 1040's. Giving it one would ask a sole
 * proprietor for both deposits where today they are asked for one.
 */
const INDIVIDUAL_BASE = ['IND_BASE_SINGLE', 'IND_BASE_MFJ', 'IND_BASE_MFS', 'IND_BASE_HOH'];
const ENTITY_RETURNS = [
  'BIZ_1065', 'BIZ_1120S', 'BIZ_1120', 'BIZ_990',
  'BIZ_1120C', 'BIZ_1120F', 'BIZ_1120H', 'BIZ_1120POL',
];
/** Already priced per hour. Brian corrected his own "we don't bill hourly today". */
const HOURLY_LINES = ['IND_SPECIALIZED_HOURLY', 'ACCT_CATCHUP_HOURLY', 'RES_BOOKS_RECONSTRUCTION'];
/** The two items that modelled a deposit as a sellable service. */
const DEPOSIT_ITEMS = ['DEPOSIT_1040', 'DEPOSIT_BUSINESS_TAX'];

const NOTE_IND =
  '⚠ v4 deposit split: carried from the DEPOSIT_1040 item. Confirm this line should ask for a deposit, and the amount.';
const NOTE_BIZ =
  '⚠ v4 deposit split: carried from the DEPOSIT_BUSINESS_TAX item. Confirm this line should ask for a deposit, and the amount. A quote with two entity returns now asks for two deposits.';
const NOTE_HOURLY =
  '⚠ v4 mode: priced per hour. Confirm this is a rate card (a flat amount, quoted per hour) rather than tracked time-and-materials. Confirming it as true hourly is what triggers building pricing_mode = hourly.';
const NOTE_DEPOSIT_ITEM =
  '⚠ v4: a SECOND deposit path. Quote deposits now come from the service lines, but Lane 1 (New Client Discovery booking) still bills this item directly — no quote, nothing to sum. Confirm whether the booking-time discovery deposit stays, or deposits are collected only at quote acceptance as your brief said.';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const current = await db.query(
  `SELECT id, version_number, effective_from
     FROM price_book_versions
    WHERE effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
    ORDER BY version_number DESC LIMIT 1`
);
if (current.rows.length === 0) {
  console.error('No price book version in force.');
  await db.end();
  process.exit(1);
}
const from = current.rows[0];
console.log(`in force: v${from.version_number} (${String(from.effective_from).slice(0, 10)})`);

// The deposit AMOUNTS come from the book, never from this file.
const deposits = await db.query(
  `SELECT item_code, amount_cents FROM price_book_items
    WHERE version_id = $1 AND item_code = ANY($2)`,
  [from.id, DEPOSIT_ITEMS]
);
const byCode = new Map(deposits.rows.map((r) => [r.item_code, r.amount_cents]));
const indCents = byCode.get('DEPOSIT_1040');
const bizCents = byCode.get('DEPOSIT_BUSINESS_TAX');
if (indCents == null || bizCents == null) {
  console.error('Deposit items missing from the book in force — cannot derive the amounts.');
  await db.end();
  process.exit(1);
}

const plan = [
  ...INDIVIDUAL_BASE.map((code) => ({ code, deposit: indCents, note: NOTE_IND })),
  ...ENTITY_RETURNS.map((code) => ({ code, deposit: bizCents, note: NOTE_BIZ })),
  ...HOURLY_LINES.map((code) => ({ code, deposit: null, note: NOTE_HOURLY })),
  ...DEPOSIT_ITEMS.map((code) => ({ code, deposit: null, note: NOTE_DEPOSIT_ITEM })),
];

// Refuse to proceed on a code that is not in the book: a silent no-op here would look
// like success and ship a v4 missing half its deposits.
const present = await db.query(
  `SELECT item_code FROM price_book_items WHERE version_id = $1 AND item_code = ANY($2)`,
  [from.id, plan.map((p) => p.code)]
);
const found = new Set(present.rows.map((r) => r.item_code));
const missing = plan.map((p) => p.code).filter((c) => !found.has(c));
if (missing.length > 0) {
  console.error(`Not in v${from.version_number}: ${missing.join(', ')}`);
  await db.end();
  process.exit(1);
}

console.log(`\nPlan — ${plan.length} lines flagged for Brian, no prices changed:`);
for (const p of plan) {
  const d = p.deposit === null ? 'no deposit' : `deposit ${(p.deposit / 100).toFixed(2)}`;
  console.log(`  ${p.code.padEnd(26)} ${d}`);
}

if (!EXECUTE) {
  console.log('\nDRY RUN — nothing written. Re-run with --execute.');
  await db.end();
  process.exit(0);
}

/*
 * price_book_versions enforces CHECK (effective_to IS NULL OR effective_to > effective_from),
 * so a version cannot open and close on the same date — AT MOST ONE VERSION PER DAY. If the
 * version in force also started today, v4 starts TOMORROW and today's book is left exactly
 * as it is, so nothing quoted today shifts underneath anyone. Asked of the DATABASE rather
 * than compared in JS, because node-postgres hands back a Date.
 */
const startsToday = await db.query(
  `SELECT (effective_from = CURRENT_DATE) AS today FROM price_book_versions WHERE id = $1`,
  [from.id]
);
const EFFECTIVE = startsToday.rows[0].today ? `CURRENT_DATE + 1` : `CURRENT_DATE`;

const client = await db.connect();
try {
  await client.query('BEGIN');

  const next = await client.query(
    `INSERT INTO price_book_versions (version_number, effective_from, effective_to, note)
     VALUES ($1, ${EFFECTIVE}, NULL, $2)
     RETURNING id, version_number, effective_from`,
    [
      from.version_number + 1,
      'v4 (Brian, 2026-08-14): deposits separated from service pricing. Deposit moves onto ' +
        'the service line that starts the work; a quote deposit is the sum of its lines. ' +
        'No prices changed; every placement flagged for confirmation.',
    ]
  );
  const to = next.rows[0];

  // Full copy, every column named — anything omitted here silently resets to its default.
  await client.query(
    `INSERT INTO price_book_items
       (version_id, item_code, service_line, name_en, name_es, description_en, description_es,
        amount_cents, price_min_cents, price_max_cents, unit, is_pass_through, display_on_quote,
        needs_confirmation, confirmation_note, is_active, sort_order, metadata,
        pricing_mode, deposit_cents, structure_needs_confirmation, structure_confirmation_note)
     SELECT $1, item_code, service_line, name_en, name_es, description_en, description_es,
            amount_cents, price_min_cents, price_max_cents, unit, is_pass_through, display_on_quote,
            needs_confirmation, confirmation_note, is_active, sort_order, metadata,
            pricing_mode, deposit_cents, structure_needs_confirmation, structure_confirmation_note
       FROM price_book_items WHERE version_id = $2`,
    [to.id, from.id]
  );
  await client.query(
    `INSERT INTO bundle_rules
       (version_id, rule_code, rule_type, description_en, description_es, component_item_codes,
        bundle_price_cents, condition_item_code, is_active)
     SELECT $1, rule_code, rule_type, description_en, description_es, component_item_codes,
            bundle_price_cents, condition_item_code, is_active
       FROM bundle_rules WHERE version_id = $2`,
    [to.id, from.id]
  );

  for (const p of plan) {
    const res = await client.query(
      `UPDATE price_book_items
          SET deposit_cents = $3,
              structure_needs_confirmation = true,
              structure_confirmation_note = $4
        WHERE version_id = $1 AND item_code = $2`,
      [to.id, p.code, p.deposit, p.note]
    );
    if (res.rowCount !== 1) throw new Error(`expected exactly one row for ${p.code}, got ${res.rowCount}`);
  }

  await client.query(`UPDATE price_book_versions SET effective_to = ${EFFECTIVE} WHERE id = $1`, [from.id]);
  await client.query('COMMIT');

  // READ BACK what actually landed, rather than reporting what was intended.
  const check = await db.query(
    `SELECT count(*) FILTER (WHERE deposit_cents IS NOT NULL)::int          AS with_deposit,
            count(*) FILTER (WHERE structure_needs_confirmation)::int       AS structure_flagged,
            count(*) FILTER (WHERE needs_confirmation)::int                 AS price_flagged,
            count(*)::int                                                   AS items
       FROM price_book_items WHERE version_id = $1`,
    [to.id]
  );
  const c = check.rows[0];
  console.log(
    `\n✓ v${to.version_number} created, effective ${String(to.effective_from).slice(0, 10)}\n` +
      `  ${c.items} items · ${c.with_deposit} carry a deposit · ` +
      `${c.structure_flagged} structure questions · ${c.price_flagged} price questions ` +
      `(${c.structure_flagged + c.price_flagged} total in the queue)`
  );
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('FAILED — nothing written:', err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await db.end();
}
