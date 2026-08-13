#!/usr/bin/env node
/**
 * GATE 2 (launch-readiness.md) — reclassify mis-filed price-book items.
 *
 * Brian's ruling (2026-08-13): "reclassify in the price book — as a new effective-dated
 * version, not an in-place edit; the versioned book applies to its own corrections."
 *
 * That is the right call and it is not merely tidy. Quotes PIN a price-book version, so
 * an in-place edit would retroactively change what a client was quoted under. A new
 * version leaves every historical quote reading exactly as it did, and the correction
 * takes effect going forward — which is what versioning is for, including when the thing
 * being corrected is the book's own classification rather than a price.
 *
 * NO PRICES CHANGE HERE. Amounts, ranges, units, confirmation flags and notes are copied
 * forward byte for byte; only `service_line` moves. This script contains no dollar
 * amount for that reason, and `npm run check:prices` would fail if it did.
 *
 * ORDER: Brian asked for SCOPE_REVIEW_AUDIT first, because attest is the one with a
 * license-level control behind it (independence gate + Schedule F). It is verified
 * first and hardest; the rest ride in the same version.
 *
 * USAGE (inside saos-api-1, or locally against the dev DB):
 *   node reclassify-price-lines.mjs            # dry run
 *   node reclassify-price-lines.mjs --execute  # create the new version
 */

import pg from 'pg';

const EXECUTE = process.argv.includes('--execute');

/**
 * item_code → the price_service_line it should have been filed under.
 *
 * Brian named four. Two more were in the same grab-bag and are my call, flagged in the
 * report so he can reverse either:
 *
 *   SCOPE_REG_SETUP — "Registration & Setup", the first rung of the payroll and
 *     sales-tax ladders it sits beside. Registering a client with the state for payroll
 *     or sales tax is Schedule C work, not a modifier on someone else's engagement.
 *
 *   SCORP_CONVERSION_2553 — he said "wherever entity work maps (Schedule C if that's
 *     the entity home)". It is not: entity work maps to Schedule E via entity_services.
 *     So this goes to entity_services → E, not C.
 *
 * SCOPE_ADMIN_TRAINING is deliberately NOT moved — see UNRULED below.
 */
const RECLASSIFY = {
  SCOPE_REVIEW_AUDIT: 'attest', // → Schedule F. Brian: this one first.
  SALES_TAX_ST1_FILING: 'recurring_accounting', // → C
  SCOPE_FULLMGMT_PAYROLL: 'recurring_accounting', // → C
  SCOPE_FULLMGMT_SALES_TAX: 'recurring_accounting', // → C
  SCOPE_REG_SETUP: 'recurring_accounting', // → C (my call)
  SCORP_CONVERSION_2553: 'entity_services', // → E (my call; E is the entity home, not C)
};

/**
 * Left in scope_ladder on purpose, awaiting a ruling.
 *
 * SCOPE_ADMIN_TRAINING is described in the book as "the deliberate Hilo bridge product —
 * DIY-minded entrepreneurs buy training." That is a product sold on its own, not a tier
 * modifier on an accounting engagement — so "scope_ladder means tier modifiers" does not
 * cover it. But which schedule governs training work is a question about what Soto is
 * agreeing to do, and that is not mine to answer. It stays where it is, unmapped and
 * therefore reported as UNKNOWN rather than silently absorbed.
 */
const UNRULED = ['SCOPE_ADMIN_TRAINING'];

const db = new pg.Client({
  connectionString:
    process.env.DATABASE_URL ?? 'postgres://saos:saos_dev_password@localhost:5432/saos',
});
await db.connect();

const current = await db.query(
  `SELECT id, version_number, effective_from
     FROM price_book_versions
    WHERE effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
    ORDER BY version_number DESC LIMIT 1`
);
if (current.rows.length === 0) {
  console.error('No price book version in force — nothing to correct.');
  await db.end();
  process.exit(1);
}
const from = current.rows[0];
console.log(`in force: v${from.version_number} (${String(from.effective_from).slice(0, 10)})`);

const affected = await db.query(
  `SELECT item_code, name_en, service_line::text AS service_line, needs_confirmation
     FROM price_book_items
    WHERE version_id = $1 AND item_code = ANY($2)
    ORDER BY item_code`,
  [from.id, Object.keys(RECLASSIFY)]
);

console.log(`\n${EXECUTE ? 'APPLYING' : 'DRY RUN'} — v${from.version_number} → v${from.version_number + 1}\n`);
const missing = Object.keys(RECLASSIFY).filter((c) => !affected.rows.some((r) => r.item_code === c));
if (missing.length > 0) console.log(`  ⚠ NOT IN THE BOOK (skipped): ${missing.join(', ')}`);

for (const row of affected.rows) {
  const to = RECLASSIFY[row.item_code];
  const flag = ['SCOPE_REG_SETUP', 'SCORP_CONVERSION_2553'].includes(row.item_code) ? '  ← my call' : '';
  console.log(`  ${row.item_code.padEnd(26)} ${row.service_line} → ${to}${flag}`);
  console.log(`      "${row.name_en}"`);
}

const totals = await db.query(
  `SELECT count(*)::int AS items,
          count(*) FILTER (WHERE needs_confirmation)::int AS unconfirmed
     FROM price_book_items WHERE version_id = $1`,
  [from.id]
);
console.log(
  `\n  copying ${totals.rows[0].items} items forward, ` +
    `${totals.rows[0].unconfirmed} still flagged needs_confirmation (preserved)`
);
console.log(`  left unruled in scope_ladder: ${UNRULED.join(', ')}`);

if (!EXECUTE) {
  console.log('\nRe-run with --execute to create the new version.\n');
  await db.end();
  process.exit(0);
}

await db.query('BEGIN');
try {
  // Close the current version as of today and open the next one the same day, so
  // currentVersion() (effective_from <= today AND effective_to > today) picks exactly
  // one of them.
  const next = await db.query(
    `INSERT INTO price_book_versions (version_number, effective_from, effective_to, note)
     VALUES ($1, CURRENT_DATE, NULL, $2)
     RETURNING id, version_number`,
    [
      from.version_number + 1,
      'GATE 2 reclassification (Brian, 2026-08-13): mis-filed scope_ladder and ' +
        'setup_conversion items moved to the service lines that actually govern them. ' +
        'SCOPE_REVIEW_AUDIT → attest is the license-relevant one. No prices changed.',
    ]
  );
  const to = next.rows[0];
  await db.query(`UPDATE price_book_versions SET effective_to = CURRENT_DATE WHERE id = $1`, [from.id]);

  // Copy every column explicitly EXCEPT id/version_id/created_at, so a future column
  // addition fails loudly here rather than being silently dropped from the new version.
  await db.query(
    `INSERT INTO price_book_items
       (version_id, item_code, service_line, name_en, name_es, description_en, description_es,
        amount_cents, price_min_cents, price_max_cents, unit, is_pass_through, display_on_quote,
        needs_confirmation, confirmation_note, is_active, sort_order, metadata)
     SELECT $1,
            item_code,
            COALESCE(($2::jsonb ->> item_code)::price_service_line, service_line),
            name_en, name_es, description_en, description_es,
            amount_cents, price_min_cents, price_max_cents, unit, is_pass_through, display_on_quote,
            needs_confirmation, confirmation_note, is_active, sort_order, metadata
       FROM price_book_items WHERE version_id = $3`,
    [to.id, JSON.stringify(RECLASSIFY), from.id]
  );
  await db.query('COMMIT');
  console.log(`\n✓ created v${to.version_number}`);
} catch (err) {
  await db.query('ROLLBACK');
  console.error('\nFAILED — rolled back, the book is unchanged:\n', err.message);
  await db.end();
  process.exit(1);
}

// ── Read back what landed, rather than trusting the writes ───────────────────
const check = await db.query(
  `SELECT v.version_number, i.item_code, i.service_line::text AS service_line,
          m.schedule_code
     FROM price_book_items i
     JOIN price_book_versions v ON v.id = i.version_id
     LEFT JOIN schedule_for_price_line m ON m.service_line = i.service_line
    WHERE i.item_code = ANY($1)
    ORDER BY i.item_code, v.version_number`,
  [[...Object.keys(RECLASSIFY), ...UNRULED]]
);
console.log('\nRESULT — item by version (old rows are intact by design):');
for (const r of check.rows) {
  console.log(
    `  v${r.version_number}  ${r.item_code.padEnd(26)} ${r.service_line.padEnd(21)} → ` +
      `${r.schedule_code ?? 'NO SCHEDULE'}`
  );
}

const counts = await db.query(
  `SELECT v.version_number, count(*)::int AS items,
          count(*) FILTER (WHERE i.needs_confirmation)::int AS unconfirmed
     FROM price_book_items i JOIN price_book_versions v ON v.id = i.version_id
    GROUP BY v.version_number ORDER BY v.version_number`
);
console.log('\nitem counts by version:', JSON.stringify(counts.rows));

const stillScopeLadder = await db.query(
  `SELECT i.item_code FROM price_book_items i
     JOIN price_book_versions v ON v.id = i.version_id
    WHERE i.service_line::text = 'scope_ladder' AND i.is_active
      AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
    ORDER BY 1`
);
console.log(
  `\nstill classified scope_ladder in force: ${
    stillScopeLadder.rows.map((r) => r.item_code).join(', ') || 'none'
  }`
);

await db.end();
