/*
 * BUSINESSES, PARITY WITH CONTACTS (2026-09-12 evening, Brian's ruling 3).
 *
 * A business is archived, never deleted; flagged as test residue with a note; merged into a
 * winner the same way a contact is (every business-keyed row reparented, one audit row per
 * object, the loser archived pointing at the winner, a catalog scan refusing to leave a row
 * behind). Archiving a primary business clears the flag; nothing is promoted in its place, the
 * page says "no primary business set" and a person chooses.
 */
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types.ts';
import { writeAudit } from '../../audit.ts';
import { withTransaction } from '../../db.ts';

export interface BusinessActor { id: string; email: string; fullName: string }
type Meta = { ip?: string | null; userAgent?: string | null };

const REPARENT: Array<{ table: string; audit: 'rows' | 'summary' }> = [
  { table: 'engagements', audit: 'rows' },
  { table: 'quotes', audit: 'rows' },
  { table: 'documents', audit: 'rows' },
  { table: 'tasks', audit: 'rows' },
  { table: 'irs_notices', audit: 'rows' },
  { table: 'resolution_cases', audit: 'rows' },
  { table: 'pllc_conversions', audit: 'rows' },
  { table: 'entity_compliance', audit: 'rows' },
  { table: 'entity_group_members', audit: 'rows' },
  { table: 'close_cycles', audit: 'rows' },
];

/** Every row anywhere that still points at `businessId`, by table. Runtime, from the catalog. */
export async function businessReferences(app: FastifyInstance, businessId: string): Promise<Record<string, number>> {
  const cols = await app.db.query<{ table_name: string }>(
    `SELECT c.table_name FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.column_name = 'business_id' AND c.table_name <> 'businesses' ORDER BY 1`
  );
  const out: Record<string, number> = {};
  for (const c of cols.rows) {
    const r = await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM ${c.table_name} WHERE business_id = $1`, [businessId]);
    if (Number(r.rows[0]!.n) > 0) out[c.table_name] = Number(r.rows[0]!.n);
  }
  const merged = await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM businesses WHERE merged_into_business_id = $1`, [businessId]);
  if (Number(merged.rows[0]!.n) > 0) out['businesses.merged_into_business_id'] = Number(merged.rows[0]!.n);
  return out;
}

export async function archiveBusiness(
  app: FastifyInstance,
  businessId: string,
  input: { reason: string; isTest?: boolean | undefined; testNote?: string | undefined },
  actor: BusinessActor,
  meta: Meta = {}
): Promise<{ archived: true; primaryCleared: number }> {
  const b = await app.db.query<{ id: string; name: string; is_archived: boolean }>(`SELECT id, name, is_archived FROM businesses WHERE id = $1`, [businessId]);
  if (!b.rows[0]) throw new AppError(404, 'not_found', 'Business not found.');
  if (b.rows[0].is_archived) throw new AppError(409, 'already_archived', `${b.rows[0].name} is already archived.`);
  if (input.isTest && !input.testNote) throw new AppError(400, 'test_note_required', 'A test flag carries a note saying what the test was.');
  const open = await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM engagements WHERE business_id = $1 AND status IN ('active', 'on_hold')`, [businessId]);
  if (Number(open.rows[0]!.n) > 0) throw new AppError(409, 'business_has_active_work', `${b.rows[0].name} holds active work; withdraw or complete it, or merge the business, before archiving.`);

  return withTransaction(app.db, async () => {
    // A primary that goes away is not replaced by promotion: the page says so and a person chooses.
    const cleared = await app.db.query<{ contact_id: string }>(
      `UPDATE business_members SET is_primary = false WHERE business_id = $1 AND is_primary RETURNING contact_id`, [businessId]
    );
    for (const c of cleared.rows) {
      await writeAudit(app.db, { actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName, action: 'business.primary_cleared', objectType: 'business', objectId: businessId, contactId: c.contact_id, ...meta, details: { reason: 'archived' } });
    }
    await app.db.query(
      `UPDATE businesses SET is_archived = true, archived_at = now(), archived_reason = $2,
              is_test = COALESCE($3, is_test), test_note = COALESCE($4, test_note)
        WHERE id = $1`,
      [businessId, input.reason, input.isTest ?? null, input.testNote ?? null]
    );
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
      action: 'business.archived', objectType: 'business', objectId: businessId, ...meta,
      details: { name: b.rows[0]!.name, reason: input.reason, is_test: input.isTest ?? false, primary_cleared: cleared.rowCount ?? 0 },
    });
    return { archived: true, primaryCleared: cleared.rowCount ?? 0 };
  });
}

export interface BusinessMergeResult { winnerId: string; losers: Array<{ id: string; moved: Record<string, number> }> }

export async function mergeBusinesses(
  app: FastifyInstance,
  winnerId: string,
  loserIds: string[],
  reason: string,
  actor: BusinessActor,
  meta: Meta = {}
): Promise<BusinessMergeResult> {
  const ids = [...new Set(loserIds)].filter((id) => id !== winnerId);
  if (ids.length === 0) throw new AppError(400, 'no_losers', 'Name at least one other business to merge into this one.');
  const rows = await app.db.query<{ id: string; name: string; is_archived: boolean }>(`SELECT id, name, is_archived FROM businesses WHERE id = ANY($1::uuid[])`, [[winnerId, ...ids]]);
  const byId = new Map(rows.rows.map((r) => [r.id, r]));
  const winner = byId.get(winnerId);
  if (!winner) throw new AppError(404, 'not_found', 'The winning business does not exist.');
  if (winner.is_archived) throw new AppError(409, 'winner_archived', 'The winner is archived; pick the record that stays.');
  for (const id of ids) if (!byId.get(id)) throw new AppError(404, 'not_found', `Business ${id} does not exist.`);

  // The same conflict rule as contacts: active work on both sides for the same line and period.
  const conflicts = await app.db.query<{ line: string; period_key: string | null }>(
    `SELECT a.service_line::text AS line, a.period_key FROM engagements a JOIN engagements b
        ON b.service_line = a.service_line AND b.period_key IS NOT DISTINCT FROM a.period_key AND b.contact_id = a.contact_id
      WHERE a.business_id = $1 AND b.business_id = ANY($2::uuid[]) AND a.status IN ('active', 'on_hold') AND b.status IN ('active', 'on_hold')`,
    [winnerId, ids]
  );
  if (conflicts.rows[0]) {
    throw new AppError(409, 'merge_conflict', `Both businesses hold an active ${conflicts.rows[0].line} engagement for ${conflicts.rows[0].period_key ?? 'an open period'}; settle that first.`);
  }

  return withTransaction(app.db, async () => {
    const result: BusinessMergeResult = { winnerId, losers: [] };
    for (const loserId of ids) {
      const moved: Record<string, number> = {};
      // Memberships: a person on both stays once, on the winner; a loser-only membership moves. Never a second primary.
      const dup = await app.db.query(`DELETE FROM business_members l WHERE l.business_id = $1 AND EXISTS (SELECT 1 FROM business_members w WHERE w.business_id = $2 AND w.contact_id = l.contact_id) RETURNING contact_id`, [loserId, winnerId]);
      for (const d of dup.rows as Array<{ contact_id: string }>) {
        await writeAudit(app.db, { actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName, action: 'business.merged_duplicate_membership', objectType: 'business', objectId: winnerId, contactId: d.contact_id, ...meta, details: { from: loserId } });
      }
      const winnersPrimary = await app.db.query<{ contact_id: string }>(`SELECT contact_id FROM business_members WHERE business_id = $1 AND is_primary`, [winnerId]);
      const primaries = new Set(winnersPrimary.rows.map((r) => r.contact_id));
      const members = await app.db.query<{ contact_id: string; is_primary: boolean }>(`SELECT contact_id, is_primary FROM business_members WHERE business_id = $1`, [loserId]);
      for (const m of members.rows) {
        const keepPrimary = m.is_primary && !primaries.has(m.contact_id) && !(await app.db.query(`SELECT 1 FROM business_members WHERE contact_id = $1 AND is_primary AND business_id <> $2`, [m.contact_id, loserId])).rows.length;
        await app.db.query(`UPDATE business_members SET business_id = $3, is_primary = $4 WHERE business_id = $1 AND contact_id = $2`, [loserId, m.contact_id, winnerId, keepPrimary]);
        moved.business_members = (moved.business_members ?? 0) + 1;
        await writeAudit(app.db, { actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName, action: 'business.merged_object', objectType: 'business_members', objectId: winnerId, contactId: m.contact_id, ...meta, details: { from: loserId } });
      }
      for (const t of REPARENT) {
        const r = await app.db.query<{ row: Record<string, unknown> }>(`UPDATE ${t.table} x SET business_id = $2 WHERE business_id = $1 RETURNING to_jsonb(x) AS row`, [loserId, winnerId]);
        if (!r.rowCount) continue;
        moved[t.table] = r.rowCount;
        for (const { row } of r.rows) {
          await writeAudit(app.db, { actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName, action: 'business.merged_object', objectType: t.table, objectId: typeof row.id === 'string' ? row.id : null, ...meta, details: { from: loserId, to: winnerId } });
        }
      }
      const left = await businessReferences(app, loserId);
      if (Object.keys(left).length > 0) throw new AppError(500, 'merge_orphans', `The merge would leave rows behind on the losing business: ${JSON.stringify(left)}. Nothing was changed.`);
      await app.db.query(
        `UPDATE businesses SET is_archived = true, archived_at = now(), archived_reason = $3, merged_into_business_id = $2 WHERE id = $1`,
        [loserId, winnerId, `Merged into ${winner.name}: ${reason}`]
      );
      await writeAudit(app.db, {
        actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
        action: 'business.merged', objectType: 'business', objectId: loserId, ...meta,
        details: { winner: winnerId, loser: loserId, loser_name: byId.get(loserId)!.name, reason, moved },
      });
      result.losers.push({ id: loserId, moved });
    }
    return result;
  });
}
