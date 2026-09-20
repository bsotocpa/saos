/*
 * THE DUPLICATE CONTACT SCAN (2026-09-12 night, Brian's ruling 1).
 *
 * Same-name contacts across the whole book, grouped. Within a group, records that share an
 * email, a phone or an address (the merge route's own rule, sharedIdentifiers) are merged into a
 * winner; records that share nothing with anyone get a "possible duplicate, no shared
 * identifier" note on the record and stay. A name alone never merges.
 *
 * The winner is the record holding the most: a portal sign-in first, then businesses, tasks,
 * engagements, invoices, documents, quotes and packets, then a phone and an address on file,
 * then the older record. A test record is rehearsal residue, not a person: it is outside the scan,
 * neither merged nor noted, so a real record beside its own test twin is left clean.
 *
 * PROTECTED NAMES (Jackson Flores, Josean Irizarry, Joseph Basilone) sort first in every plan and
 * are never merged by a script on its own: the plan says what the route would do, and the merge
 * runs only when a person has named the losing record (approvedLoserIds; Brian, 2026-09-14).
 */
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types.ts';
import { writeAudit } from '../../audit.ts';
import { mergeContacts, sharedIdentifiers, type MergeActor } from './merge.ts';

export const PROTECTED_NAMES = new Set(['jackson flores', 'josean irizarry', 'joseph basilone']);
/** One spelling of a name, an email or any typed identifier: lowercase, single spaces, trimmed. */
export const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

export interface DuplicateRecord {
  id: string; name: string; source: string; isTest: boolean; createdAt: string;
  hasPhone: boolean; hasAddress: boolean; portal: boolean;
  holds: { businesses: number; tasks: number; engagements: number; openEngagements: number; invoices: number; documents: number; quotes: number; packets: number };
  score: number;
}
export interface PlannedMerge { winnerId: string; loserIds: string[]; shared: Record<string, string[]> }
export interface DuplicateGroup {
  name: string; protectedName: boolean; records: DuplicateRecord[];
  merges: PlannedMerge[];
  /** Records that share nothing with anyone in the group: annotated, never merged. */
  noteIds: string[];
}

function score(r: Omit<DuplicateRecord, 'score'>): number {
  const h = r.holds;
  return (r.portal ? 1000 : 0) + h.engagements * 50 + h.invoices * 40 + h.packets * 40 + h.documents * 20 + h.quotes * 10 + h.businesses * 10 + h.tasks * 5 + (r.hasPhone ? 2 : 0) + (r.hasAddress ? 2 : 0);
}

/** Every group of two or more non-archived contacts with the same name, with what each holds and what the route would do. */
export async function sameNameGroups(app: FastifyInstance): Promise<DuplicateGroup[]> {
  const { rows } = await app.db.query<{
    id: string; first_name: string; last_name: string; source: string; is_test: boolean; created_at: Date;
    has_phone: boolean; has_address: boolean; portal: boolean;
    businesses: string; tasks: string; engagements: string; open_engagements: string; invoices: string; documents: string; quotes: string; packets: string;
  }>(
    `SELECT c.id, c.first_name, c.last_name, c.source::text AS source, c.is_test, c.created_at,
            c.phone IS NOT NULL AS has_phone, c.address_line1 IS NOT NULL AS has_address,
            EXISTS (SELECT 1 FROM portal_users pu WHERE pu.contact_id = c.id) AS portal,
            (SELECT count(*) FROM business_members x WHERE x.contact_id = c.id) AS businesses,
            (SELECT count(*) FROM tasks x WHERE x.contact_id = c.id) AS tasks,
            (SELECT count(*) FROM engagements x WHERE x.contact_id = c.id) AS engagements,
            (SELECT count(*) FROM engagements x WHERE x.contact_id = c.id AND x.status IN ('active', 'on_hold')) AS open_engagements,
            (SELECT count(*) FROM invoices x WHERE x.contact_id = c.id) AS invoices,
            (SELECT count(*) FROM documents x WHERE x.contact_id = c.id) AS documents,
            (SELECT count(*) FROM quotes x WHERE x.contact_id = c.id) AS quotes,
            (SELECT count(*) FROM engagement_packets x WHERE x.contact_id = c.id) AS packets
       FROM contacts c
      WHERE NOT c.is_archived AND c.contact_status <> 'archived' AND NOT c.is_test
        AND lower(regexp_replace(btrim(c.first_name || ' ' || c.last_name), '\\s+', ' ', 'g')) IN (
          SELECT lower(regexp_replace(btrim(first_name || ' ' || last_name), '\\s+', ' ', 'g'))
            FROM contacts WHERE NOT is_archived AND contact_status <> 'archived' AND NOT is_test
           GROUP BY 1 HAVING count(*) > 1)
      ORDER BY 2, 3, c.created_at, c.id`
  );
  const byName = new Map<string, DuplicateRecord[]>();
  for (const r of rows) {
    const base = {
      id: r.id, name: `${r.first_name} ${r.last_name}`, source: r.source, isTest: r.is_test, createdAt: r.created_at.toISOString(),
      hasPhone: r.has_phone, hasAddress: r.has_address, portal: r.portal,
      holds: {
        businesses: Number(r.businesses), tasks: Number(r.tasks), engagements: Number(r.engagements), openEngagements: Number(r.open_engagements),
        invoices: Number(r.invoices), documents: Number(r.documents), quotes: Number(r.quotes), packets: Number(r.packets),
      },
    };
    const rec: DuplicateRecord = { ...base, score: score(base) };
    const key = norm(rec.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(rec);
  }

  const groups: DuplicateGroup[] = [];
  for (const [key, records] of byName) {
    // Shared identifiers, pairwise.
    const parent = new Map<string, string>(records.map((r) => [r.id, r.id]));
    const find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
    const shared: Record<string, string[]> = {};
    for (let i = 0; i < records.length; i++) {
      for (let j = i + 1; j < records.length; j++) {
        const a = records[i]!, b = records[j]!;
        const s = await sharedIdentifiers(app, a.id, b.id);
        if (s.length === 0) continue;
        shared[`${a.id}+${b.id}`] = s;
        parent.set(find(a.id), find(b.id));
      }
    }
    const components = new Map<string, DuplicateRecord[]>();
    for (const r of records) {
      const root = find(r.id);
      if (!components.has(root)) components.set(root, []);
      components.get(root)!.push(r);
    }
    const merges: PlannedMerge[] = [];
    const noteIds: string[] = [];
    for (const members of components.values()) {
      if (members.length === 1) { noteIds.push(members[0]!.id); continue; }
      const ranked = [...members].sort((a, b) => b.score - a.score || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const winner = ranked[0]!;
      const losers = ranked.slice(1).map((r) => r.id);
      const pairShared: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(shared)) if (members.some((m) => k.startsWith(m.id)) ) pairShared[k] = v;
      merges.push({ winnerId: winner.id, loserIds: losers, shared: pairShared });
    }
    groups.push({ name: records[0]!.name, protectedName: PROTECTED_NAMES.has(key), records, merges, noteIds });
  }
  // Protected names first, then by name.
  return groups.sort((a, b) => Number(b.protectedName) - Number(a.protectedName) || a.name.localeCompare(b.name));
}

const NOTE_MARK = 'Possible duplicate';

/** The note a record carries when a same-name record shares nothing with it. Idempotent. */
export async function annotatePossibleDuplicate(
  app: FastifyInstance, contactId: string, others: DuplicateRecord[], actor: MergeActor, dateIso: string
): Promise<boolean> {
  const current = await app.db.query<{ notes: string | null }>(`SELECT notes FROM contacts WHERE id = $1 AND NOT is_archived`, [contactId]);
  if (!current.rows[0]) return false;
  if ((current.rows[0].notes ?? '').includes(NOTE_MARK)) return false;
  const who = others.map((o) => `${o.name} (${o.source}, added ${o.createdAt.slice(0, 10)})`).join('; ');
  const note = `${NOTE_MARK}: same name as ${who}; no shared email, phone or address, so not merged (duplicate scan, ${dateIso}).`;
  await app.db.query(
    `UPDATE contacts SET notes = CASE WHEN notes IS NULL OR btrim(notes) = '' THEN $2 ELSE notes || E'\\n' || $2 END WHERE id = $1`,
    [contactId, note]
  );
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
    action: 'contact.updated', objectType: 'contact', objectId: contactId, contactId,
    details: { fields: ['notes'], note },
  });
  return true;
}

export interface ApplyResult {
  name: string; protectedName: boolean;
  merged: Array<{ winnerId: string; loserIds: string[] }>;
  held: Array<{ winnerId: string; loserIds: string[]; why: string }>;
  refused: Array<{ winnerId: string; loserIds: string[]; error: string }>;
  noted: string[];
}

/** Do what the plan says: merges through the same function the route calls, notes on the rest. Protected names are never merged here. */
export async function applyDuplicatePlan(
  app: FastifyInstance, groups: DuplicateGroup[], actor: MergeActor,
  opts: { dateIso: string; reason: string; approvedLoserIds?: ReadonlySet<string> | undefined }
): Promise<ApplyResult[]> {
  const out: ApplyResult[] = [];
  for (const g of groups) {
    const r: ApplyResult = { name: g.name, protectedName: g.protectedName, merged: [], held: [], refused: [], noted: [] };
    for (const m of g.merges) {
      if (g.protectedName && !m.loserIds.every((id) => opts.approvedLoserIds?.has(id))) {
        r.held.push({ ...m, why: 'protected name: the merge waits for a person' });
        continue;
      }
      try {
        await mergeContacts(app, m.winnerId, m.loserIds, opts.reason, actor);
        r.merged.push({ winnerId: m.winnerId, loserIds: m.loserIds });
      } catch (err) {
        r.refused.push({ winnerId: m.winnerId, loserIds: m.loserIds, error: err instanceof AppError ? err.code : String(err) });
      }
    }
    for (const id of g.noteIds) {
      const others = g.records.filter((x) => x.id !== id);
      if (await annotatePossibleDuplicate(app, id, others, actor, opts.dateIso)) r.noted.push(id);
    }
    out.push(r);
  }
  return out;
}
