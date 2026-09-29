/*
 * SAME-NAME PAIRS WITHOUT A SPREADSHEET (Brian, 2026-09-29, R97).
 *
 * "Most of the name-only pairs are one person recorded twice by Dubsado (a business onboarding under
 * the owner's name, a dependent's return, or an abandoned onboarding restarted)." A name-only pair is
 * two live, non-test records with one name and no shared email, phone or address (a shared one makes
 * it a merge proposal, R92's). The protected names are never read here: nothing touches them.
 *
 *   One side holds nothing   (no engagement, quote, document, invoice, task or portal user; and no
 *                            business membership, so no business is left owned by an archived record)
 *                            → the empty record is archived with a redirect to the other, audited
 *                            "Empty duplicate from the Dubsado migration", no merge. Both empty: the
 *                            newer is archived and the older kept.
 *   Both hold something     → an open suggestion: both client pages carry the banner until a person
 *                            merges them (the R92 door, CEO-only) or dismisses it with a reason.
 */
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types.ts';
import { writeAudit } from '../../audit.ts';
import { PROTECTED_NAMES, norm } from './duplicates.ts';
import { sharedIdentifiers } from './merge.ts';

export const EMPTY_DUPLICATE_REASON = 'Empty duplicate from the Dubsado migration';
interface Actor { id: string; fullName: string }

/** Every name-only pair among live, non-test records, protected names left out; a < b. */
export async function nameOnlyPairs(app: FastifyInstance): Promise<Array<{ a: string; b: string; name: string }>> {
  const { rows } = await app.db.query<{ id: string; name: string; created_at: Date }>(
    `SELECT c.id, btrim(c.first_name || ' ' || c.last_name) AS name, c.created_at
       FROM contacts c
      WHERE NOT c.is_archived AND c.contact_status <> 'archived' AND NOT c.is_test AND c.merged_into_contact_id IS NULL
        AND lower(regexp_replace(btrim(c.first_name || ' ' || c.last_name), '\\s+', ' ', 'g')) IN (
          SELECT lower(regexp_replace(btrim(first_name || ' ' || last_name), '\\s+', ' ', 'g'))
            FROM contacts WHERE NOT is_archived AND contact_status <> 'archived' AND NOT is_test AND merged_into_contact_id IS NULL
           GROUP BY 1 HAVING count(*) > 1)
      ORDER BY c.created_at, c.id`
  );
  const byName = new Map<string, Array<{ id: string; name: string }>>();
  for (const r of rows) {
    const key = norm(r.name);
    if (PROTECTED_NAMES.has(key)) continue;
    byName.set(key, [...(byName.get(key) ?? []), { id: r.id, name: r.name }]);
  }
  const pairs: Array<{ a: string; b: string; name: string }> = [];
  for (const records of byName.values()) {
    for (let i = 0; i < records.length; i++) {
      for (let j = i + 1; j < records.length; j++) {
        const x = records[i]!, y = records[j]!;
        if ((await sharedIdentifiers(app, x.id, y.id)).length > 0) continue; // a merge proposal, R92's
        const [a, b] = x.id < y.id ? [x.id, y.id] : [y.id, x.id];
        pairs.push({ a, b, name: x.name });
      }
    }
  }
  return pairs;
}

/** What a record holds, in the ruling's terms (plus business memberships). */
export async function holdings(app: FastifyInstance, contactId: string): Promise<{ total: number; createdAt: Date }> {
  const { rows } = await app.db.query<{ n: number; created_at: Date }>(
    `SELECT ((SELECT count(*) FROM engagements WHERE contact_id = c.id) + (SELECT count(*) FROM quotes WHERE contact_id = c.id)
           + (SELECT count(*) FROM documents WHERE contact_id = c.id) + (SELECT count(*) FROM invoices WHERE contact_id = c.id)
           + (SELECT count(*) FROM tasks WHERE contact_id = c.id) + (SELECT count(*) FROM portal_users WHERE contact_id = c.id)
           + (SELECT count(*) FROM business_members WHERE contact_id = c.id))::int AS n, c.created_at
       FROM contacts c WHERE c.id = $1`,
    [contactId]
  );
  return { total: rows[0]?.n ?? 0, createdAt: rows[0]!.created_at };
}

/** Archive the empty record of a pair with a redirect to the other; audited in the ruling's words. */
async function archiveEmpty(app: FastifyInstance, actor: Actor, emptyId: string, keptId: string): Promise<void> {
  await app.db.query(
    `UPDATE contacts SET contact_status = 'archived', contact_status_at = now(), is_archived = true,
            archived_reason = $3, soto_status = 'former', merged_into_contact_id = $2
      WHERE id = $1`,
    [emptyId, keptId, EMPTY_DUPLICATE_REASON]
  );
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
    action: 'contact.archived', objectType: 'contact', objectId: emptyId, contactId: keptId,
    details: { reason: EMPTY_DUPLICATE_REASON, kind: 'empty_duplicate', redirect_to: keptId, merged: false },
  });
}

/**
 * The pass: every name-only pair resolved by rule. Idempotent: an archived record leaves the pairs,
 * and a pair already suggested is not suggested twice. `apply: false` counts without writing.
 */
export async function resolveSameNamePairs(app: FastifyInstance, actor: Actor, opts: { apply: boolean }) {
  const counts = { pairs: 0, empty_archived: 0, both_empty_newer_archived: 0, suggested: 0, already_suggested: 0, skipped_archived_this_pass: 0 };
  const archived = new Set<string>();
  for (const p of await nameOnlyPairs(app)) {
    counts.pairs++;
    if (archived.has(p.a) || archived.has(p.b)) { counts.skipped_archived_this_pass++; continue; }
    const [ha, hb] = [await holdings(app, p.a), await holdings(app, p.b)];
    if (ha.total === 0 || hb.total === 0) {
      let empty: string; let kept: string;
      if (ha.total === 0 && hb.total === 0) {
        counts.both_empty_newer_archived++;
        [empty, kept] = ha.createdAt > hb.createdAt ? [p.a, p.b] : [p.b, p.a];
      } else {
        counts.empty_archived++;
        [empty, kept] = ha.total === 0 ? [p.a, p.b] : [p.b, p.a];
      }
      if (opts.apply) await archiveEmpty(app, actor, empty, kept);
      archived.add(empty);
      continue;
    }
    if (!opts.apply) { counts.suggested++; continue; }
    const ins = await app.db.query(
      `INSERT INTO contact_duplicate_suggestions (a_contact_id, b_contact_id) VALUES ($1, $2) ON CONFLICT (a_contact_id, b_contact_id) DO NOTHING`,
      [p.a, p.b]
    );
    if (ins.rowCount) counts.suggested++; else counts.already_suggested++;
  }
  if (opts.apply) {
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
      action: 'contact.same_name_pairs_resolved', objectType: 'contact', objectId: null, details: counts,
    });
  }
  return counts;
}

/** The open suggestions a client page shows as banners: the other record's id and name. */
export async function openSuggestionsFor(app: FastifyInstance, contactId: string) {
  const { rows } = await app.db.query<{ id: string; other_id: string; other_name: string }>(
    `SELECT s.id, o.id AS other_id, btrim(o.first_name || ' ' || o.last_name) AS other_name
       FROM contact_duplicate_suggestions s
       JOIN contacts o ON o.id = CASE WHEN s.a_contact_id = $1 THEN s.b_contact_id ELSE s.a_contact_id END
      WHERE s.status = 'open' AND $1 IN (s.a_contact_id, s.b_contact_id)
        AND NOT o.is_archived AND o.contact_status <> 'archived'
      ORDER BY s.created_at`,
    [contactId]
  );
  return rows.map((r) => ({ suggestionId: r.id, otherId: r.other_id, otherName: r.other_name }));
}

/** The two records side by side: email, phone, businesses, engagement count, last activity, portal user. */
export async function compareSuggestion(app: FastifyInstance, suggestionId: string) {
  const s = await app.db.query<{ a: string; b: string; status: string }>(
    `SELECT a_contact_id AS a, b_contact_id AS b, status::text AS status FROM contact_duplicate_suggestions WHERE id = $1`,
    [suggestionId]
  );
  if (!s.rows[0]) throw new AppError(404, 'not_found', 'Suggestion not found.');
  const side = async (id: string) => {
    const { rows } = await app.db.query<{
      id: string; name: string; email: string | null; phone: string | null; businesses: string[] | null;
      engagements: number; last_activity: Date | null; portal_user: boolean; created_at: Date;
    }>(
      `SELECT c.id, btrim(c.first_name || ' ' || c.last_name) AS name, c.email::text AS email, c.phone,
              (SELECT array_agg(b.name ORDER BY b.name) FROM business_members m JOIN businesses b ON b.id = m.business_id WHERE m.contact_id = c.id AND NOT b.is_archived) AS businesses,
              (SELECT count(*)::int FROM engagements e WHERE e.contact_id = c.id) AS engagements,
              GREATEST(c.updated_at, (SELECT max(a.occurred_at) FROM audit_log a WHERE a.contact_id = c.id)) AS last_activity,
              EXISTS (SELECT 1 FROM portal_users p WHERE p.contact_id = c.id) AS portal_user, c.created_at
         FROM contacts c WHERE c.id = $1`,
      [id]
    );
    const r = rows[0]!;
    return {
      id: r.id, name: r.name, email: r.email, phone: r.phone, businesses: r.businesses ?? [], engagements: r.engagements,
      lastActivity: r.last_activity ? r.last_activity.toISOString() : null, portalUser: r.portal_user, createdAt: r.created_at.toISOString(),
    };
  };
  return { suggestionId, status: s.rows[0].status, a: await side(s.rows[0].a), b: await side(s.rows[0].b) };
}

/** Not a duplicate: dismissed with a reason, audited; the banner goes from both pages. */
export async function dismissSuggestion(app: FastifyInstance, actor: Actor, suggestionId: string, reason: string): Promise<void> {
  const r = await app.db.query<{ a: string; b: string }>(
    `UPDATE contact_duplicate_suggestions SET status = 'dismissed', dismissed_reason = $2, closed_by_staff_id = $3, closed_at = now()
      WHERE id = $1 AND status = 'open' RETURNING a_contact_id AS a, b_contact_id AS b`,
    [suggestionId, reason, actor.id]
  );
  if (!r.rows[0]) throw new AppError(409, 'not_open', 'This suggestion is already answered.');
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
    action: 'contact.duplicate_dismissed', objectType: 'contact', objectId: r.rows[0].a, contactId: r.rows[0].a,
    details: { suggestion_id: suggestionId, other: r.rows[0].b, reason },
  });
}
