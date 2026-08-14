#!/usr/bin/env node
/**
 * Retire the booking-time deposit path in price book v4 (Brian, 2026-08-14).
 *
 * His ruling: "retire the direct-deposit invoice path entirely. My earlier ruling stands
 * and extends — deposits exist ONLY on accepted quotes. Discovery and all bookings are
 * free; first client payment is always the quote deposit. Kill the second path, which
 * also kills the double-charge scenario."
 *
 * So DEPOSIT_1040 and DEPOSIT_BUSINESS_TAX go inactive, and the two confirmation
 * questions they carried are ANSWERED — by him, in that message — so the flags clear
 * rather than sitting in his queue asking something he has already decided.
 *
 * WHY THIS AMENDS v4 IN PLACE, which normally would be wrong.
 *
 * The standing rule is "a new effective-dated version, never an in-place edit", and it
 * exists to protect clients who were already quoted under a version. v4 has NEVER BEEN
 * IN FORCE — it starts tomorrow — so no quote and no engagement can pin it, and there is
 * no history to rewrite. The script VERIFIES that before touching anything and refuses
 * otherwise.
 *
 * The alternative would be a v5 starting the day after tomorrow, because at most one
 * version may exist per day. That would push Brian's confirmation sitting back a day to
 * protect history that does not exist.
 *
 * NO PRICES CHANGE. The two retired items keep their amounts — they must, because two
 * accepted quotes are price-locked against DEPOSIT_1040 and the legacy read path still
 * resolves it.
 *
 * USAGE (inside saos-api-1, or locally against the dev DB):
 *   node retire-booking-deposits.mjs            # dry run
 *   node retire-booking-deposits.mjs --execute
 */

import pg from 'pg';

const EXECUTE = process.argv.includes('--execute');
const ITEMS = ['DEPOSIT_1040', 'DEPOSIT_BUSINESS_TAX'];

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

// THE SAFETY CHECK. Amending in place is only defensible on a version nothing can have
// been quoted under.
if (!v.pending) {
  console.error(
    `\nREFUSING: v${v.version_number} is already in force. Amending a live version would ` +
      `retroactively change what clients were quoted. Create a new version instead.`
  );
  await db.end();
  process.exit(1);
}
const pinned = await db.query(
  `SELECT (SELECT count(*) FROM quotes WHERE price_book_version_id = $1)::int AS quotes,
          (SELECT count(*) FROM engagements WHERE price_book_version_id = $1)::int AS engagements`,
  [v.id]
);
const { quotes, engagements } = pinned.rows[0];
if (quotes > 0 || engagements > 0) {
  console.error(`\nREFUSING: ${quotes} quote(s) and ${engagements} engagement(s) already pin v${v.version_number}.`);
  await db.end();
  process.exit(1);
}
console.log(`nothing pins it: ${quotes} quotes, ${engagements} engagements — safe to amend`);

const before = await db.query(
  `SELECT item_code, is_active, needs_confirmation, structure_needs_confirmation
     FROM price_book_items WHERE version_id = $1 AND item_code = ANY($2) ORDER BY item_code`,
  [v.id, ITEMS]
);
if (before.rows.length !== ITEMS.length) {
  console.error(`\nExpected ${ITEMS.length} deposit items in v${v.version_number}, found ${before.rows.length}.`);
  await db.end();
  process.exit(1);
}
console.log(`\nPlan — retire ${ITEMS.length} items and clear the questions Brian just answered:`);
for (const r of before.rows) {
  const flags = [
    r.needs_confirmation ? 'price?' : null,
    r.structure_needs_confirmation ? 'structure?' : null,
  ].filter(Boolean);
  console.log(`  ${r.item_code.padEnd(22)} active=${r.is_active} → false` + (flags.length ? `, clearing ${flags.join(' + ')}` : ''));
}

if (!EXECUTE) {
  console.log('\nDRY RUN — nothing written. Re-run with --execute.');
  await db.end();
  process.exit(0);
}

/*
 * The setting has to be cleared here rather than by the seed. The settings seed is
 * ON CONFLICT DO NOTHING — deliberately, so it never stomps a value Brian tuned in
 * Admin — which means an existing key keeps its old value and description forever. So
 * after the deploy, `booking.deposit_items` still advertised a slug → deposit-item map
 * that nothing reads. The code was right and the admin screen was lying.
 */
const staleSetting = await db.query(
  `SELECT (value IS NOT NULL) AS has_value FROM app_settings WHERE key = 'booking.deposit_items'`
);
const settingNeedsClearing = staleSetting.rows[0]?.has_value === true;
console.log(
  settingNeedsClearing
    ? '  booking.deposit_items still holds its old map → clearing it and marking it retired'
    : '  booking.deposit_items already cleared'
);

const client = await db.connect();
try {
  await client.query('BEGIN');

  if (settingNeedsClearing) {
    await client.query(
      `UPDATE app_settings
          SET value = 'null'::jsonb,
              description = $1
        WHERE key = 'booking.deposit_items'`,
      [
        'RETIRED 2026-08-14. Was slug → price_book deposit item, collected at booking. That second deposit path is gone: deposits exist only on accepted quotes, so a booking takes no money. Superseded by booking.discovery_events, which carries the same slugs and no amounts.',
      ]
    );
  }

  const res = await client.query(
    `UPDATE price_book_items
        SET is_active = false,
            needs_confirmation = false,
            confirmation_note = NULL,
            structure_needs_confirmation = false,
            structure_confirmation_note = NULL,
            description_en = CASE item_code
              WHEN 'DEPOSIT_1040' THEN 'RETIRED 2026-08-14. Bookings are free; a deposit exists only on an accepted quote, as deposit_cents on the service line that starts the work. Kept because accepted quotes are price-locked against this item.'
              ELSE 'RETIRED 2026-08-14 — see DEPOSIT_1040. Its amount now lives on the entity-return lines as deposit_cents.'
            END,
            name_en = name_en || ' (retired)'
      WHERE version_id = $1 AND item_code = ANY($2) AND is_active`,
    [v.id, ITEMS]
  );
  if (res.rowCount !== ITEMS.length) {
    throw new Error(`expected ${ITEMS.length} rows updated, got ${res.rowCount}`);
  }
  await client.query('COMMIT');

  // READ BACK, rather than reporting intent.
  const check = await db.query(
    `SELECT count(*) FILTER (WHERE structure_needs_confirmation)::int AS structure_q,
            count(*) FILTER (WHERE needs_confirmation)::int           AS price_q,
            count(*) FILTER (WHERE deposit_cents IS NOT NULL)::int     AS with_deposit
       FROM price_book_items WHERE version_id = $1`,
    [v.id]
  );
  const c = check.rows[0];
  console.log(
    `\n✓ retired ${res.rowCount} items in v${v.version_number}\n` +
      `  queue is now ${c.price_q} price + ${c.structure_q} structure = ${c.price_q + c.structure_q}\n` +
      `  ${c.with_deposit} service lines carry a deposit`
  );
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('FAILED — nothing written:', err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await db.end();
}
