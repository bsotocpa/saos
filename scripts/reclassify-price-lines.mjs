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
  // v3 (2026-08-13): Brian ruled SCOPE_ADMIN_TRAINING → Schedule C, the last item left
  // in scope_ladder. With it moved, scope_ladder holds NO live items at all — so the
  // seed's "unmapped with live items" warning falls silent on its own, and the enum
  // value stays unmapped so anything filed there in future shows up loudly.
  SCOPE_ADMIN_TRAINING: 'recurring_accounting',
};

/**
 * Applied in v2 (2026-08-13), kept here as the record of what moved and why. Re-running
 * with these would be a no-op; they are listed because "which version changed what" is
 * a question someone will ask in a year.
 *
 *   SCOPE_REVIEW_AUDIT       scope_ladder     → attest              (F)
 *   SALES_TAX_ST1_FILING     scope_ladder     → recurring_accounting (C)
 *   SCOPE_FULLMGMT_PAYROLL   scope_ladder     → recurring_accounting (C)
 *   SCOPE_FULLMGMT_SALES_TAX scope_ladder     → recurring_accounting (C)
 *   SCOPE_REG_SETUP          scope_ladder     → recurring_accounting (C)
 *   SCORP_CONVERSION_2553    setup_conversion → entity_services      (E)
 */

/**
 * Items still awaiting a ruling — none as of v3.
 *
 * SCOPE_ADMIN_TRAINING was the last one. It is described in the book as "the deliberate
 * Hilo bridge product — DIY-minded entrepreneurs buy training", which is a product sold
 * on its own rather than a tier modifier, so it could not keep riding on the
 * "scope_ladder means modifiers" ruling. Brian ruled it to Schedule C on 2026-08-13 and
 * it moves in v3.
 */
const UNRULED = [];

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
  const flag = ['SCOPE_REG_SETUP', 'SCORP_CONVERSION_2553'].includes(row.item_code) ? '  <- my call' : '';
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
console.log(`  awaiting a ruling: ${UNRULED.join(', ') || 'nothing'}`);

if (!EXECUTE) {
  console.log('\nRe-run with --execute to create the new version.\n');
  await db.end();
  process.exit(0);
}

/*
 * WHEN does the new version take effect?
 *
 * price_book_versions enforces CHECK (effective_to IS NULL OR effective_to > effective_from),
 * so a version cannot open and close on the same date — which means AT MOST ONE VERSION
 * PER DAY. That is the constraint doing its job: two versions sharing a date would make
 * "the book in force on 2026-08-13" ambiguous, and engagements pin a version forever.
 *
 * So: normally the new version starts today. But if the version currently in force also
 * started today (a second correction on the same day), the new one starts TOMORROW and
 * today's book is left exactly as it was. Nothing already quoted today shifts underneath
 * anyone.
 */
// Ask the DATABASE whether the current version started today. Comparing in JS looked
// obvious and was wrong twice over: node-postgres hands back a Date, so
// String(effective_from).slice(0,10) is "Thu Aug 13" and never equals an ISO date — and
// the timezone of the process is not the timezone of CURRENT_DATE. The database owns
// CURRENT_DATE, so the database answers the question.
const sameDay = await db.query(
  `SELECT (effective_from = CURRENT_DATE) AS today FROM price_book_versions WHERE id = $1`,
  [from.id]
);
const currentStartedToday = sameDay.rows[0].today === true;
const EFFECTIVE = currentStartedToday ? "CURRENT_DATE + INTERVAL '1 day'" : 'CURRENT_DATE';
if (currentStartedToday) {
  console.log(
    `\n  NOTE: v${from.version_number} also took effect today, and a version cannot open` +
      ` and close\n  on the same date. v${from.version_number + 1} is dated TOMORROW; today's book is untouched.`
  );
}

await db.query('BEGIN');
try {
  // Close the current version when the next one opens, so currentVersion()
  // (effective_from <= today AND effective_to > today) picks exactly one of them on
  // every date.
  const next = await db.query(
    `INSERT INTO price_book_versions (version_number, effective_from, effective_to, note)
     VALUES ($1, ${EFFECTIVE}, NULL, $2)
     RETURNING id, version_number, effective_from`,
    [
      from.version_number + 1,
      'GATE 2 (Brian, 2026-08-13): mis-filed items moved to the service lines that ' +
        'actually govern them. No prices changed.',
    ]
  );
  const to = next.rows[0];
  await db.query(
    `UPDATE price_book_versions SET effective_to = ${EFFECTIVE} WHERE id = $1`,
    [from.id]
  );

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
  console.log(`\n✓ created v${to.version_number}, effective ${String(to.effective_from).slice(0, 15)}`);
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
