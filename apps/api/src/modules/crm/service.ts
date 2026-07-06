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

/** Keep the enrichment_queue row in sync after any contact/business change. */
export async function refreshEnrichmentGaps(db: Db, contactId: string): Promise<string[]> {
  const gaps = await computeEnrichmentGaps(db, contactId);
  if (gaps.length === 0) {
    await db.query(
      `UPDATE enrichment_queue SET resolved_at = now() WHERE contact_id = $1 AND resolved_at IS NULL`,
      [contactId]
    );
  } else {
    const open = await db.query<{ id: string }>(
      `SELECT id FROM enrichment_queue WHERE contact_id = $1 AND resolved_at IS NULL`,
      [contactId]
    );
    if (open.rows[0]) {
      await db.query(`UPDATE enrichment_queue SET missing_fields = $2 WHERE id = $1`, [open.rows[0].id, gaps]);
    } else {
      await db.query(`INSERT INTO enrichment_queue (contact_id, missing_fields) VALUES ($1, $2)`, [contactId, gaps]);
    }
  }
  return gaps;
}
