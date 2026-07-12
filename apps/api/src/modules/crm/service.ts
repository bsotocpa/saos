// CRM support logic: enrichment-gap detection (MP Data Migration: "enrichment
// queue flags missing email/EIN/entity type/industry" — the portal's Step 1
// backfill resolves these).

import type { Db } from '../../db.ts';

/** Compute the currently-missing enrichment fields for a contact. */
export async function computeEnrichmentGaps(db: Db, contactId: string): Promise<string[]> {
  const contact = await db.query<{ email: string | null; phone: string | null }>(
    `SELECT email, phone FROM contacts WHERE id = $1`,
    [contactId]
  );
  const c = contact.rows[0];
  if (!c) return [];

  const gaps = new Set<string>();
  if (!c.email) gaps.add('email');
  if (!c.phone) gaps.add('phone');

  const businesses = await db.query<{ ein: string | null; entity_type: string | null; industry: string | null }>(
    `SELECT b.ein, b.entity_type, b.industry
     FROM businesses b JOIN business_members m ON m.business_id = b.id
     WHERE m.contact_id = $1`,
    [contactId]
  );
  for (const b of businesses.rows) {
    if (!b.ein) gaps.add('ein');
    if (!b.entity_type) gaps.add('entity_type');
    if (!b.industry) gaps.add('industry');
  }
  return [...gaps].sort();
}

/**
 * Keep the enrichment_queue row in sync after any contact/business change.
 * M25: the gap is ALSO a task (no module-local to-do lists) — created when
 * gaps appear, description refreshed as they change, auto-closed when the
 * portal backfill (or staff edit) fills everything. The queue table stays
 * as the machine-readable source the auto-resolution reads.
 */
export async function refreshEnrichmentGaps(db: Db, contactId: string): Promise<string[]> {
  const gaps = await computeEnrichmentGaps(db, contactId);
  if (gaps.length === 0) {
    await db.query(
      `UPDATE enrichment_queue SET resolved_at = now() WHERE contact_id = $1 AND resolved_at IS NULL`,
      [contactId]
    );
    await db.query(
      `UPDATE tasks SET status = 'completed', completed_at = now(), updated_at = now()
       WHERE contact_id = $1 AND source_type = 'enrichment' AND status IN ('not_started', 'in_progress', 'waiting_for_input', 'deferred')`,
      [contactId]
    );
  } else {
    const open = await db.query<{ id: string }>(
      `SELECT id FROM enrichment_queue WHERE contact_id = $1 AND resolved_at IS NULL`,
      [contactId]
    );
    let queueId: string;
    if (open.rows[0]) {
      queueId = open.rows[0].id;
      await db.query(`UPDATE enrichment_queue SET missing_fields = $2 WHERE id = $1`, [queueId, gaps]);
    } else {
      const ins = await db.query<{ id: string }>(
        `INSERT INTO enrichment_queue (contact_id, missing_fields) VALUES ($1, $2) RETURNING id`,
        [contactId, gaps]
      );
      queueId = ins.rows[0]!.id;
    }
    const description =
      'Missing: ' + gaps.join(', ') + '. Portal first-login backfill resolves most of these automatically.';
    await db.query(
      `INSERT INTO tasks (title, description, contact_id, source, source_type, source_id)
       SELECT 'Complete missing client info: ' || c.first_name || ' ' || c.last_name, $3, $1, 'system', 'enrichment', $2
       FROM contacts c WHERE c.id = $1
         AND NOT EXISTS (
           SELECT 1 FROM tasks t
           WHERE t.source_type = 'enrichment' AND t.source_id = $2 AND t.status IN ('not_started', 'in_progress', 'waiting_for_input', 'deferred')
         )`,
      [contactId, queueId, description]
    );
    await db.query(
      `UPDATE tasks SET description = $3, updated_at = now()
       WHERE source_type = 'enrichment' AND source_id = $2 AND contact_id = $1 AND status IN ('not_started', 'in_progress', 'waiting_for_input', 'deferred')`,
      [contactId, queueId, description]
    );
  }
  return gaps;
}
