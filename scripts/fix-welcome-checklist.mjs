#!/usr/bin/env node
/**
 * welcome_soto still describes a checklist that no longer exists (finding #21 fallout).
 *
 * Its copy promises "a short 4-step checklist … confirm your info, sign your documents,
 * upload last year's return, and book your consultation". Brian's portal redesign made
 * it five steps, replaced the prior-year-return step with documents generally, and
 * REMOVED booking outright — a client only reaches this email after the discovery
 * meeting, so asking them to book one asks for something they have already done.
 *
 * That is the first instruction a new client gets from us, and it is wrong.
 *
 * WHY A SCRIPT AND NOT THE SEED. The template seed leaves existing keys untouched, on
 * purpose: copy is admin-editable and a redeploy must never overwrite something Brian
 * changed in Admin → Templates. Correct rule, but it means a stale body already in the
 * database can only be fixed through the admin path. This does exactly what that
 * endpoint does — new body, version bump, audited — rather than reaching around it.
 *
 * The body text lives in the SEED FILE and is read from there, so the two cannot drift:
 * a future edit to the seed copy is what this script applies.
 *
 * USAGE (inside saos-api-1, or locally against the dev DB):
 *   node fix-welcome-checklist.mjs            # dry run
 *   node fix-welcome-checklist.mjs --execute
 */

import pg from 'pg';
import { templates } from '../packages/db/seeds/data/templates.mjs';

const EXECUTE = process.argv.includes('--execute');
const KEY = 'welcome_soto';

const seeded = templates.find((t) => t.key === KEY);
if (!seeded) {
  console.error(`${KEY} is not in the template seed — nothing to apply.`);
  process.exit(1);
}

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { rows } = await db.query(
  `SELECT version, body_en, body_es, is_placeholder FROM templates WHERE key = $1`,
  [KEY]
);
const live = rows[0];
if (!live) {
  console.error(`${KEY} is not in the database.`);
  await db.end();
  process.exit(1);
}

const enChanged = live.body_en !== seeded.bodyEn;
const esChanged = live.body_es !== seeded.bodyEs;
console.log(`${KEY}: live v${live.version}, placeholder=${live.is_placeholder}`);
console.log(`  EN differs from seed: ${enChanged}`);
console.log(`  ES differs from seed: ${esChanged}`);

if (!enChanged && !esChanged) {
  console.log('\nAlready matches the seed — nothing to do.');
  await db.end();
  process.exit(0);
}

// Name what is actually going away, so the change is reviewable rather than a diff-blob.
for (const [label, text] of [['EN', live.body_en], ['ES', live.body_es]]) {
  for (const stale of ['book your consultation', '4-step', 'reserve su consulta', '4 pasos']) {
    if (text && text.includes(stale)) console.log(`  removing from ${label}: "${stale}"`);
  }
}

if (!EXECUTE) {
  console.log('\nDRY RUN — nothing written. Re-run with --execute.');
  await db.end();
  process.exit(0);
}

const updated = await db.query(
  `UPDATE templates
      SET body_en = $2, body_es = $3, version = version + 1, updated_at = now()
    WHERE key = $1
    RETURNING version`,
  [KEY, seeded.bodyEn, seeded.bodyEs]
);
await db.query(
  `INSERT INTO audit_log (actor_type, actor_label, action, object_type, object_id, details)
   VALUES ('system', 'welcome-checklist-fix', 'template.updated', 'template', $1, $2::jsonb)`,
  [
    KEY,
    JSON.stringify({
      version: updated.rows[0].version,
      reason:
        'Copy described the pre-redesign checklist: four steps, upload last year’s return, ' +
        'and book your consultation. Booking was removed from onboarding entirely.',
    }),
  ]
);

const after = await db.query(`SELECT version, body_en FROM templates WHERE key = $1`, [KEY]);
const stillStale = after.rows[0].body_en.includes('book your consultation');
console.log(
  `\n✓ ${KEY} now v${after.rows[0].version}` +
    (stillStale ? ' — STILL STALE, the update did not take' : ' — the removed steps are gone')
);
await db.end();
