// CRM support logic: enrichment-gap detection (MP Data Migration: "enrichment
// queue flags missing email/EIN/entity type/industry" — the portal's Step 1
// backfill resolves these).

import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db.ts';
import { createTask } from '../tasks/service.ts';

/*
 * ONE VOCABULARY FOR ONE GAP (2026-08-17).
 *
 * These names used to disagree with themselves. The July import wrote business-level gaps
 * PREFIXED — `business:entity_type`, 304 open rows — and this function wrote them BARE:
 * `entity_type`. Same column, same meaning, two spellings, and the bare form appeared only after
 * a contact happened to be edited. Production is 304 prefixed against 1 bare, which is what a
 * silent divergence looks like: not a crash, a slow drift with no reader noticing.
 *
 * Anything filtering on one name misses the other, and the first such filter was the entity-type
 * classification pass. Prefixed wins because it carries information the bare form does not —
 * that the gap is about a BUSINESS, not the person. Migration 0077 converts the strays.
 */
export const BUSINESS_GAP_PREFIX = 'business:';

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
    if (!b.ein) gaps.add(`${BUSINESS_GAP_PREFIX}ein`);
    if (!b.entity_type) gaps.add(`${BUSINESS_GAP_PREFIX}entity_type`);
    if (!b.industry) gaps.add(`${BUSINESS_GAP_PREFIX}industry`);
  }
  return [...gaps].sort();
}

/**
 * Which of this contact's businesses are missing an entity type, by name.
 *
 * `business:entity_type` says a gap exists; it does not say WHERE, and a contact can own several
 * businesses. Without the name the task is a hunt, and a task nobody can act on directly is the
 * reason 611 enrichment rows sat untouched.
 */
async function businessesMissingEntityType(db: Db, contactId: string): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT b.name FROM businesses b JOIN business_members m ON m.business_id = b.id
      WHERE m.contact_id = $1 AND b.entity_type IS NULL ORDER BY b.name`,
    [contactId]
  );
  return rows.map((r) => r.name);
}

/**
 * Keep the enrichment_queue row in sync after any contact/business change.
 * M25: the gap is ALSO a task (no module-local to-do lists) — created when
 * gaps appear, description refreshed as they change, auto-closed when the
 * portal backfill (or staff edit) fills everything. The queue table stays
 * as the machine-readable source the auto-resolution reads.
 */
/*
 * Takes `app`, not a bare `Db` (2026-08-17). It creates a task now, and `createTask()` is the
 * only door for that — see Brian's rule. Every caller already had `app` in scope and was
 * passing `app.db`, so this is a narrower change than it looks.
 */
export async function refreshEnrichmentGaps(app: FastifyInstance, contactId: string): Promise<string[]> {
  const db = app.db;
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
    /*
     * The entity-type gap names its businesses, because that one blocks something specific:
     * nothing enrols in annual-report tracking on an unknown type (Brian's scope ruling), and
     * "Missing: business:entity_type" does not tell you which of their companies to look up.
     */
    const unclassified = gaps.includes(`${BUSINESS_GAP_PREFIX}entity_type`)
      ? await businessesMissingEntityType(db, contactId)
      : [];
    const description =
      'Missing: ' +
      gaps.join(', ') +
      '. Portal first-login backfill resolves most of these automatically.' +
      (unclassified.length > 0
        ? `\n\nEntity type unknown for: ${unclassified.join(', ')}. ` +
          `Until it is set, none of these can be enrolled in annual-report tracking — an unknown ` +
          `type is not the same as "owes nothing", and we do not guess in either direction.`
        : '');
    /*
     * Through `createTask()` like every other work item (Brian's rule, 2026-08-17: one door
     * for work creation).
     *
     * The hand-written `NOT EXISTS` this replaced was `createTask`'s own dedupe, spelled out
     * in SQL: same (source_type, source_id), same open-status list. Deleting it is not a loss
     * of protection — it is the same protection, in the place that cannot be forgotten. And
     * the SOP hook now applies, which a raw insert silently skipped.
     */
    const { rows: who } = await db.query<{ name: string }>(
      `SELECT first_name || ' ' || last_name AS name FROM contacts WHERE id = $1`,
      [contactId]
    );
    if (who[0]) {
      await createTask(app, {
        title: `Complete missing client info: ${who[0].name}`,
        description,
        contactId,
        source: 'system',
        sourceType: 'enrichment',
        sourceId: queueId,
      });
    }
    await db.query(
      `UPDATE tasks SET description = $3, updated_at = now()
       WHERE source_type = 'enrichment' AND source_id = $2 AND contact_id = $1 AND status IN ('not_started', 'in_progress', 'waiting_for_input', 'deferred')`,
      [contactId, queueId, description]
    );
  }
  return gaps;
}
