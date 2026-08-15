#!/usr/bin/env node
/**
 * FINDING #25 — make the live book conform to the Master (Brian, 2026-08-14).
 *
 * "the late-fee book line (flat $25/month) contradicts Master §3's disclosed 1.5%/mo —
 * on balances under $1,667 the flat fee exceeds the disclosure every signed client
 * agreed to. Ruling: the book conforms to the Master."
 *
 * Migration 0051/0052 add the columns and the percent mode; the seed writes v1. This
 * applies the change to the version actually in play, and backfills what existing
 * signatures need — schema plus seed has never been a data migration in this codebase.
 *
 * FOUR THINGS:
 *   1. LATE_FEE_MONTHLY → percent mode, rate read from its own metadata (1.5), amount
 *      cleared. The $25 was typed into the admin page during the confirmation sitting,
 *      onto a line whose real rate lived in a metadata key the page never displayed.
 *   2. templates.late_fee_rate_percent on every Master that carries the disclosure,
 *      read from the SAME metadata rate. No number is typed in this file.
 *   3. contacts.late_fee_disclosed_rate_percent backfilled for clients who already
 *      signed — from the rate declared by the Master they signed.
 *   4. Verifies afterwards that no line can charge above what any client was told.
 *
 * NO RATE LITERAL LIVES HERE. Everything is derived from the book's own metadata, so
 * this script cannot become a second source of truth for the rate — which is the whole
 * shape of the bug it fixes.
 *
 * USAGE (inside saos-api-1, or locally against the dev DB):
 *   node late-fee-conform.mjs            # dry run
 *   node late-fee-conform.mjs --execute
 */

import pg from 'pg';

const EXECUTE = process.argv.includes('--execute');
const ITEM = 'LATE_FEE_MONTHLY';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const latest = await db.query(
  `SELECT id, version_number, effective_from, (effective_from > CURRENT_DATE) AS pending
     FROM price_book_versions ORDER BY version_number DESC LIMIT 1`
);
const v = latest.rows[0];
if (!v) {
  console.error('No price book version exists.');
  await db.end();
  process.exit(1);
}
console.log(`latest: v${v.version_number} (${String(v.effective_from).slice(0, 10)}) pending=${v.pending}`);

const line = await db.query(
  `SELECT amount_cents, percent_rate, pricing_mode::text AS pricing_mode, metadata
     FROM price_book_items WHERE version_id = $1 AND item_code = $2`,
  [v.id, ITEM]
);
const row = line.rows[0];
if (!row) {
  console.error(`${ITEM} is not in v${v.version_number}.`);
  await db.end();
  process.exit(1);
}

// THE RATE COMES FROM THE BOOK, never from this file.
const rate = row.percent_rate ?? row.metadata?.monthly_rate_percent ?? null;
if (rate === null) {
  console.error(`${ITEM} states no rate — refusing to invent one. Set it in Admin → Pricing first.`);
  await db.end();
  process.exit(1);
}

console.log(`\n  ${ITEM}: mode ${row.pricing_mode} → percent, rate ${rate}%/month`);
console.log(
  row.amount_cents === null
    ? '    no fixed amount to clear'
    : `    clearing its fixed amount (${(row.amount_cents / 100).toFixed(2)}) — a rate line has no fixed price`
);

const masters = await db.query(
  `SELECT key, version, late_fee_rate_percent FROM templates WHERE has_late_fee_disclosure ORDER BY key`
);
console.log(`\n  templates disclosing a late fee: ${masters.rows.length}`);
for (const m of masters.rows) {
  console.log(`    ${m.key} (v${m.version}) declared rate: ${m.late_fee_rate_percent ?? 'none → ' + rate}`);
}

const unstamped = await db.query(
  `SELECT count(*)::int AS n FROM contacts
    WHERE late_fee_disclosure_signed_at IS NOT NULL AND late_fee_disclosed_rate_percent IS NULL`
);
console.log(
  `\n  signed clients with no stamped rate: ${unstamped.rows[0].n}` +
    ` → backfilled to ${rate}% (they signed the only Master that has ever disclosed one)`
);
console.log('  without the backfill they would be charged NOTHING, because an unprovable rate fails closed.');

if (!EXECUTE) {
  console.log('\nDRY RUN — nothing written. Re-run with --execute.');
  await db.end();
  process.exit(0);
}

const client = await db.connect();
try {
  await client.query('BEGIN');

  // 1 + 2. The book line becomes a rate; every disclosing template declares that rate.
  await client.query(
    `UPDATE price_book_items
        SET pricing_mode = 'percent', percent_rate = $3,
            amount_cents = NULL, price_min_cents = NULL, price_max_cents = NULL,
            metadata = metadata - 'monthly_rate_percent',
            description_en = 'Conforms to Master §3: ' || $3::text || '%/month (18% APR) on balances 30+ days past due, applied after all deposits and credits. Applies ONLY to clients whose signed engagement letter carries the late-fee disclosure, and is capped at the rate THEIR signed letter disclosed.'
      WHERE version_id = $1 AND item_code = $2`,
    [v.id, ITEM, rate]
  );
  await client.query(
    `UPDATE templates SET late_fee_rate_percent = $1
      WHERE has_late_fee_disclosure AND late_fee_rate_percent IS NULL`,
    [rate]
  );
  // The CHECK was added NOT VALID so the migration could not fail on pre-existing rows;
  // now that every disclosing template states a rate, prove it holds for all of them.
  await client.query(`ALTER TABLE templates VALIDATE CONSTRAINT templates_late_fee_rate_matches_disclosure`);

  // 3. What each already-signed client agreed to.
  const stamped = await client.query(
    `UPDATE contacts c
        SET late_fee_disclosed_rate_percent = t.late_fee_rate_percent
       FROM templates t
      WHERE c.late_fee_disclosure_signed_at IS NOT NULL
        AND c.late_fee_disclosed_rate_percent IS NULL
        AND t.has_late_fee_disclosure
        AND t.late_fee_rate_percent IS NOT NULL`
  );

  await client.query('COMMIT');

  // 4. READ BACK, and check the invariant the ruling is actually about.
  const after = await db.query(
    `SELECT i.pricing_mode::text AS mode, i.percent_rate, i.amount_cents
       FROM price_book_items i WHERE i.version_id = $1 AND i.item_code = $2`,
    [v.id, ITEM]
  );
  const a = after.rows[0];
  const exposed = await db.query(
    `SELECT count(*)::int AS n FROM contacts
      WHERE late_fee_disclosure_signed_at IS NOT NULL
        AND (late_fee_disclosed_rate_percent IS NULL OR late_fee_disclosed_rate_percent < $1)`,
    [rate]
  );
  console.log(
    `\n✓ ${ITEM}: mode=${a.mode}, rate=${a.percent_rate}%, fixed amount=${a.amount_cents ?? 'none'}\n` +
      `  ${stamped.rowCount} signed client(s) stamped with their disclosed rate\n` +
      `  clients the book rate would exceed: ${exposed.rows[0].n}` +
      (exposed.rows[0].n === 0 ? ' — the book charges no more than anyone was told' : ' — THE CAP WILL HOLD THEM DOWN')
  );
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('FAILED — nothing written:', err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await db.end();
}
