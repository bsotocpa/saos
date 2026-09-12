/*
 * CONTACT MERGE (2026-09-12, Brian: "Don't archive. Merge.").
 *
 * Two records for one person: a winner keeps its identity; every row the losers hold is
 * reparented to the winner, one audit row per object; the losers are archived with
 * merged_into_contact_id and nothing else. The import flagged duplicates by name (Francisco
 * Martinez, Mathew Alvarez) and Brian himself has three records, so this is a route, not a script.
 *
 * REFUSED when both sides hold an active or on-hold engagement on the same (line, period,
 * entity): that is two agreements for the same work, a real conflict for a person to settle,
 * not a merge.
 *
 * FAIL CLOSED on an orphan. After reparenting, every contact-keyed column in the schema is
 * scanned at runtime (information_schema, not this file's list); a loser row left anywhere
 * aborts the transaction. So the static list below can be wrong and the merge still cannot
 * leave a row behind; it can only refuse.
 */
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types.ts';
import { writeAudit } from '../../audit.ts';
import { withTransaction } from '../../db.ts';

/**
 * The tables reparented by `UPDATE ... SET contact_id = winner WHERE contact_id = loser`, with
 * how their audit is written. `rows`: one audit row per reparented row (the record of what
 * moved). `summary`: log-like tables, one audit row per table with the count.
 */
const REPARENT: Array<{ table: string; audit: 'rows' | 'summary' }> = [
  { table: 'business_members', audit: 'rows' },
  { table: 'engagements', audit: 'rows' },
  { table: 'invoices', audit: 'rows' },
  { table: 'documents', audit: 'rows' },
  { table: 'tasks', audit: 'rows' },
  { table: 'quotes', audit: 'rows' },
  { table: 'engagement_packets', audit: 'rows' },
  { table: 'packet_signatures', audit: 'rows' },
  { table: 'signature_envelopes', audit: 'rows' },
  { table: 'consents', audit: 'rows' },
  { table: 'meetings', audit: 'rows' },
  { table: 'irs_notices', audit: 'rows' },
  { table: 'resolution_cases', audit: 'rows' },
  { table: 'form_submissions', audit: 'rows' },
  { table: 'referrals', audit: 'rows' },
  { table: 'document_requests', audit: 'rows' },
  { table: 'message_threads', audit: 'rows' },
  { table: 'inbound_attachments', audit: 'rows' },
  { table: 'attest_addenda', audit: 'rows' },
  { table: 'pllc_conversions', audit: 'rows' },
  { table: 'entity_group_members', audit: 'rows' },
  { table: 'close_cycles', audit: 'rows' },
  { table: 'client_sessions', audit: 'rows' },
  { table: 'client_bookings', audit: 'rows' },
  { table: 'event_registrations', audit: 'rows' },
  { table: 'review_requests', audit: 'rows' },
  { table: 'time_entries', audit: 'rows' },
  { table: 'portal_onboarding', audit: 'rows' },
  { table: 'enrichment_queue', audit: 'summary' },
  { table: 'import_records', audit: 'summary' },
  { table: 'lead_stage_history', audit: 'summary' },
  { table: 'notifications', audit: 'summary' },
  { table: 'outbox', audit: 'summary' },
  { table: 'broadcast_recipients', audit: 'summary' },
  // NOT audit_log. It is append-only by trigger (WISP): history is never rewritten, so the
  // loser's rows stay as written and the winner reaches them through merged_into_contact_id.
];

/** Contact-keyed tables the merge deliberately leaves alone: history, read through the link. */
const HISTORY_TABLES = new Set(['audit_log']);

export interface MergeActor { id: string; email: string; fullName: string }

/** Every row anywhere that still points at `contactId`, by table. Runtime, from the catalog. */
export async function contactReferences(app: FastifyInstance, contactId: string): Promise<Record<string, number>> {
  const cols = await app.db.query<{ table_name: string; column_name: string }>(
    `SELECT c.table_name, c.column_name FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name <> 'contacts'
        AND (c.column_name = 'contact_id' OR (c.table_name = 'contacts' AND c.column_name = 'referred_by_contact_id'))
      ORDER BY 1`
  );
  const out: Record<string, number> = {};
  for (const c of cols.rows) {
    if (HISTORY_TABLES.has(c.table_name)) continue;
    const r = await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM ${c.table_name} WHERE ${c.column_name} = $1`, [contactId]);
    if (Number(r.rows[0]!.n) > 0) out[c.table_name] = Number(r.rows[0]!.n);
  }
  const referred = await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM contacts WHERE referred_by_contact_id = $1`, [contactId]);
  if (Number(referred.rows[0]!.n) > 0) out['contacts.referred_by_contact_id'] = Number(referred.rows[0]!.n);
  return out;
}

export interface MergeResult {
  winnerId: string;
  losers: Array<{ id: string; moved: Record<string, number>; portalUserRetired: boolean; duplicateAcceptancesDropped: string[] }>;
}

export async function mergeContacts(
  app: FastifyInstance,
  winnerId: string,
  loserIds: string[],
  reason: string,
  actor: MergeActor,
  meta: { ip?: string | null; userAgent?: string | null } = {}
): Promise<MergeResult> {
  const ids = [...new Set(loserIds)].filter((id) => id !== winnerId);
  if (ids.length === 0) throw new AppError(400, 'no_losers', 'Name at least one other record to merge into this one.');
  const contacts = await app.db.query<{ id: string; first_name: string; last_name: string; is_archived: boolean; contact_status: string }>(
    `SELECT id, first_name, last_name, is_archived, contact_status::text AS contact_status FROM contacts WHERE id = ANY($1::uuid[])`,
    [[winnerId, ...ids]]
  );
  const byId = new Map(contacts.rows.map((c) => [c.id, c]));
  const winner = byId.get(winnerId);
  if (!winner) throw new AppError(404, 'not_found', 'The winning record does not exist.');
  if (winner.is_archived || winner.contact_status === 'archived') throw new AppError(409, 'winner_archived', 'The winner is archived; pick the record that stays.');
  for (const id of ids) if (!byId.get(id)) throw new AppError(404, 'not_found', `Record ${id} does not exist.`);

  // THE CONFLICT: active work on both sides for the same line, period and entity.
  const conflicts = await app.db.query<{ line: string; period_key: string | null; a: string; b: string }>(
    `SELECT a.service_line::text AS line, a.period_key, a.id AS a, b.id AS b
       FROM engagements a JOIN engagements b
         ON b.service_line = a.service_line AND b.period_key IS NOT DISTINCT FROM a.period_key
        AND COALESCE(b.business_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(a.business_id, '00000000-0000-0000-0000-000000000000'::uuid)
      WHERE a.contact_id = $1 AND b.contact_id = ANY($2::uuid[])
        AND a.status IN ('active', 'on_hold') AND b.status IN ('active', 'on_hold')`,
    [winnerId, ids]
  );
  if (conflicts.rows.length > 0) {
    const c = conflicts.rows[0]!;
    throw new AppError(
      409,
      'merge_conflict',
      `Both records hold an active ${c.line} engagement for ${c.period_key ?? 'an open period'} (${c.a} and ${c.b}). Two agreements for the same work is a change order or a withdrawal, not a merge; settle it first.`
    );
  }

  return withTransaction(app.db, async () => {
    const result: MergeResult = { winnerId, losers: [] };
    for (const loserId of ids) {
      const loser = byId.get(loserId)!;
      const moved: Record<string, number> = {};
      let portalUserRetired = false;
      const duplicateAcceptancesDropped: string[] = [];

      // The portal user: one per contact. The winner's stays; a loser's is retired if the winner has one.
      const winnerPortal = await app.db.query(`SELECT 1 FROM portal_users WHERE contact_id = $1`, [winnerId]);
      const loserPortal = await app.db.query<{ id: string }>(`SELECT id FROM portal_users WHERE contact_id = $1`, [loserId]);
      for (const pu of loserPortal.rows) {
        if (winnerPortal.rows.length === 0) {
          await app.db.query(`UPDATE portal_users SET contact_id = $2 WHERE id = $1`, [pu.id, winnerId]);
          moved.portal_users = (moved.portal_users ?? 0) + 1;
          await writeAudit(app.db, { actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName, action: 'contact.merged_object', objectType: 'portal_user', objectId: pu.id, contactId: winnerId, ...meta, details: { from: loserId } });
        } else {
          // One sign-in per contact (UNIQUE): the winner's stays, the loser's is retired. A sign-in
          // that SIGNED something is a signer's identity and cannot be removed; that merge waits.
          const signed = await app.db.query(`SELECT 1 FROM packet_signatures WHERE portal_user_id = $1 LIMIT 1`, [pu.id]);
          if (signed.rows.length > 0) {
            throw new AppError(409, 'merge_signer_identity', 'Both records have a portal sign-in and the losing one signed an engagement packet. That sign-in is a signer\'s identity and cannot be retired; keep that record as the winner instead.');
          }
          const who = await app.db.query<{ email: string }>(`SELECT email FROM portal_users WHERE id = $1`, [pu.id]);
          await app.db.query(`DELETE FROM portal_users WHERE id = $1`, [pu.id]); // sessions and sign-in links cascade
          portalUserRetired = true;
          await writeAudit(app.db, { actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName, action: 'contact.merged_portal_user_retired', objectType: 'portal_user', objectId: pu.id, contactId: winnerId, ...meta, details: { from: loserId, email: who.rows[0]?.email ?? null, reason: 'the winner already has a portal sign-in' } });
        }
      }

      // Schedule acceptances: one per code per contact. The winner's stands; a duplicate on the loser is dropped, on the record.
      const dup = await app.db.query<{ id: string; schedule_code: string }>(
        `SELECT l.id, l.schedule_code FROM schedule_acceptances l
          WHERE l.contact_id = $1 AND EXISTS (SELECT 1 FROM schedule_acceptances w WHERE w.contact_id = $2 AND w.schedule_code = l.schedule_code)`,
        [loserId, winnerId]
      );
      for (const d of dup.rows) {
        await app.db.query(`DELETE FROM schedule_acceptances WHERE id = $1`, [d.id]);
        duplicateAcceptancesDropped.push(d.schedule_code);
        await writeAudit(app.db, { actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName, action: 'contact.merged_duplicate_acceptance', objectType: 'schedule_acceptance', objectId: d.id, contactId: winnerId, ...meta, details: { from: loserId, schedule_code: d.schedule_code, kept: 'the winner\'s acceptance of the same schedule' } });
      }
      const acc = await app.db.query(`UPDATE schedule_acceptances SET contact_id = $2 WHERE contact_id = $1`, [loserId, winnerId]);
      if (acc.rowCount) moved.schedule_acceptances = acc.rowCount;

      // A business both records belong to: one membership, the winner's.
      const dupMember = await app.db.query<{ business_id: string }>(
        `SELECT l.business_id FROM business_members l
          WHERE l.contact_id = $1 AND EXISTS (SELECT 1 FROM business_members w WHERE w.contact_id = $2 AND w.business_id = l.business_id)`,
        [loserId, winnerId]
      );
      for (const m of dupMember.rows) {
        await app.db.query(`DELETE FROM business_members WHERE contact_id = $1 AND business_id = $2`, [loserId, m.business_id]);
        await writeAudit(app.db, { actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName, action: 'contact.merged_duplicate_membership', objectType: 'business', objectId: m.business_id, contactId: winnerId, ...meta, details: { from: loserId } });
      }

      for (const t of REPARENT) {
        // Not every table has an id (business_members is keyed by its pair); the row comes back whole.
        const r = await app.db.query<{ row: Record<string, unknown> }>(`UPDATE ${t.table} x SET contact_id = $2 WHERE contact_id = $1 RETURNING to_jsonb(x) AS row`, [loserId, winnerId]);
        if (!r.rowCount) continue;
        moved[t.table] = r.rowCount;
        if (t.audit === 'rows') {
          for (const { row } of r.rows) {
            const objectId = typeof row.id === 'string' ? row.id : typeof row.business_id === 'string' ? row.business_id : null;
            await writeAudit(app.db, { actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName, action: 'contact.merged_object', objectType: t.table, objectId, contactId: winnerId, ...meta, details: { from: loserId } });
          }
        } else {
          await writeAudit(app.db, { actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName, action: 'contact.merged_rows', objectType: t.table, objectId: null, contactId: winnerId, ...meta, details: { from: loserId, count: r.rowCount } });
        }
      }
      const ref = await app.db.query(`UPDATE contacts SET referred_by_contact_id = $2 WHERE referred_by_contact_id = $1`, [loserId, winnerId]);
      if (ref.rowCount) moved['contacts.referred_by_contact_id'] = ref.rowCount;

      // Nothing may be left behind. The scan reads the catalog, not the list above.
      const left = await contactReferences(app, loserId);
      if (Object.keys(left).length > 0) {
        throw new AppError(500, 'merge_orphans', `The merge would leave rows behind on the losing record: ${JSON.stringify(left)}. Nothing was changed.`);
      }

      // The loser: archived, pointing at the winner, nothing else. Archiving after reparenting is what the invariant allows.
      await app.db.query(
        `UPDATE contacts SET is_archived = true, contact_status = 'archived', contact_status_at = now(),
                archived_reason = $3, soto_status = 'former', merged_into_contact_id = $2
          WHERE id = $1`,
        [loserId, winnerId, `Merged into the record for ${winner.first_name} ${winner.last_name}: ${reason}`]
      );
      await writeAudit(app.db, {
        actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
        action: 'contact.merged', objectType: 'contact', objectId: loserId, contactId: winnerId, ...meta,
        details: { winner: winnerId, loser: loserId, loser_name: `${loser.first_name} ${loser.last_name}`, reason, moved, portal_user_retired: portalUserRetired, duplicate_acceptances_dropped: duplicateAcceptancesDropped },
      });
      result.losers.push({ id: loserId, moved, portalUserRetired, duplicateAcceptancesDropped });
    }

    // The winner's lifecycle is derived from what it now holds.
    const { refreshContactStatus } = await import('./lifecycle.ts');
    await refreshContactStatus(app, winnerId, 'contact_merge');
    return result;
  });
}
