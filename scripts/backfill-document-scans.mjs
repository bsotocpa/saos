#!/usr/bin/env node
/**
 * FINDING #14(2) — scan every document already in MinIO and record a verdict.
 *
 * Brian's ruling: "scan everything in MinIO now and add scan_status — production is
 * still all test data, cheapest moment it will ever be." He is right, and the window
 * closes the day a real client uploads a real W-2.
 *
 * Migration 0045 defaults existing rows to 'pending_scan' rather than 'clean'. That
 * is deliberate: nothing in production has ever been scanned, and writing 'clean'
 * into a compliance column for bytes nobody has looked at would be a lie that later
 * reads as evidence. This script resolves those rows honestly.
 *
 * It reuses the SAME code path as an upload and the rescan job — recordScan() — so a
 * backfilled verdict is indistinguishable from a live one, including its audit row.
 * No second convention for old files.
 *
 * USAGE (inside saos-api-1):
 *   node backfill-document-scans.mjs            # dry run: what would be scanned
 *   node backfill-document-scans.mjs --execute  # scan and record
 *
 * Safe to re-run: only rows still awaiting a verdict are considered, so a second run
 * after a scanner outage picks up exactly what the first run had to skip.
 */

import pg from 'pg';

const EXECUTE = process.argv.includes('--execute');

const { buildServer } = await import('/app/apps/api/src/server.ts');
const { loadConfig } = await import('/app/apps/api/src/config.ts');
const { recordScan, fulfillRequestItem } = await import('/app/apps/api/src/modules/documents/service.ts');
const { makeMinioClient } = await import('/app/apps/api/src/modules/documents/storage.ts');

const config = loadConfig();
const app = buildServer(config);
await app.ready();
const minio = makeMinioClient(config);

const pending = await app.db.query(
  `SELECT id, contact_id, filename, minio_bucket, minio_key, pending_request_item_id,
          is_test_contact.is_test
     FROM documents
     JOIN LATERAL (SELECT c.is_test FROM contacts c WHERE c.id = documents.contact_id) AS is_test_contact ON true
    WHERE scan_status IN ('pending_scan', 'skipped')
    ORDER BY created_at`
);

console.log(`\nDocuments awaiting a verdict: ${pending.rowCount}`);
const realClientFiles = pending.rows.filter((r) => !r.is_test).length;
console.log(
  realClientFiles === 0
    ? '  All belong to TEST contacts — this is the cheap window Brian meant.'
    : `  ⚠ ${realClientFiles} belong to REAL contacts. Still fine to scan, but the "all test data" assumption no longer holds.`
);

if (!EXECUTE) {
  for (const r of pending.rows.slice(0, 20)) {
    console.log(`  would scan: ${r.filename}  (${r.minio_bucket})`);
  }
  if (pending.rowCount > 20) console.log(`  … and ${pending.rowCount - 20} more`);
  console.log('\nDry run. Re-run with --execute to scan.\n');
  await app.close();
  process.exit(0);
}

const tally = { clean: 0, infected: 0, skipped: 0, pending_scan: 0, unreadable: 0, filed: 0 };

for (const doc of pending.rows) {
  let buffer;
  try {
    const stream = await minio.getObject(doc.minio_bucket, doc.minio_key);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    buffer = Buffer.concat(chunks);
  } catch (err) {
    // The row claims bytes that storage does not have. Not a scan verdict — leave the
    // status alone so it stays visible rather than being quietly marked anything.
    tally.unreadable += 1;
    console.log(`  UNREADABLE ${doc.filename}: ${err.message}`);
    continue;
  }

  const status = await recordScan(app, doc.id, buffer, doc.contact_id, {
    type: 'system',
    label: 'scan backfill',
  });
  tally[status] = (tally[status] ?? 0) + 1;

  // A backfilled clean verdict completes any filing that was waiting on it, exactly
  // as the rescan job would. Otherwise the backfill would mark documents clean and
  // still leave clients being chased for them.
  if (status === 'clean' && doc.pending_request_item_id) {
    await fulfillRequestItem(app, doc.pending_request_item_id, doc.id, doc.contact_id);
    await app.db.query(`UPDATE documents SET pending_request_item_id = NULL WHERE id = $1`, [doc.id]);
    tally.filed += 1;
  }
}

console.log('\nRESULT:', JSON.stringify(tally));

const after = await app.db.query(
  `SELECT scan_status::text AS status, count(*)::int AS n FROM documents GROUP BY scan_status ORDER BY 1`
);
console.log('documents by scan_status:');
for (const r of after.rows) console.log(`  ${r.status.padEnd(14)} ${r.n}`);

if (tally.skipped > 0 || tally.pending_scan > 0) {
  console.log(
    '\n⚠ Some documents still have no verdict — the scanner was unreachable for those.\n' +
      '  The rescan job retries every tick; nothing further to do by hand.'
  );
}

await app.close();
