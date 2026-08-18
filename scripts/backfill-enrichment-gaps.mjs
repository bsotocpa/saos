#!/usr/bin/env node
/**
 * Contacts whose enrichment gap was never queued at all.
 *
 * Found while verifying migration 0077 in production. 0077 recomputed every OPEN enrichment row
 * against the live tables, and the numbers still disagreed afterwards:
 *
 *   contacts owning an unclassified business ....... 322
 *   queue rows saying so ........................... 313
 *
 * The nine are not resolved rows and not archived or test contacts — six inactive clients and
 * three leads with NO enrichment_queue row at any status. The July import created rows only for
 * contacts it marked `imported` with a non-empty gap list; these fell outside that and have been
 * invisible to the queue ever since. 0077 could not reach them because it updates rows that
 * exist, and a row that was never written is not a row with wrong contents.
 *
 * That matters beyond the count: the queue row is what raises the enrichment TASK. No row, no
 * task, no work item — the gap exists in the data and nowhere in anybody's queue. Absence with
 * no record of absence, again.
 *
 * WHY A SCRIPT AND NOT A MIGRATION: the fix has to create the task as well as the row, and tasks
 * are created through `createTask()` — one door, Brian's rule. `refreshEnrichmentGaps()` already
 * does exactly this, so a backfilled gap is indistinguishable from one raised by an edit, task,
 * SOP hook and all. A migration writing the row directly would produce a queue entry with no
 * task, which is the same hole in a different shape.
 *
 * USAGE (inside saos-api-1):
 *   node backfill-enrichment-gaps.mjs            # dry run: who would be queued
 *   node backfill-enrichment-gaps.mjs --execute  # queue them
 *
 * Safe to re-run: only contacts with no open row are considered, so a second run does nothing.
 */

const EXECUTE = process.argv.includes('--execute');

const { buildServer } = await import('/app/apps/api/src/server.ts');
const { loadConfig } = await import('/app/apps/api/src/config.ts');
const { refreshEnrichmentGaps } = await import('/app/apps/api/src/modules/crm/service.ts');

const app = buildServer(loadConfig());
await app.ready();

try {
  /*
   * Every contact with a real gap and no open queue row — not just the entity-type ones. The
   * nine were found through entity_type, but nothing about the cause is specific to that field,
   * so fixing only the symptom would leave the same hole for email, phone, EIN and industry.
   */
  const { rows } = await app.db.query(
    `SELECT c.id,
            COALESCE(c.soto_status::text, '?') AS soto_status,
            EXISTS (SELECT 1 FROM business_members m JOIN businesses b ON b.id = m.business_id
                     WHERE m.contact_id = c.id AND b.entity_type IS NULL) AS blocks_enrolment
       FROM contacts c
      WHERE NOT c.is_archived AND NOT COALESCE(c.is_test, false)
        AND NOT EXISTS (SELECT 1 FROM enrichment_queue q
                         WHERE q.contact_id = c.id AND q.resolved_at IS NULL)
        AND (
          c.email IS NULL OR c.phone IS NULL
          OR EXISTS (SELECT 1 FROM business_members m JOIN businesses b ON b.id = m.business_id
                      WHERE m.contact_id = c.id
                        AND (b.ein IS NULL OR b.entity_type IS NULL OR b.industry IS NULL))
        )
      ORDER BY c.id`
  );

  const byStatus = new Map();
  for (const r of rows) {
    const k = `${r.soto_status}${r.blocks_enrolment ? ' (blocks enrolment)' : ''}`;
    byStatus.set(k, (byStatus.get(k) ?? 0) + 1);
  }
  console.log(`enrichment backfill: ${EXECUTE ? 'EXECUTE' : 'dry run'} — ${rows.length} contact(s) with an unqueued gap`);
  for (const [k, n] of [...byStatus].sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(4)}  ${k}`);

  if (!EXECUTE) {
    console.log('enrichment backfill: DRY RUN — nothing written. Re-run with --execute.');
  } else {
    let queued = 0;
    let noGap = 0;
    for (const r of rows) {
      // refreshEnrichmentGaps recomputes rather than trusting the query above: if a gap closed
      // between the SELECT and here, it resolves instead of queuing a gap that is not one.
      const gaps = await refreshEnrichmentGaps(app, r.id);
      if (gaps.length > 0) queued++;
      else noGap++;
    }
    console.log(`enrichment backfill: EXECUTED — ${queued} queued with a task, ${noGap} had no gap on recompute`);

    const after = await app.db.query(
      `SELECT (SELECT count(DISTINCT m.contact_id) FROM businesses b JOIN business_members m ON m.business_id = b.id
                WHERE b.entity_type IS NULL) AS contacts_owning_unclassified,
              (SELECT count(*) FROM enrichment_queue
                WHERE resolved_at IS NULL AND 'business:entity_type' = ANY(missing_fields)) AS queue_says`
    );
    const a = after.rows[0];
    console.log(
      `enrichment backfill: contacts owning an unclassified business = ${a.contacts_owning_unclassified}, ` +
        `queue rows saying so = ${a.queue_says}` +
        (String(a.contacts_owning_unclassified) === String(a.queue_says)
          ? ' — AGREE'
          : ' — STILL DISAGREE, do not assume this is done')
    );
  }
} finally {
  await app.close();
}
