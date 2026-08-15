#!/usr/bin/env node
/**
 * Apply a template's SEED copy to the live row — version bumped, audited.
 *
 * WHY THIS IS NEEDED AT ALL. The template seed leaves existing keys untouched, and that
 * is correct: a redeploy must never overwrite copy Brian edited in Admin → Templates. But
 * it also means a stale body already in the database can only be fixed through the admin
 * path, and a deploy will report success while changing nothing — which is exactly what
 * happened with welcome_soto, whose four-step checklist survived a deploy that "fixed" it.
 *
 * So this does what the admin endpoint does: new body from the seed file, version + 1,
 * audited. It reads the text FROM the seed rather than restating it, so the two cannot
 * drift — the same rule the v1 restore follows about not retyping values.
 *
 * It is deliberately per-key and explicit. A blanket "sync every template" would quietly
 * revert Brian's own admin edits, which is the thing the seed's untouched-keys rule
 * exists to prevent.
 *
 * USAGE (inside saos-api-1, from /app/scripts):
 *   node sync-template-copy.mjs invoice_sent            # dry run, shows the diff
 *   node sync-template-copy.mjs invoice_sent --execute
 */

import pg from 'pg';
import { templates } from '../packages/db/seeds/data/templates.mjs';

const EXECUTE = process.argv.includes('--execute');
const key = process.argv[2];
if (!key || key.startsWith('--')) {
  console.error('usage: node sync-template-copy.mjs <template_key> [--execute]');
  process.exit(1);
}

const seeded = templates.find((t) => t.key === key);
if (!seeded) {
  console.error(`${key} is not in the template seed.`);
  process.exit(1);
}

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { rows } = await db.query(
  `SELECT version, subject_en, subject_es, body_en, body_es, is_placeholder
     FROM templates WHERE key = $1`,
  [key]
);
const live = rows[0];
if (!live) {
  console.error(`${key} is not in the database.`);
  await db.end();
  process.exit(1);
}

const fields = [
  ['subject_en', live.subject_en, seeded.subjectEn ?? null],
  ['subject_es', live.subject_es, seeded.subjectEs ?? null],
  ['body_en', live.body_en, seeded.bodyEn ?? null],
  ['body_es', live.body_es, seeded.bodyEs ?? null],
];
const changed = fields.filter(([, a, b]) => a !== b);

console.log(`${key}: live v${live.version}, placeholder=${live.is_placeholder}`);
if (changed.length === 0) {
  console.log('Already matches the seed — nothing to do.');
  await db.end();
  process.exit(0);
}

for (const [name, from, to] of changed) {
  console.log(`\n  ${name}:`);
  console.log(`    live: ${String(from ?? '(null)').replace(/\n/g, ' ').slice(0, 160)}`);
  console.log(`    seed: ${String(to ?? '(null)').replace(/\n/g, ' ').slice(0, 160)}`);
}

if (!EXECUTE) {
  console.log('\nDRY RUN — nothing written. Re-run with --execute.');
  await db.end();
  process.exit(0);
}

const updated = await db.query(
  `UPDATE templates
      SET subject_en = $2, subject_es = $3, body_en = $4, body_es = $5,
          version = version + 1, updated_at = now()
    WHERE key = $1
    RETURNING version`,
  [key, seeded.subjectEn ?? null, seeded.subjectEs ?? null, seeded.bodyEn ?? null, seeded.bodyEs ?? null]
);
await db.query(
  `INSERT INTO audit_log (actor_type, actor_label, action, object_type, object_id, details)
   VALUES ('system', 'template-copy-sync', 'template.updated', 'template', $1, $2::jsonb)`,
  [key, JSON.stringify({ version: updated.rows[0].version, fields: changed.map(([n]) => n) })]
);

// Read back rather than reporting intent.
const after = await db.query(
  `SELECT version, subject_en, subject_es, body_en, body_es FROM templates WHERE key = $1`,
  [key]
);
const a = after.rows[0];
const stillOff = [
  a.subject_en !== (seeded.subjectEn ?? null),
  a.subject_es !== (seeded.subjectEs ?? null),
  a.body_en !== (seeded.bodyEn ?? null),
  a.body_es !== (seeded.bodyEs ?? null),
].filter(Boolean).length;
console.log(
  `\n✓ ${key} now v${a.version}` +
    (stillOff === 0 ? ' — matches the seed in both languages' : ` — ${stillOff} field(s) STILL differ`)
);
if (stillOff > 0) process.exitCode = 1;
await db.end();
