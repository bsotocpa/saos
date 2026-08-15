#!/usr/bin/env node
/**
 * Put price book v1 back to what was ACTUALLY in force (Brian, 2026-08-15).
 *
 * The price-book seed upserts v1 with `DO UPDATE SET ...` on every deploy, so editing
 * the seed rewrites v1 in production. Two deploys today did exactly that:
 *
 *   · #25 changed LATE_FEE_MONTHLY from flat/$0 to percent-mode in v1
 *   · the GATE-2-forward change moved seven items out of scope_ladder in v1
 *
 * Neither is what v1 held when v1 was in force. Brian's ruling: "History means what was
 * actually in force, not what the current seed thinks." Freezing v1 without restoring it
 * first would preserve falsified history, so this runs before the freeze.
 *
 * THE VALUES COME FROM THE BACKUP, not from this file. A restore that retypes what the
 * author believes the old values were is not a restore — it is the same guess that
 * caused the problem, wearing a different hat. Feed it the tab-separated extract of the
 * v1 rows from the pre-deploy restic snapshot:
 *
 *   item_code|service_line|amount_cents|deposit_cents|pricing_mode      ('-' for NULL)
 *
 * USAGE (inside saos-api-1, with the extract mounted or piped):
 *   node restore-v1-from-backup.mjs /tmp/v1_bak.txt            # dry run
 *   node restore-v1-from-backup.mjs /tmp/v1_bak.txt --execute
 */

import { readFileSync } from 'node:fs';
import pg from 'pg';

const EXECUTE = process.argv.includes('--execute');
const file = process.argv[2];
if (!file || file.startsWith('--')) {
  console.error('usage: node restore-v1-from-backup.mjs <extract> [--execute]');
  process.exit(1);
}

/*
 * WHICH COLUMNS HAVE A HISTORICAL TRUTH AT ALL.
 *
 * v1 was in force 2026-07-05 → 2026-08-13. `deposit_cents`, `pricing_mode` and
 * `percent_rate` were created by migration 0050 on 2026-08-14 — after v1 was already
 * superseded. No value in them was ever "in force" for v1; whatever they hold is a seed
 * artifact from this week, so restoring the backup's copy would restore yesterday's
 * artifact rather than history. The backup's deposit figures would also violate the
 * deposit-ceiling constraint added the same day ($250 on a $150 line), which is the
 * clearest sign they are not a historical record of anything.
 *
 * `service_line` and `amount_cents` existed throughout v1's life, so their backup values
 * ARE what was in force. Those are what this restores.
 *
 * pricing_mode moves only as a consequence: the mode CHECK requires a flat line to carry
 * an amount, so putting LATE_FEE_MONTHLY's $0 back forces its mode back to flat with it.
 */
const numeric = (v) => {
  if (v === undefined || v === null) return null;
  const t = v.trim();
  if (t === '-' || t === '' || t === '\\N') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

const wanted = new Map();
for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const [code, serviceLine, amount] = line.split('|');
  wanted.set(code, { serviceLine, amountCents: numeric(amount) });
}
console.log(`backup extract: ${wanted.size} v1 rows`);
console.log('restoring service_line and amount_cents only — deposit_cents and pricing_mode');
console.log('post-date v1 entirely (migration 0050, 2026-08-14), so they hold no history.');

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const v = await db.query(`SELECT id FROM price_book_versions WHERE version_number = 1`);
if (!v.rows[0]) {
  console.error('no v1 in this database');
  await db.end();
  process.exit(1);
}
const versionId = v.rows[0].id;

const live = await db.query(
  `SELECT item_code, service_line::text AS service_line, amount_cents, deposit_cents,
          pricing_mode::text AS pricing_mode
     FROM price_book_items WHERE version_id = $1`,
  [versionId]
);

const drift = [];
for (const row of live.rows) {
  const want = wanted.get(row.item_code);
  if (!want) continue; // present now, absent from the backup — a later addition, left alone
  const changes = [];
  if (row.service_line !== want.serviceLine) changes.push(`service_line ${row.service_line} → ${want.serviceLine}`);
  if ((row.amount_cents ?? null) !== want.amountCents) {
    changes.push(`amount ${row.amount_cents ?? 'null'} → ${want.amountCents ?? 'null'}`);
  }
  if (changes.length > 0) {
    // A line carrying an amount is flat by definition; the mode CHECK spans both, so it
    // travels with the amount rather than being restored in its own right.
    const mode = want.amountCents === null ? row.pricing_mode : 'flat';
    drift.push({ code: row.item_code, want: { ...want, pricingMode: mode }, changes });
  }
}

if (drift.length === 0) {
  console.log('\nv1 already matches the backup — nothing to restore.');
  await db.end();
  process.exit(0);
}

console.log(`\n${drift.length} row(s) drifted from what was in force:`);
for (const d of drift) console.log(`  ${d.code.padEnd(26)} ${d.changes.join('; ')}`);

if (!EXECUTE) {
  console.log('\nDRY RUN — nothing written. Re-run with --execute.');
  await db.end();
  process.exit(0);
}

const client = await db.connect();
try {
  await client.query('BEGIN');
  for (const d of drift) {
    // Every column restored together: the mode CHECK spans them, so setting one at a
    // time would fail on the intermediate state (percent → flat needs its amount back
    // in the same statement).
    const res = await client.query(
      `UPDATE price_book_items
          SET service_line = $3::price_service_line,
              amount_cents = $4,
              pricing_mode = $5::price_pricing_mode,
              percent_rate = CASE WHEN $5 = 'percent' THEN percent_rate ELSE NULL END
        WHERE version_id = $1 AND item_code = $2`,
      [versionId, d.code, d.want.serviceLine, d.want.amountCents, d.want.pricingMode]
    );
    if (res.rowCount !== 1) throw new Error(`expected one row for ${d.code}, got ${res.rowCount}`);
  }
  await client.query(
    `INSERT INTO audit_log (actor_type, actor_label, action, object_type, object_id, details)
     VALUES ('system', 'v1-restore', 'price_book.version_restored', 'price_book_version', $1, $2::jsonb)`,
    [
      versionId,
      JSON.stringify({
        version_number: 1,
        restored_rows: drift.map((d) => d.code),
        source: 'restic snapshot 1e76006f (2026-08-15 02:15 UTC), pre-deploy',
        reason:
          'The price-book seed upserted v1 on deploy, rewriting rows that were historical. ' +
          'History means what was actually in force (Brian, 2026-08-15).',
      }),
    ]
  );
  await client.query('COMMIT');

  // Read back and re-compare against the backup rather than reporting intent.
  const after = await db.query(
    `SELECT item_code, service_line::text AS service_line, amount_cents, deposit_cents,
            pricing_mode::text AS pricing_mode
       FROM price_book_items WHERE version_id = $1`,
    [versionId]
  );
  const stillOff = after.rows.filter((row) => {
    const want = wanted.get(row.item_code);
    if (!want) return false;
    return row.service_line !== want.serviceLine || (row.amount_cents ?? null) !== want.amountCents;
  });
  console.log(
    `\n✓ restored ${drift.length} row(s); ${stillOff.length} still differ from the backup` +
      (stillOff.length === 0 ? ' — v1 matches what was in force' : `: ${stillOff.map((r) => r.item_code).join(', ')}`)
  );
  if (stillOff.length > 0) process.exitCode = 1;
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('FAILED — nothing written:', err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await db.end();
}
