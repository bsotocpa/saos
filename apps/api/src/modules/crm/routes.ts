// CRM: contacts, businesses, entity groups (MP Unified Contact Record,
// v4.2 module 2). Contact detail reads are audit-logged — contact identity
// fields are PII under the WISP rule. SSNs are NEVER returned by these
// endpoints (status + last-4 only).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../audit.ts';
import { holds, requireAnyPermission, requirePermission } from '../../plugins/auth.ts';
import { reasonText } from '../../reasons.ts';
import { mergeContacts } from './merge.ts';
import { norm } from './duplicates.ts';
import { calendarDay, todayChicago } from '../tax/deadlines.ts';
import { archiveBusiness, mergeBusinesses } from './businesses.ts';
import { archiveContact } from './lifecycle.ts';
import { AppError } from '../../types.ts';
import { refreshEnrichmentGaps } from './service.ts';
import { withTransaction } from '../../db.ts';
import { runHealthRefresh } from './health.ts';
import { readableCategories } from '../documents/wall.ts';
import { scopeForEngagements, scopeName, scopeSummary } from '../engagements/scope.ts';

import { createInvoice } from '../billing/service.ts';
import { assertNotBillingHeld } from '../billing/billing-hold.ts';

const ContactCreateBody = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.email().optional(),
  phone: z.string().optional(),
  secondaryPhone: z.string().optional(),
  language: z.enum(['en', 'es']).default('en'),
  preferredContactMethod: z.enum(['phone', 'email', 'portal', 'text']).optional(),
  /*
   * NO STATUS IN THE BODY (#42). The lifecycle is derived from what happened —
   * acceptance, signature, engagements closing — so there is nothing to type here. A new
   * contact starts at the column default ('lead') and climbs the ladder on its own.
   *
   * This was a real hole: the field was accepted at creation AND on every PATCH, so a
   * staffer could type "active" onto a contact with no Master and no engagement, and the
   * legacy mirror's one-writer guarantee would be broken by the application itself.
   *
   * hilo_status stays settable — it answers a different question and is not this ladder.
   */
  hiloStatus: z.enum(['none', 'awareness', 'exploring', 'active', 'referral', 'alumni', 'partner', 'inactive']).default('none'),
  assignedManagerId: z.uuid().optional(),
  clientSince: z.iso.date().optional(),
  notes: z.string().optional(),
});

/*
 * R45 (2026-09-26): when the email changes while a portal user exists, the route OFFERS to move the
 * sign-in with it (portalSignInMove: 'offered'); with movePortalSignIn: true it records the pending move
 * and emails the confirmation link to the new address. Never a column: it is an instruction, not a field.
 */
const ContactUpdateBody = ContactCreateBody.partial().extend({ movePortalSignIn: z.boolean().optional() });

const BusinessBody = z.object({
  name: z.string().min(1),
  ein: z.string().regex(/^\d{2}-?\d{7}$/, 'EIN must be 9 digits (XX-XXXXXXX)').optional(),
  /** R54: why this is a different business from the one already holding the EIN. Required only when one does. */
  duplicateReason: z.string().trim().min(10, 'Say in a sentence why this is a different business.').max(500).optional(),
  entityType: z
    .enum(['sole_prop', 'llc', 'pllc', 's_corp', 'c_corp', 'partnership', 'nonprofit', 'coop', 'not_sure', 'other'])
    .optional(),
  industry: z.string().optional(),
  naicsCode: z.string().optional(),
  irsActivityCode: z.string().optional(),
  yearsInBusiness: z.string().optional(),
  revenueRange: z.string().optional(),
  employeesRange: z.string().optional(),
  zip: z.string().optional(),
  state: z.string().length(2).default('IL'),
  fiscalYearEndMonth: z.number().int().min(1).max(12).default(12),
  memberRole: z.string().default('owner'),
  /** The state's formation date, as the person adding the business states it (provenance staff_verified). */
  formationDate: z.iso.date().optional(),
  /** Make it the primary at creation (2026-09-19); the first business is primary either way. */
  setPrimary: z.boolean().optional(),
});

/*
 * A PATCH WRITES ONLY WHAT IT WAS SENT (2026-09-20). `.partial()` keeps a `.default()`, so the
 * state and the fiscal year end used to arrive on every edit as 'IL' and 12 whether or not the
 * person typed them — a business in another state was quietly moved to Illinois by any edit of
 * any other field. Found by the audit row that names the fields an edit wrote.
 */
const BusinessUpdateBody = BusinessBody.omit({ memberRole: true, setPrimary: true }).partial().extend({
  state: z.string().length(2).optional(),
  fiscalYearEndMonth: z.number().int().min(1).max(12).optional(),
  /** active or dissolved (2026-09-12): a fact the firm knows, beside the Secretary of State's observation. */
  status: z.enum(['active', 'dissolved']).optional(),
  /** Parity with contacts (2026-09-12): a test business says what the test was. */
  isTest: z.boolean().optional(),
  testNote: z.string().trim().min(10).max(500).optional(),
});

/*
 * ONE SPELLING OF AN EIN (2026-09-20, edit after create). The schema accepts the nine digits with or
 * without the hyphen; the row holds XX-XXXXXXX, so the same number typed two ways is one number to
 * the duplicate check below and to every reader. The value never reaches a log or an audit row: a
 * refusal names the business that already carries it, never the number.
 */
export const normalizeEin = (ein: string): string => {
  const digits = ein.replace(/\D/g, '');
  return `${digits.slice(0, 2)}-${digits.slice(2)}`;
};

/** What the duplicate-EIN warning links to: the business already holding the number and the person it belongs to. */
export interface EinHolder { businessId: string; name: string; ownerContactId: string | null; ownerName: string | null }

/**
 * A DUPLICATE EIN WARNS AND DOES NOT REFUSE (Brian, 2026-09-26, R54). Add a business and Edit business
 * both ask this question as the number is typed and again on save. When another open business holds
 * the number, the form shows that business and its owner with a link, and the save goes through only
 * with a standalone reason (`duplicateReason`), which is audited as business.ein_duplicate_accepted
 * beside the other business's id. A save with no reason is refused, naming the business, never the
 * number. The owner is the primary member, else the member whose role is owner, else the first.
 */
export async function findEinHolder(app: FastifyInstance, ein: string, exceptBusinessId: string | null): Promise<EinHolder | null> {
  const { rows } = await app.db.query<{ id: string; name: string; owner_contact_id: string | null; owner_name: string | null }>(
    `SELECT b.id, b.name, o.contact_id AS owner_contact_id, o.owner_name
       FROM businesses b
       LEFT JOIN LATERAL (
         SELECT bm.contact_id, c.first_name || ' ' || c.last_name AS owner_name
           FROM business_members bm JOIN contacts c ON c.id = bm.contact_id
          WHERE bm.business_id = b.id
          ORDER BY bm.is_primary DESC, (bm.member_role = 'owner') DESC, c.last_name, c.first_name
          LIMIT 1) o ON true
      WHERE NOT b.is_archived AND regexp_replace(COALESCE(b.ein, ''), '[^0-9]', '', 'g') = $1 AND ($2::uuid IS NULL OR b.id <> $2::uuid)
      ORDER BY b.created_at LIMIT 1`,
    [ein.replace(/\D/g, ''), exceptBusinessId]
  );
  const r = rows[0];
  return r ? { businessId: r.id, name: r.name, ownerContactId: r.owner_contact_id, ownerName: r.owner_name } : null;
}

/** Archive, never delete (2026-09-12): a reason always; a test flag with its note when the record was never real. */
const ArchiveBody = z.object({
  reason: reasonText(10, 1000),
  isTest: z.boolean().optional(),
  testNote: z.string().trim().min(10).max(500).optional(),
});

const GroupBody = z.object({ name: z.string().min(1), notes: z.string().optional() });
const GroupMemberBody = z
  .object({ businessId: z.uuid().optional(), contactId: z.uuid().optional(), memberRole: z.string().optional() })
  .refine((b) => (b.businessId === undefined) !== (b.contactId === undefined), {
    message: 'Provide exactly one of businessId or contactId.',
  });

/*
 * THE DUPLICATE CHECK BEFORE A CONTACT IS CREATED (Brian, ruling R14, 2026-09-20).
 *
 * The duplicate scan (crm/duplicates.ts) finds the twins already in the book, nightly, after the
 * fact. This is the same question asked one record early, while someone is still typing the name:
 * the front desk types a client who called last spring, the book already holds her, and two records
 * start accumulating work that a merge later has to untangle. Same normalizer (norm), same three
 * identifiers the merge itself trusts — name, email, phone — so what the check calls a likely
 * duplicate is what the scan and the merge would call one.
 *
 * Archived records are out: the point is a record someone can open and use. A TEST record is out on
 * a name alone (rehearsal residue is not a person), but IN when it shares an email or a phone,
 * because then the thing being typed is the rehearsal, and saying so saves the confusion.
 */
const DuplicateCheckQuery = z.object({
  firstName: z.string().trim().optional(),
  lastName: z.string().trim().optional(),
  email: z.string().trim().optional(),
  phone: z.string().trim().optional(),
});
type DuplicateReason = 'name' | 'email' | 'phone';
const REASON_WORDS: Record<DuplicateReason, string> = {
  name: 'the same name',
  email: 'the same email address',
  phone: 'the same phone number',
};
/** "the same name and the same phone number" — the server's words, rendered as they arrive. */
function reasonSentence(reasons: DuplicateReason[]): string {
  const words = reasons.map((r) => REASON_WORDS[r]);
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]!}`;
}

const SearchQuery = z.object({
  search: z.string().optional(),
  sotoStatus: z.string().optional(),
  hiloStatus: z.string().optional(),
  managerId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

function meta(request: FastifyRequest) {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

export function registerCrmRoutes(app: FastifyInstance): void {
  const read = { preHandler: [app.authenticate, requirePermission('contacts.read')] };
  const write = { preHandler: [app.authenticate, requirePermission('contacts.write')] };
  const taxManage = { preHandler: [app.authenticate, requirePermission('engagements.tax.manage')] };
  /*
   * ADDING A BUSINESS HAS ITS OWN DOOR (2026-09-19). The entity VA files annual reports and needs to
   * record the business she is filing for; contacts.write would have handed her every identity field
   * on the record instead. businesses.write is that one act, and contacts.write still opens it so the
   * front desk and the CEO are unchanged.
   */
  const businessWrite = { preHandler: [app.authenticate, requireAnyPermission('contacts.write', 'businesses.write')] };
  // Merging two records is a money-adjacent act (invoices move): billing.manage, or the CEO. Businesses.
  const merge = { preHandler: [app.authenticate, requireAnyPermission('billing.manage')] };
  // R92 (2026-09-29): merging two CLIENT records is the CEO's alone (contacts.merge, explicit-only).
  const contactMerge = { preHandler: [app.authenticate, requirePermission('contacts.merge')] };

  /**
   * CONTACT MERGE (2026-09-12). The winner keeps its identity; the losers' rows move to it, one
   * audit row per object; the losers are archived pointing at the winner. Refused when both sides
   * hold active work on the same line, period and entity. crm/merge.ts.
   */
  app.post<{ Params: { id: string } }>('/contacts/:id/merge', contactMerge, async (request) => {
    const winnerId = z.uuid().parse(request.params.id);
    const b = z.object({
      loserIds: z.array(z.uuid()).min(1).max(10),
      reason: reasonText(10, 1000),
      /** Records sharing no email, phone or address merge only with this (2026-09-12): a name match alone never merges. */
      identityOverrideReason: reasonText(10, 1000).optional(),
    }).parse(request.body);
    const actor = request.staff!;
    return mergeContacts(app, winnerId, b.loserIds, b.reason, { id: actor.id, email: actor.email, fullName: actor.fullName }, meta(request), { identityOverrideReason: b.identityOverrideReason });
  });

  /**
   * THE PAIR DOOR (Brian, 2026-09-29, R92): two records the duplicate review marked "merge". The CEO
   * alone, with a standalone reason; neither side is named the winner: the survivor is the record with
   * the portal user, else the most engagements, else the older one (survivorOf). The retired record is
   * kept, archived, pointing at the survivor (GET /contacts/:id answers the redirect), and leaves search.
   */
  app.post('/contacts/merge-pair', contactMerge, async (request) => {
    const b = z.object({
      aId: z.uuid(),
      bId: z.uuid(),
      reason: reasonText(10, 1000),
      identityOverrideReason: reasonText(10, 1000).optional(),
    }).parse(request.body);
    if (b.aId === b.bId) throw new AppError(400, 'same_record', 'A record cannot be merged with itself.');
    const { survivorOf } = await import('./merge.ts');
    const pick = await survivorOf(app, b.aId, b.bId);
    const actor = request.staff!;
    const out = await mergeContacts(app, pick.survivor, [pick.retired], b.reason, { id: actor.id, email: actor.email, fullName: actor.fullName }, meta(request), { identityOverrideReason: b.identityOverrideReason });
    return { ...out, survivorId: pick.survivor, retiredId: pick.retired, survivorRule: pick.rule };
  });

  /**
   * CONTACT ARCHIVE (2026-09-12): the one lifecycle state a person sets. Never a delete. Refused
   * while the contact holds active work (migration 0099, at the database). A record that was never
   * a real person is flagged test with the note saying what it was.
   */
  app.post<{ Params: { id: string } }>('/contacts/:id/archive', write, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = ArchiveBody.parse(request.body);
    const actor = request.staff!;
    if (b.isTest && !b.testNote) throw new AppError(400, 'test_note_required', 'A test flag carries a note saying what the test was.');
    const row = await app.db.query<{ contact_status: string }>(`SELECT contact_status::text AS contact_status FROM contacts WHERE id = $1`, [id]);
    if (!row.rows[0]) throw new AppError(404, 'not_found', 'Contact not found.');
    if (row.rows[0].contact_status === 'archived') throw new AppError(409, 'already_archived', 'This contact is already archived.');
    if (b.isTest) {
      await app.db.query(`UPDATE contacts SET is_test = true, test_note = $2 WHERE id = $1`, [id, b.testNote]);
    }
    await archiveContact(app, id, b.reason, { id: actor.id, email: actor.email, fullName: actor.fullName });
    await app.db.query(`UPDATE contacts SET is_archived = true WHERE id = $1`, [id]);
    return { status: 'ok', archived: true, isTest: b.isTest ?? false };
  });

  // ── Contacts ────────────────────────────────────────────────────────────
  app.get('/contacts', read, async (request) => {
    const q = SearchQuery.parse(request.query);
    const clauses: string[] = ['NOT c.is_archived'];
    // $1 is ALWAYS the search pattern (NULL when absent) so both the WHERE clause
    // and the matched-business subquery in the SELECT can reference it. Deriving
    // its position from params.length would silently point at sotoStatus the moment
    // someone filters without searching.
    const params: unknown[] = [q.search ? `%${q.search}%` : null];
    // The clause is ALWAYS present and always references $1, guarded by
    // `$1 IS NULL`. Adding it conditionally left $1 bound but unreferenced when
    // nobody searched, and Postgres rejects that outright ("bind message supplies
    // 1 parameters, but prepared statement requires 0") — every unfiltered list
    // request 500'd. Business name is included because much of this book bills
    // under a business rather than a person; the migration flagged 35 such clients,
    // and searching only people left them unfindable.
    clauses.push(
      `($1::text IS NULL OR
        c.first_name ILIKE $1 OR c.last_name ILIKE $1
        OR (c.first_name || ' ' || c.last_name) ILIKE $1
        OR c.email::text ILIKE $1 OR c.phone ILIKE $1
        OR EXISTS (
          SELECT 1 FROM business_members bm JOIN businesses b ON b.id = bm.business_id
          WHERE bm.contact_id = c.id AND NOT b.is_archived AND b.name ILIKE $1
        ))`
    );
    if (q.sotoStatus) {
      params.push(q.sotoStatus);
      clauses.push(`c.soto_status = $${params.length}::soto_status`);
    }
    if (q.hiloStatus) {
      params.push(q.hiloStatus);
      clauses.push(`c.hilo_status = $${params.length}::hilo_status`);
    }
    if (q.managerId) {
      params.push(q.managerId);
      clauses.push(`c.assigned_manager_id = $${params.length}`);
    }
    // The total BEFORE paging, so the list can say "showing 25 of 426" instead of
    // leaving you guessing whether your search matched everything.
    const totalRow = await app.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM contacts c WHERE ${clauses.join(' AND ')}`,
      params
    );

    params.push(q.limit, q.offset);
    const { rows } = await app.db.query(
      `SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.language,
              c.soto_status, c.hilo_status, c.health_score, c.assigned_manager_id, c.client_since,
              -- is_test so the directory can badge a rehearsal record rather than
              -- letting it look like a real client (visible in operations).
              c.is_test,
              -- Show the business that MATCHED the search, not the primary one.
              -- Brian's ruling after searching "dishroulette" returned a client
              -- displaying "BREAK BREAD CHICAGO LLC": he owns several businesses,
              -- the search hit one, and the row showed another. Correct by the old
              -- rule and still wrong to read. With no search (or no match), the
              -- primary is the right thing to show.
              (SELECT b.name FROM business_members bm JOIN businesses b ON b.id = bm.business_id
               WHERE bm.contact_id = c.id AND NOT b.is_archived
               ORDER BY
                 CASE WHEN $1::text IS NOT NULL AND b.name ILIKE $1 THEN 0 ELSE 1 END,
                 bm.is_primary DESC, b.name
               LIMIT 1) AS business_name,
              -- R40 (2026-09-26): the same business's id, so the clients-list row for a business match
              -- can open the business page when OPS_BUSINESS_PAGE is on.
              (SELECT b.id FROM business_members bm JOIN businesses b ON b.id = bm.business_id
               WHERE bm.contact_id = c.id AND NOT b.is_archived
               ORDER BY
                 CASE WHEN $1::text IS NOT NULL AND b.name ILIKE $1 THEN 0 ELSE 1 END,
                 bm.is_primary DESC, b.name
               LIMIT 1) AS business_id,
              -- R51 (2026-09-26): true when the search hit a business legal name, so every Ops
              -- search (Deliver Return, New quote, the clients list) can print "Business — owner".
              ($1::text IS NOT NULL AND EXISTS (
                 SELECT 1 FROM business_members bm JOIN businesses b ON b.id = bm.business_id
                 WHERE bm.contact_id = c.id AND NOT b.is_archived AND b.name ILIKE $1)) AS business_matched,
              (SELECT count(*)::int FROM engagements e
               WHERE e.contact_id = c.id AND e.status IN ('active', 'on_hold')) AS active_engagements,
              -- R80 (2026-09-27): the person's primary business, by the flag alone, for the search chip.
              (SELECT b.name FROM business_members bm JOIN businesses b ON b.id = bm.business_id
               WHERE bm.contact_id = c.id AND bm.is_primary AND NOT b.is_archived
               ORDER BY b.name LIMIT 1) AS primary_business_name
       FROM contacts c
       WHERE ${clauses.join(' AND ')}
       ORDER BY c.last_name, c.first_name
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return { contacts: rows, total: totalRow.rows[0]!.n, limit: q.limit, offset: q.offset };
  });

  /**
   * Likely duplicates for a contact about to be created. contacts.write, because this is part of
   * creating one — the same door, asked a question first. Five at most, the strongest first.
   */
  app.get('/contacts/duplicate-check', write, async (request) => {
    const q = DuplicateCheckQuery.parse(request.query);
    const name = q.firstName && q.lastName ? norm(`${q.firstName} ${q.lastName}`) : null;
    const email = q.email ? norm(q.email) : null;
    const digits = (q.phone ?? '').replace(/\D/g, '');
    // Ten digits is the comparison the merge makes (sharedIdentifiers): a partial number is not a match.
    const phone = digits.length >= 10 ? digits.slice(-10) : null;
    if (name === null && email === null && phone === null) return { duplicates: [] };
    const { rows } = await app.db.query<{
      id: string; first_name: string; last_name: string; email: string | null; phone: string | null;
      is_test: boolean; same_name: boolean; same_email: boolean; same_phone: boolean;
    }>(
      `SELECT m.* FROM (
         SELECT c.id, c.first_name, c.last_name, c.email::text AS email, c.phone, c.is_test, c.created_at,
                ($1::text IS NOT NULL
                  AND lower(regexp_replace(btrim(c.first_name || ' ' || c.last_name), '\\s+', ' ', 'g')) = $1) AS same_name,
                ($2::text IS NOT NULL AND c.email IS NOT NULL AND lower(btrim(c.email::text)) = $2) AS same_email,
                ($3::text IS NOT NULL
                  AND length(regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g')) >= 10
                  AND right(regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g'), 10) = $3) AS same_phone
           FROM contacts c
          WHERE NOT c.is_archived AND c.contact_status <> 'archived'
       ) m
        WHERE (m.same_name OR m.same_email OR m.same_phone)
          AND (NOT m.is_test OR m.same_email OR m.same_phone)
        ORDER BY m.same_email DESC, m.same_phone DESC, m.same_name DESC, m.created_at
        LIMIT 5`,
      [name, email, phone]
    );
    const duplicates = rows.map((r) => {
      const reasons: DuplicateReason[] = [];
      if (r.same_name) reasons.push('name');
      if (r.same_email) reasons.push('email');
      if (r.same_phone) reasons.push('phone');
      return {
        id: r.id, firstName: r.first_name, lastName: r.last_name, email: r.email, phone: r.phone,
        isTest: r.is_test, reasons, reason: reasonSentence(reasons),
      };
    });
    return { duplicates };
  });

  app.post('/contacts', write, async (request, reply) => {
    const b = ContactCreateBody.parse(request.body);
    /*
     * CREATED ANYWAY (R14, 2026-09-20). The duplicate check warns; a person decides. The decision is
     * not a contact field — it is a fact about this act — so it is parsed off the body separately
     * (ContactCreateBody and the PATCH body it derives from stay exactly as they were) and lands on
     * the creation's own audit row. A merge later reads it and knows the twin was seen, not missed.
     */
    const ack = z
      .object({ duplicateAcknowledged: z.boolean().default(false), duplicateIds: z.array(z.uuid()).max(5).optional() })
      .parse(request.body);
    const actor = request.staff!;
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO contacts (first_name, last_name, email, phone, secondary_phone, language,
                             preferred_contact_method, hilo_status, assigned_manager_id,
                             client_since, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::hilo_status,$9,$10,$11)
       RETURNING id`,
      [
        b.firstName, b.lastName, b.email ?? null, b.phone ?? null, b.secondaryPhone ?? null, b.language,
        b.preferredContactMethod ?? null, b.hiloStatus, b.assignedManagerId ?? null,
        b.clientSince ?? null, b.notes ?? null,
      ]
    );
    const id = rows[0]!.id;
    await refreshEnrichmentGaps(app, id);
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
      action: 'contact.created', objectType: 'contact', objectId: id, contactId: id, ...meta(request),
      ...(ack.duplicateAcknowledged
        ? { details: { duplicate_acknowledged: true, ...(ack.duplicateIds ? { duplicateIds: ack.duplicateIds } : {}) } }
        : {}),
    });
    return reply.code(201).send({ id });
  });

  app.get<{ Params: { id: string } }>('/contacts/:id', read, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const actor = request.staff!;
    const contact = await app.db.query(
      `SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.secondary_phone, c.language,
              c.preferred_contact_method, c.address_line1, c.address_line2, c.city, c.state, c.zip,
              c.soto_status, c.contact_status::text AS contact_status, c.contact_status_at, c.archived_reason,
              c.hilo_status, c.client_since, c.hilo_first_contact, c.assigned_manager_id,
              c.consent_7216_status, c.engagement_letter_status,
              c.health_score, c.health_components, c.health_computed_at,
              c.sms_consent, c.source, c.ssn_status, c.ssn_last4, c.notes,
              -- A test client must ANNOUNCE itself wherever staff look at it,
              -- or someone treats the rehearsal as a real engagement.
              c.is_test, c.test_note,
              c.br1_referred_by_hilo, c.br3_referred_by_jackson, c.br4_hilo_program_participant,
              -- Portal access is now a PRECONDITION for sending an engagement packet
              -- (packets are signed in the portal), so the client page has to be able
              -- to see it and offer to grant it.
              EXISTS (SELECT 1 FROM portal_users pu WHERE pu.contact_id = c.id AND pu.is_active)
                AS has_portal_access,
              -- The address that signs in (2026-09-12, Brian): it can differ from the contact email
              -- after a merge, and the badge must not let "Signed up" imply it is the same one.
              (SELECT pu.email FROM portal_users pu WHERE pu.contact_id = c.id LIMIT 1) AS portal_login_email,
              /*
               * #32 — the four states of portal access, derived rather than stored.
               *
               * has_portal_access above is a boolean, and it conflates two different
               * situations that need different actions from staff: a client who was
               * invited and never arrived, and one who is using the portal. "Invited"
               * is the one that needs chasing, and it was invisible.
               *
               * REVOKED is a real fourth state (is_active = false) and is listed first,
               * because someone whose access was deliberately taken away must never be
               * read as merely "not invited" and re-granted by reflex.
               */
              -- COALESCE on the OUTSIDE: with no portal_users row the subquery returns
              -- no row at all, so a CASE arm for it would never be reached. "No account"
              -- is the absence of a row, not a value inside one.
              COALESCE(
                (SELECT CASE
                          WHEN NOT pu.is_active         THEN 'revoked'
                          WHEN pu.last_login_at IS NULL THEN 'invited'
                          ELSE 'active'
                        END
                   FROM portal_users pu WHERE pu.contact_id = c.id LIMIT 1),
                'not_invited'
              ) AS portal_state,
              (SELECT pu.last_login_at FROM portal_users pu WHERE pu.contact_id = c.id LIMIT 1)
                AS portal_last_login_at,
              /*
               * WHEN the last sign-in link was sent, which is the number that makes
               * "invited" meaningful. Links expire in minutes, so an invite from three
               * days ago is functionally not-invited — staff need the date to tell the
               * difference between "give them a moment" and "send another".
               */
              (SELECT max(t.created_at) FROM magic_link_tokens t
                 JOIN portal_users pu ON pu.id = t.portal_user_id
                WHERE pu.contact_id = c.id)
                AS portal_link_sent_at,
              /*
               * R45 (2026-09-26): a sign-in move waiting on the client's confirmation. The client page
               * reads "sign-in move pending confirmation" from this and offers Resend until the link is
               * pressed at the new address (portal_email_changes; token hashes only, never here).
               */
              (SELECT json_build_object('new_email', pec.new_email, 'requested_at', pec.created_at, 'expires_at', pec.expires_at)
                 FROM portal_email_changes pec JOIN portal_users pu ON pu.id = pec.portal_user_id
                WHERE pu.contact_id = c.id AND pec.confirmed_at IS NULL AND pec.superseded_at IS NULL AND pec.expires_at > now()
                ORDER BY pec.created_at DESC LIMIT 1)
                AS portal_email_move_pending
       FROM contacts c WHERE c.id = $1 AND NOT c.is_archived`,
      [id]
    );
    if (!contact.rows[0]) {
      // R92: a record retired by a merge is kept; anything pointing at it is told where the client is now.
      const merged = await app.db.query<{ merged_into_contact_id: string | null }>(
        `SELECT merged_into_contact_id FROM contacts WHERE id = $1 AND merged_into_contact_id IS NOT NULL`, [id]);
      if (merged.rows[0]?.merged_into_contact_id) return { merged_into: merged.rows[0].merged_into_contact_id };
      throw new AppError(404, 'not_found', 'Contact not found.');
    }
    // THE WALL, field filtering (phase 2, 2026-09-12): the SSN last-4 leaves this route only for a
    // holder of pii.read. ssn_status stays: whether one is on file is workflow, not the number.
    // The EIN below is a business identifier and stays with contacts.read (Laura files with it).
    const contactRow = contact.rows[0] as Record<string, unknown>;
    if (!holds(actor, 'pii.read')) {
      delete contactRow.ssn_last4;
      contactRow.pii_withheld = true;
    }

    // Archived businesses stay on the record's history, not on the page (2026-09-12).
    const businesses = await app.db.query(
      `SELECT b.id, b.name, b.ein, b.entity_type, b.industry, b.naics_code, b.state, b.formation_date,
              b.fiscal_year_end_month, b.il_sos_status, b.status::text AS status, b.is_test, b.test_note, b.unverified_import_source::text AS unverified_import_source,
              m.member_role, m.is_primary
       FROM businesses b JOIN business_members m ON m.business_id = b.id
       WHERE m.contact_id = $1 AND NOT b.is_archived ORDER BY m.is_primary DESC, b.name`,
      [id]
    );
    const groups = await app.db.query(
      `SELECT g.id, g.name FROM entity_groups g
       JOIN entity_group_members gm ON gm.group_id = g.id
       WHERE gm.contact_id = $1
          OR gm.business_id IN (SELECT business_id FROM business_members WHERE contact_id = $1)
       GROUP BY g.id, g.name`,
      [id]
    );
    const gaps = await app.db.query<{ missing_fields: string[] }>(
      `SELECT missing_fields FROM enrichment_queue WHERE contact_id = $1 AND resolved_at IS NULL`,
      [id]
    );

    // WISP: viewing a client record (PII fields) is an audited access.
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
      action: 'contact.viewed', objectType: 'contact', objectId: id, contactId: id, ...meta(request),
    });

    return {
      contact: contact.rows[0],
      businesses: businesses.rows,
      entityGroups: groups.rows,
      enrichmentGaps: gaps.rows[0]?.missing_fields ?? [],
      // How long a sign-in link lives, so the client record can say whether the one we
      // sent is still usable rather than leaving staff to guess (#32).
      magicLinkTtlMinutes: app.config.MAGIC_LINK_TTL_MINUTES,
      // Where the client's own screens live, so the record can show the pay link staff
      // read out on a call (#33) instead of hardcoding the domain in the ops app.
      portalBaseUrl: app.config.PORTAL_BASE_URL,
    };
  });

  app.patch<{ Params: { id: string } }>('/contacts/:id', write, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = ContactUpdateBody.parse(request.body);
    const actor = request.staff!;

    const sets: string[] = [];
    const params: unknown[] = [id];
    const map: Record<string, unknown> = {
      first_name: b.firstName, last_name: b.lastName, email: b.email, phone: b.phone,
      secondary_phone: b.secondaryPhone, language: b.language, preferred_contact_method: b.preferredContactMethod,
      // soto_status is deliberately absent (#42): a lifecycle that can be PATCHed is a
      // lifecycle that will be wrong. It moves when something happens, or not at all.
      hilo_status: b.hiloStatus, assigned_manager_id: b.assignedManagerId,
      client_since: b.clientSince, notes: b.notes,
    };
    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (sets.length === 0) throw new AppError(400, 'empty_update', 'No fields to update.');
    /*
     * ONE TRANSACTION (R45): the email write and the sign-in move it asked for land together or not
     * at all. A refused move (another account already signs in with the new address) leaves the
     * contact email as it was, so the modal's refusal describes a record that did not change.
     */
    return withTransaction(app.db, async () => {
      const res = await app.db.query(`UPDATE contacts SET ${sets.join(', ')} WHERE id = $1 AND NOT is_archived`, params);
      if (res.rowCount === 0) throw new AppError(404, 'not_found', 'Contact not found.');

      const gaps = await refreshEnrichmentGaps(app, id);
      await writeAudit(app.db, {
        actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
        action: 'contact.updated', objectType: 'contact', objectId: id, contactId: id, ...meta(request),
        details: { fields: sets.map((s) => s.split(' =')[0]) },
      });
      /*
       * R45 (Brian, 2026-09-26): all client mail goes to the contact email; the sign-in answers to the
       * portal user's own. When the email just written differs from the address that signs in, the
       * answer OFFERS the move — or, when the person already said yes (the Ops modal asks up front),
       * records it and emails the confirmation link to the new address. The move itself waits for the
       * press on that link. Nothing here changes portal_users.
       */
      let portalSignInMove: 'not_applicable' | 'offered' | 'pending_confirmation' | 'declined' = 'not_applicable';
      if (b.email !== undefined) {
        const pu = await app.db.query<{ email: string }>(
          `SELECT email FROM portal_users WHERE contact_id = $1 AND is_active`, [id]
        );
        const signsInAs = pu.rows[0]?.email ?? null;
        if (signsInAs !== null && signsInAs.toLowerCase() !== b.email.toLowerCase()) {
          if (b.movePortalSignIn === true) {
            const { requestPortalEmailMove } = await import('../portal-auth/service.ts');
            await requestPortalEmailMove(app, id, actor, meta(request));
            portalSignInMove = 'pending_confirmation';
          } else {
            portalSignInMove = b.movePortalSignIn === false ? 'declined' : 'offered';
          }
        }
      }
      return { status: 'ok', enrichmentGaps: gaps, portalSignInMove };
    });
  });

  // ── Businesses ──────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/contacts/:id/businesses', businessWrite, async (request, reply) => {
    const contactId = z.uuid().parse(request.params.id);
    const b = BusinessBody.parse(request.body);
    const actor = request.staff!;

    // The first business a contact adds is primary; after that a person chooses (exactly one, at the database).
    const existing = await app.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM business_members WHERE contact_id = $1 AND is_primary`,
      [contactId]
    );
    if (b.formationDate && calendarDay(b.formationDate, 'formationDate') > calendarDay(todayChicago(), 'today')) throw new AppError(400, 'formation_date_in_future', 'A formation date is a thing that already happened.');
    // R54: the EIN is normalized to one spelling; another open business holding it is a warning the
    // form has already shown, and the save goes through only with the person's reason (audited below).
    const ein = b.ein ? normalizeEin(b.ein) : null;
    const holder = ein ? await findEinHolder(app, ein, null) : null;
    if (holder && !b.duplicateReason) {
      throw new AppError(409, 'ein_in_use', `That EIN is already on ${holder.name}. If this is a different business, say why and create anyway.`);
    }
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO businesses (name, ein, entity_type, industry, naics_code, irs_activity_code,
                               years_in_business, revenue_range, employees_range, zip, state, fiscal_year_end_month,
                               formation_date, formation_date_source, formation_date_recorded_at)
       VALUES ($1,$2,$3::business_entity_type,$4,$5,$6,$7,$8,$9,$10,$11,$12,
               $13, CASE WHEN $13::date IS NULL THEN NULL ELSE 'staff_verified' END, CASE WHEN $13::date IS NULL THEN NULL ELSE now() END)
       RETURNING id`,
      [
        b.name, ein, b.entityType ?? null, b.industry ?? null, b.naicsCode ?? null,
        b.irsActivityCode ?? null, b.yearsInBusiness ?? null, b.revenueRange ?? null, b.employeesRange ?? null,
        b.zip ?? null, b.state, b.fiscalYearEndMonth, b.formationDate ?? null,
      ]
    );
    const businessId = rows[0]!.id;
    // Primary at creation (2026-09-19): asked for, or the first business on the record. Never a second.
    const makePrimary = b.setPrimary === true || (b.setPrimary === undefined && existing.rows[0]!.n === 0);
    if (makePrimary && existing.rows[0]!.n > 0) {
      const cleared = await app.db.query<{ business_id: string }>(`UPDATE business_members SET is_primary = false WHERE contact_id = $1 AND is_primary RETURNING business_id`, [contactId]);
      for (const c of cleared.rows) {
        await writeAudit(app.db, { actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName, action: 'business.primary_cleared', objectType: 'business', objectId: c.business_id, contactId, ...meta(request), details: { reason: 'another business chosen as primary at creation' } });
      }
    }
    await app.db.query(
      `INSERT INTO business_members (business_id, contact_id, member_role, is_primary) VALUES ($1, $2, $3, $4)`,
      [businessId, contactId, b.memberRole, makePrimary]
    );
    await refreshEnrichmentGaps(app, contactId);
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
      action: 'business.created', objectType: 'business', objectId: businessId, contactId, ...meta(request),
    });
    if (holder) {
      await writeAudit(app.db, {
        actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
        action: 'business.ein_duplicate_accepted', objectType: 'business', objectId: businessId, contactId, ...meta(request),
        details: { field: 'ein', other_business_id: holder.businessId, reason: b.duplicateReason },
      });
    }
    return reply.code(201).send({ id: businessId });
  });

  /**
   * The duplicate-EIN question the Add and Edit forms ask as the number is typed (R54). Under the
   * same door as the save it precedes. The answer carries the other business and its owner for the
   * warning's link, and never the number; nothing here is logged.
   */
  app.get('/businesses/ein-check', businessWrite, async (request) => {
    const q = z.object({
      ein: z.string().regex(/^\d{2}-?\d{7}$/, 'EIN must be 9 digits (XX-XXXXXXX)'),
      exceptBusinessId: z.uuid().optional(),
    }).parse(request.query);
    return { duplicate: await findEinHolder(app, normalizeEin(q.ein), q.exceptBusinessId ?? null) };
  });

  // Business lookup for the v4.5 dual Contact/Business pickers.
  app.get('/businesses', read, async (request) => {
    const q = z.object({ search: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }).parse(request.query);
    const params: unknown[] = [];
    let where = '';
    if (q.search) {
      params.push(`%${q.search}%`);
      where = `WHERE b.name ILIKE $${params.length}`;
    }
    params.push(q.limit);
    const { rows } = await app.db.query(
      `SELECT b.id, b.name, b.entity_type, b.unverified_import_source::text AS unverified_import_source FROM businesses b ${where ? where + ' AND' : 'WHERE'} NOT b.is_archived ORDER BY b.name LIMIT $${params.length}`,
      params
    );
    return { businesses: rows };
  });

  /*
   * THE BUSINESS PAGE'S READ (Brian, 2026-09-26, R40; proposal docs/proposals/2026-09-20-business-page.md).
   *
   * One aggregate for /businesses/:id in Ops: the entity, its members, and one block per card. The
   * page is contacts.read (the same gate as GET /businesses); each card is its own permission, checked
   * HERE, in the handler, never on the screen: engagements and returns are engagements.read, invoices
   * are billing.manage, documents are documents.read with the §7216 category wall in the query. A card
   * the session cannot read is sent as `{ refused: true, permission }` with no rows, so the page prints
   * "Not available to your role" (R64) instead of an empty state it cannot vouch for. The entity,
   * owners and service facts ride on the page's own gate.
   *
   * THE EIN (the ruling): the last four leave with contacts.read; the whole number only to pii.read.
   * An archived (or merged) business is the same 404 as one that does not exist — its history stays
   * on the owner's record, not on a page. Reading the page is audited (business.viewed), and listing
   * its documents is audited the way GET /documents audits its list (documents.listed).
   *
   * Behind OPS_BUSINESS_PAGE (R57): while off the route refuses with the sentence the page prints.
   */
  app.get<{ Params: { id: string } }>('/businesses/:id', read, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const actor = request.staff!;
    if (app.switches.businessPage !== 'on') throw new AppError(409, 'business_page_off', 'This page is not switched on.');

    const biz = await app.db.query<Record<string, unknown> & { ein: string | null }>(
      `SELECT b.id, b.name, b.status::text AS status, b.entity_type::text AS entity_type, b.ein,
              b.state, b.fiscal_year_end_month, b.industry, b.naics_code,
              b.formation_date::text AS formation_date, b.formation_date_source,
              b.il_sos_status::text AS il_sos_status, b.il_sos_checked_at,
              b.is_test, b.test_note, b.unverified_import_source::text AS unverified_import_source,
              b.books_current_through::text AS books_current_through, b.books_current_through_as_of::text AS books_current_through_as_of,
              b.qbo_paid_by::text AS qbo_paid_by, b.qbo_paid_by_as_of::text AS qbo_paid_by_as_of,
              b.created_at
         FROM businesses b WHERE b.id = $1 AND NOT b.is_archived`,
      [id]
    );
    const row = biz.rows[0];
    if (!row) throw new AppError(404, 'not_found', 'Business not found.');
    const { ein, books_current_through, books_current_through_as_of, qbo_paid_by, qbo_paid_by_as_of, ...entity } = row;
    const digits = (ein ?? '').replace(/\D/g, '');
    const business: Record<string, unknown> = {
      ...entity,
      ein_on_file: ein !== null,
      ein_last4: digits.length >= 4 ? digits.slice(-4) : null,
    };
    // THE WALL, field filtering: the whole EIN leaves only for pii.read (the client page hands it to
    // contacts.read for Laura's filings; this page is the one Brian ruled last-four-only).
    if (holds(actor, 'pii.read')) business.ein = ein;

    const members = await app.db.query(
      `SELECT m.contact_id, c.first_name, c.last_name, m.member_role, m.is_primary, c.is_archived AS contact_archived
         FROM business_members m JOIN contacts c ON c.id = m.contact_id
        WHERE m.business_id = $1 ORDER BY m.is_primary DESC, c.last_name, c.first_name`,
      [id]
    );

    // ── Engagements and returns: engagements.read. ────────────────────────────────────────────────
    const canEngagements = holds(actor, 'engagements.read');
    let engagements: unknown = { refused: true, permission: 'engagements.read' };
    let returns: unknown = { refused: true, permission: 'engagements.read' };
    if (canEngagements) {
      const eng = await app.db.query(
        `SELECT e.id, e.contact_id, e.service_line::text AS service_line, e.status::text AS status, e.title, e.period_key,
                e.lead_staff_id, ls.display_name AS lead_staff_name,
                e.started_on::text AS started_on, e.ended_on::text AS ended_on, e.close_reason, e.work_paused_at, e.created_at,
                e.prep_cadence::text AS prep_cadence, e.filing_frequency, e.payroll_provider,
                (SELECT COALESCE(sum(i.total_cents - i.amount_paid_cents), 0)::bigint
                   FROM invoices i WHERE i.engagement_id = e.id AND i.status IN ('sent', 'overdue')) AS open_balance_cents
           FROM engagements e LEFT JOIN staff ls ON ls.id = e.lead_staff_id
          WHERE e.business_id = $1
          ORDER BY CASE e.status WHEN 'active' THEN 0 WHEN 'on_hold' THEN 1 ELSE 2 END, e.created_at DESC
          LIMIT 200`,
        [id]
      );
      const scopes = await scopeForEngagements(app, eng.rows.map((r) => String(r.id)));
      engagements = {
        rows: eng.rows.map((r) => {
          const items = scopes.get(String(r.id)) ?? [];
          return { ...r, open_balance_cents: Number(r.open_balance_cents), scopeName: scopeName(items, 'en'), scopeSummary: scopeSummary(items) };
        }),
      };
      const ret = await app.db.query(
        `SELECT te.id, te.engagement_id, te.tax_year, te.return_type, te.stage::text AS stage,
                te.preparer_id, prep.display_name AS preparer_name,
                te.preparer_ptin_holder_id, ptin.display_name AS preparer_of_record,
                te.extension_filed, te.filed_date::text AS filed_date,
                te.federal_accepted_on::text AS federal_accepted_on, te.state_accepted_on::text AS state_accepted_on, te.state_accepted_code,
                te.estimated_fee_min_cents, te.estimated_fee_max_cents, te.final_fee_cents,
                te.f8879_document_id, te.f8879_signed_at::date::text AS f8879_signed_on,
                e.contact_id, c.first_name, c.last_name
           FROM tax_engagements te
           JOIN engagements e ON e.id = te.engagement_id
           JOIN contacts c ON c.id = e.contact_id
           LEFT JOIN staff ptin ON ptin.id = te.preparer_ptin_holder_id
           LEFT JOIN staff prep ON prep.id = te.preparer_id
          WHERE e.business_id = $1
          ORDER BY te.tax_year DESC, te.created_at DESC LIMIT 200`,
        [id]
      );
      returns = { rows: ret.rows };
    }

    // ── Service facts (the 0105–0111 tables): the page's own gate. ───────────────────────────────
    const compliance = await app.db.query(
      `SELECT ec.state, ec.anniversary_mmdd, ec.anniversary_kind, ec.annual_report_due_date::text AS annual_report_due_date,
              ec.status::text AS status, ec.last_filed_date::text AS last_filed_date
         FROM entity_compliance ec WHERE ec.business_id = $1`,
      [id]
    );
    const access = await app.db.query(
      `SELECT fact, as_of::text AS as_of, source::text AS source, recorded_at FROM business_access_facts WHERE business_id = $1 ORDER BY fact`,
      [id]
    );
    // Sales-tax frequency and payroll provider are facts about the service, read from the open
    // engagements that carry them, and printed without the engagement (that card has its own gate).
    const lineFacts = await app.db.query<{ service_line: string; filing_frequency: string | null; payroll_provider: string | null }>(
      `SELECT e.service_line::text AS service_line, e.filing_frequency, e.payroll_provider FROM engagements e
        WHERE e.business_id = $1 AND e.status IN ('active', 'on_hold') AND (e.filing_frequency IS NOT NULL OR e.payroll_provider IS NOT NULL)
        ORDER BY e.created_at`,
      [id]
    );
    const imports = await app.db.query(
      `SELECT source::text AS source, trello_source_id, fact_type, as_of::text AS as_of, applied_at, applied_by, rows_written
         FROM service_fact_imports WHERE business_id = $1 ORDER BY applied_at DESC, fact_type`,
      [id]
    );
    const serviceFacts = {
      books: { currentThrough: books_current_through ?? null, asOf: books_current_through_as_of ?? null },
      qbo: { paidBy: qbo_paid_by ?? 'unknown', asOf: qbo_paid_by_as_of ?? null },
      annualReport: compliance.rows[0] ?? null,
      accessFacts: access.rows,
      salesTaxFrequencies: [...new Set(lineFacts.rows.map((r) => r.filing_frequency).filter((v): v is string => v !== null))],
      payrollProviders: [...new Set(lineFacts.rows.map((r) => r.payroll_provider).filter((v): v is string => v !== null))],
      imports: imports.rows,
    };

    // ── Invoices: billing.manage, attributed through the engagement (invoices carry no business_id). ──
    const canInvoices = holds(actor, 'billing.manage');
    let invoices: unknown = { refused: true, permission: 'billing.manage' };
    if (canInvoices) {
      const inv = await app.db.query(
        `SELECT i.id, i.invoice_number, i.status::text AS status, i.total_cents, i.amount_paid_cents, i.amount_refunded_cents,
                i.sent_at, i.paid_at, i.void_reason, i.voided_at, COALESCE(vs.full_name, i.voided_by_label) AS voided_by,
                (SELECT max(r.created_at) FROM invoice_refunds r WHERE r.invoice_id = i.id) AS refunded_at,
                i.contact_id, i.engagement_id, i.tax_engagement_id, i.created_at
           FROM invoices i
           LEFT JOIN staff vs ON vs.id = i.voided_by_staff_id
          WHERE i.engagement_id IN (SELECT e.id FROM engagements e WHERE e.business_id = $1)
             OR i.tax_engagement_id IN (SELECT te.id FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id WHERE e.business_id = $1)
          ORDER BY i.created_at DESC LIMIT 200`,
        [id]
      );
      invoices = { rows: inv.rows };
    }

    // ── Documents: documents.read, the category wall in the query, the list audited. ────────────
    const canDocuments = holds(actor, 'documents.read');
    let documents: unknown = { refused: true, permission: 'documents.read' };
    if (canDocuments) {
      const readable = readableCategories(actor);
      const params: unknown[] = [id];
      let categoryClause = '';
      if (readable !== null) {
        params.push([...readable]);
        categoryClause = ` AND d.category = ANY($${params.length}::document_category[])`;
      }
      const docs = await app.db.query(
        `SELECT d.id, d.contact_id, d.category::text AS category, d.filename AS original_filename, d.mime_type, d.size_bytes,
                d.tax_year, d.status::text AS status, d.scan_status::text AS scan_status, d.uploaded_by_type, d.created_at
           FROM documents d
          WHERE d.business_id = $1 AND d.archived_at IS NULL${categoryClause}
          ORDER BY d.created_at DESC LIMIT 200`,
        params
      );
      documents = { rows: docs.rows };
      await writeAudit(app.db, {
        actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
        action: 'documents.listed', objectType: 'business', objectId: id, ...meta(request),
        details: { count: docs.rows.length, category: null, categories: readable ?? 'all', page: 'business' },
      });
    }

    // Reading a business record is audited like reading a contact record (contact.viewed).
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
      action: 'business.viewed', objectType: 'business', objectId: id, ...meta(request),
      details: { ein_shown: holds(actor, 'pii.read') ? 'full' : 'last4', cards_refused: [canEngagements ? null : 'engagements', canEngagements ? null : 'returns', canInvoices ? null : 'invoices', canDocuments ? null : 'documents'].filter(Boolean) },
    });

    return { business, members: members.rows, engagements, returns, serviceFacts, invoices, documents };
  });

  /** Archive a business (2026-09-12): never a delete; a primary that goes clears the flag and nothing is promoted. */
  app.post<{ Params: { id: string } }>('/businesses/:id/archive', write, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = ArchiveBody.parse(request.body);
    const actor = request.staff!;
    const members = await app.db.query<{ contact_id: string }>(`SELECT contact_id FROM business_members WHERE business_id = $1`, [id]);
    const out = await archiveBusiness(app, id, { reason: b.reason, isTest: b.isTest, testNote: b.testNote }, { id: actor.id, email: actor.email, fullName: actor.fullName }, meta(request));
    // An archived primary leaves the record with no primary; the Missing line follows (2026-09-20).
    for (const m of members.rows) await refreshEnrichmentGaps(app, m.contact_id);
    return out;
  });

  /** Merge businesses (2026-09-12): the same shape as contacts; money-adjacent, so billing.manage or the CEO. */
  app.post<{ Params: { id: string } }>('/businesses/:id/merge', merge, async (request) => {
    const winnerId = z.uuid().parse(request.params.id);
    const b = z.object({ loserIds: z.array(z.uuid()).min(1).max(10), reason: reasonText(10, 1000) }).parse(request.body);
    const actor = request.staff!;
    return mergeBusinesses(app, winnerId, b.loserIds, b.reason, { id: actor.id, email: actor.email, fullName: actor.fullName }, meta(request));
  });

  /**
   * A person chooses the primary business (2026-09-12): the previous one is cleared in the same
   * transaction. businessId null clears it and promotes nothing; the page then says "no primary
   * business set" until someone chooses.
   */
  app.post<{ Params: { id: string } }>('/contacts/:id/primary-business', write, async (request) => {
    const contactId = z.uuid().parse(request.params.id);
    const b = z.object({ businessId: z.uuid().nullable() }).parse(request.body);
    const actor = request.staff!;
    const { withTransaction } = await import('../../db.ts');
    await withTransaction(app.db, async () => {
      if (b.businessId) {
        const member = await app.db.query(`SELECT 1 FROM business_members m JOIN businesses b ON b.id = m.business_id WHERE m.contact_id = $1 AND m.business_id = $2 AND NOT b.is_archived`, [contactId, b.businessId]);
        if (!member.rows[0]) throw new AppError(404, 'not_found', 'This contact is not a member of that business, or it is archived.');
      }
      const cleared = await app.db.query<{ business_id: string }>(`UPDATE business_members SET is_primary = false WHERE contact_id = $1 AND is_primary AND business_id IS DISTINCT FROM $2 RETURNING business_id`, [contactId, b.businessId]);
      for (const c of cleared.rows) {
        await writeAudit(app.db, {
          actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
          action: 'business.primary_cleared', objectType: 'business', objectId: c.business_id, contactId, ...meta(request),
          details: { reason: b.businessId ? 'another business chosen as primary' : 'cleared by a person; none chosen' },
        });
      }
      if (b.businessId) {
        await app.db.query(`UPDATE business_members SET is_primary = true WHERE contact_id = $1 AND business_id = $2`, [contactId, b.businessId]);
        await writeAudit(app.db, {
          actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
          action: 'business.primary_set', objectType: 'business', objectId: b.businessId, contactId, ...meta(request),
        });
      }
    });
    // The Missing line is computed from the primary business (2026-09-20): it follows the choice.
    await refreshEnrichmentGaps(app, contactId);
    return { status: 'ok' };
  });

  /*
   * EDIT AFTER CREATE (Brian, 2026-09-20). The same door as Add — contacts.write or businesses.write,
   * so the entity VA corrects the record she files from — and the same rules: the EIN in one
   * spelling, refused when another open business carries it; a formation date that already
   * happened, recorded as staff-verified. An EIN change gets its own audit row naming the field;
   * the number itself is in neither the row nor any log.
   */
  app.patch<{ Params: { id: string } }>('/businesses/:id', businessWrite, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = BusinessUpdateBody.parse(request.body);
    const actor = request.staff!;

    const current = await app.db.query<{ ein: string | null; is_archived: boolean }>(`SELECT ein, is_archived FROM businesses WHERE id = $1`, [id]);
    if (!current.rows[0]) throw new AppError(404, 'not_found', 'Business not found.');
    if (current.rows[0].is_archived) throw new AppError(409, 'archived', 'This business is archived; its history stays as it was.');
    if (b.formationDate && calendarDay(b.formationDate, 'formationDate') > calendarDay(todayChicago(), 'today')) throw new AppError(400, 'formation_date_in_future', 'A formation date is a thing that already happened.');
    const ein = b.ein === undefined ? undefined : normalizeEin(b.ein);
    // R54: Edit follows the Add rule — another open business holding the number is a warning, and
    // the save goes through only with the person's reason.
    const holder = ein !== undefined ? await findEinHolder(app, ein, id) : null;
    if (holder && !b.duplicateReason) {
      throw new AppError(409, 'ein_in_use', `That EIN is already on ${holder.name}. If this is a different business, say why and save anyway.`);
    }
    const einChanged = ein !== undefined && ein !== current.rows[0].ein;

    const sets: string[] = [];
    const params: unknown[] = [id];
    const map: Record<string, unknown> = {
      name: b.name, ein, industry: b.industry, naics_code: b.naicsCode,
      irs_activity_code: b.irsActivityCode, years_in_business: b.yearsInBusiness,
      revenue_range: b.revenueRange, employees_range: b.employeesRange, zip: b.zip, state: b.state,
      fiscal_year_end_month: b.fiscalYearEndMonth,
      status: b.status,
      is_test: b.isTest,
      test_note: b.testNote,
    };
    if (b.isTest && !b.testNote) throw new AppError(400, 'test_note_required', 'A test flag carries a note saying what the test was.');
    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (b.entityType !== undefined) {
      params.push(b.entityType);
      sets.push(`entity_type = $${params.length}::business_entity_type`);
    }
    if (b.formationDate !== undefined) {
      // The same provenance the create route stamps: a person stated the state's date.
      params.push(b.formationDate);
      sets.push(`formation_date = $${params.length}`, `formation_date_source = 'staff_verified'`, `formation_date_recorded_at = now()`);
    }
    if (sets.length === 0) throw new AppError(400, 'empty_update', 'No fields to update.');
    const res = await app.db.query(`UPDATE businesses SET ${sets.join(', ')} WHERE id = $1`, params);
    if (res.rowCount === 0) throw new AppError(404, 'not_found', 'Business not found.');

    const members = await app.db.query<{ contact_id: string }>(
      `SELECT contact_id FROM business_members WHERE business_id = $1`,
      [id]
    );
    for (const m of members.rows) await refreshEnrichmentGaps(app, m.contact_id);
    const fields = sets.map((s) => s.split(' =')[0]!);
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
      action: 'business.updated', objectType: 'business', objectId: id, contactId: members.rows[0]?.contact_id ?? null, ...meta(request),
      details: { fields },
    });
    if (einChanged) {
      // Its own row, by name: an identifier changed hands. Whether one was on file before is the
      // whole of what the row says about the value.
      await writeAudit(app.db, {
        actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
        action: 'business.ein_changed', objectType: 'business', objectId: id, contactId: members.rows[0]?.contact_id ?? null, ...meta(request),
        details: { field: 'ein', previously_on_file: current.rows[0].ein !== null },
      });
    }
    if (holder) {
      await writeAudit(app.db, {
        actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
        action: 'business.ein_duplicate_accepted', objectType: 'business', objectId: id, contactId: members.rows[0]?.contact_id ?? null, ...meta(request),
        details: { field: 'ein', other_business_id: holder.businessId, reason: b.duplicateReason },
      });
    }
    return { status: 'ok', fields };
  });

  // ── Entity groups (v4.2 module 2) ───────────────────────────────────────
  app.post('/entity-groups', write, async (request, reply) => {
    const b = GroupBody.parse(request.body);
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO entity_groups (name, notes) VALUES ($1, $2) RETURNING id`,
      [b.name, b.notes ?? null]
    );
    return reply.code(201).send({ id: rows[0]!.id });
  });

  app.post<{ Params: { id: string } }>('/entity-groups/:id/members', write, async (request, reply) => {
    const groupId = z.uuid().parse(request.params.id);
    const b = GroupMemberBody.parse(request.body);
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO entity_group_members (group_id, business_id, contact_id, member_role)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [groupId, b.businessId ?? null, b.contactId ?? null, b.memberRole ?? null]
    );
    return reply.code(201).send({ id: rows[0]!.id });
  });

  app.get<{ Params: { id: string } }>('/entity-groups/:id', read, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const group = await app.db.query(`SELECT id, name, notes FROM entity_groups WHERE id = $1`, [id]);
    if (!group.rows[0]) throw new AppError(404, 'not_found', 'Entity group not found.');
    const members = await app.db.query(
      `SELECT gm.id, gm.member_role,
              b.id AS business_id, b.name AS business_name,
              c.id AS contact_id, c.first_name, c.last_name
       FROM entity_group_members gm
       LEFT JOIN businesses b ON b.id = gm.business_id
       LEFT JOIN contacts c ON c.id = gm.contact_id
       WHERE gm.group_id = $1`,
      [id]
    );
    return { group: group.rows[0], members: members.rows };
  });

  // ── v4.3 flow 2: entity-group workflow ────────────────────────────────────

  // Billing mode: consolidated (one invoice, line-itemed per entity) or
  // per_entity. Changeable anytime; takes effect next billing cycle.
  app.patch<{ Params: { id: string } }>('/entity-groups/:id', write, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = z.object({
      name: z.string().min(1).optional(),
      notes: z.string().nullable().optional(),
      billingMode: z.enum(['consolidated', 'per_entity']).optional(),
    }).parse(request.body);
    const sets: string[] = [];
    const params: unknown[] = [id];
    if (b.name !== undefined) { params.push(b.name); sets.push(`name = $${params.length}`); }
    if (b.notes !== undefined) { params.push(b.notes); sets.push(`notes = $${params.length}`); }
    if (b.billingMode !== undefined) { params.push(b.billingMode); sets.push(`billing_mode = $${params.length}`); }
    if (sets.length === 0) throw new AppError(400, 'empty_update', 'No fields to update.');
    const res = await app.db.query(`UPDATE entity_groups SET ${sets.join(', ')} WHERE id = $1`, params);
    if (res.rowCount === 0) throw new AppError(404, 'not_found', 'Entity group not found.');
    await writeAudit(app.db, {
      actorType: 'staff', actorId: request.staff!.id, actorLabel: request.staff!.fullName,
      action: 'entity_group.updated', objectType: 'entity_group', objectId: id,
      details: { fields: sets.map((s) => s.split(' =')[0]) },
    });
    return { status: 'ok' };
  });

  // Consolidated packet: members + per-entity engagements for the year with
  // ESTIMATES and a rollup (the group view Brian preps from).
  app.get<{ Params: { id: string } }>('/entity-groups/:id/packet', read, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const q = z.object({ taxYear: z.coerce.number().int().optional() }).parse(request.query);
    const group = await app.db.query(
      `SELECT id, name, notes, billing_mode FROM entity_groups WHERE id = $1`, [id]
    );
    if (!group.rows[0]) throw new AppError(404, 'not_found', 'Entity group not found.');
    const params: unknown[] = [id];
    let yearClause = '';
    if (q.taxYear) { params.push(q.taxYear); yearClause = `AND te.tax_year = $${params.length}`; }
    const entities = await app.db.query<{
      business_id: string; business_name: string; te_id: string | null; engagement_id: string | null; tax_year: number | null;
      return_type: string | null; stage: string | null;
      estimated_fee_min_cents: number | null; estimated_fee_max_cents: number | null;
      final_fee_cents: number | null; f8879_signed_at: Date | null; invoice_number: string | null;
    }>(
      `SELECT b.id AS business_id, b.name AS business_name,
              te.id AS te_id, te.engagement_id, te.tax_year, te.return_type, te.stage,
              te.estimated_fee_min_cents, te.estimated_fee_max_cents, te.final_fee_cents,
              te.f8879_signed_at, te.invoice_number
       FROM entity_group_members gm
       JOIN businesses b ON b.id = gm.business_id
       LEFT JOIN engagements e ON e.business_id = b.id AND e.service_line = 'tax'
       LEFT JOIN tax_engagements te ON te.engagement_id = e.id ${yearClause}
       WHERE gm.group_id = $1
       ORDER BY b.name, te.tax_year DESC`,
      params
    );
    const withTe = entities.rows.filter((r) => r.te_id);
    const rollup = {
      entities: new Set(entities.rows.map((r) => r.business_id)).size,
      // R89: an engagement may hold one return per year, so the two counts are read apart.
      engagements: new Set(withTe.map((r) => r.engagement_id)).size,
      returns: withTe.length,
      estimatedMinCents: withTe.reduce((a, r) => a + (r.estimated_fee_min_cents ?? 0), 0),
      estimatedMaxCents: withTe.reduce((a, r) => a + (r.estimated_fee_max_cents ?? 0), 0),
      finalFeeCents: withTe.reduce((a, r) => a + (r.final_fee_cents ?? 0), 0),
      awaiting8879: withTe.filter((r) => !r.f8879_signed_at && r.stage !== 'completed' && r.stage !== 'withdrawn').length,
      byStage: withTe.reduce<Record<string, number>>((acc, r) => {
        if (r.stage) acc[r.stage] = (acc[r.stage] ?? 0) + 1;
        return acc;
      }, {}),
    };
    return { group: group.rows[0], entities: entities.rows, rollup };
  });

  // ONE bundled envelope + ONE KBA for every group 8879 still unsigned.
  app.post<{ Params: { id: string } }>('/entity-groups/:id/f8879-envelope', taxManage, async (request, reply) => {
    const id = z.uuid().parse(request.params.id);
    const b = z.object({ taxYear: z.number().int().min(2000).max(2100) }).parse(request.body);
    void b; void id; void reply;
    // RETIRED (2026-09-12): the bundled remote 8879 went with the remote path. Each return's 8879 is a wet-signed upload.
    throw new AppError(410, 'remote_8879_retired', 'The bundled remote 8879 envelope is retired. Upload each wet-signed 8879 to its return.');
  });

  // Consolidated invoice: ONE invoice, line-itemed per entity from each
  // engagement's final fee (which came from the price-book estimate flow).
  app.post<{ Params: { id: string } }>('/entity-groups/:id/invoice', taxManage, async (request, reply) => {
    const id = z.uuid().parse(request.params.id);
    const b = z.object({ taxYear: z.number().int().min(2000).max(2100) }).parse(request.body);
    const group = await app.db.query<{ billing_mode: string }>(
      `SELECT billing_mode FROM entity_groups WHERE id = $1`, [id]
    );
    if (!group.rows[0]) throw new AppError(404, 'not_found', 'Entity group not found.');
    if (group.rows[0].billing_mode !== 'consolidated') {
      throw new AppError(409, 'per_entity_mode', 'This group bills per entity — invoice each engagement individually.');
    }
    const billable = await app.db.query<{
      te_id: string; engagement_id: string; business_name: string; return_type: string; tax_year: number;
      final_fee_cents: number; contact_id: string;
    }>(
      `SELECT te.id AS te_id, e.id AS engagement_id, b.name AS business_name, te.return_type, te.tax_year,
              te.final_fee_cents, e.contact_id
       FROM entity_group_members gm
       JOIN businesses b ON b.id = gm.business_id
       JOIN engagements e ON e.business_id = b.id AND e.service_line = 'tax'
       JOIN tax_engagements te ON te.engagement_id = e.id
       WHERE gm.group_id = $1 AND te.tax_year = $2
         AND te.final_fee_cents IS NOT NULL AND te.invoice_number IS NULL
         AND te.stage IN ('filed', 'rejected', 'completed')`,
      [id, b.taxYear]
    );
    if (billable.rows.length === 0) {
      throw new AppError(400, 'nothing_billable', 'No filed group returns with a final fee are awaiting an invoice.');
    }
    // R68: the consolidated invoice names no engagement of its own, so each return's parent is asked.
    for (const engagementId of new Set(billable.rows.map((r) => r.engagement_id))) {
      await assertNotBillingHeld(app, engagementId, { type: 'staff', id: request.staff!.id, label: request.staff!.fullName }, { via: 'entity_group.invoice' });
    }
    const invoice = await createInvoice(
      app,
      { type: 'staff', id: request.staff!.id, label: request.staff!.fullName },
      {
        contactId: billable.rows[0]!.contact_id,
        lines: billable.rows.map((r) => ({
          description: `${r.business_name} — ${r.tax_year} ${r.return_type.toUpperCase()} preparation`,
          qty: 1,
          unitCents: r.final_fee_cents,
        })),
      }
    );
    await app.db.query(
      `UPDATE tax_engagements SET invoice_number = $2, invoice_amount_cents = final_fee_cents WHERE id = ANY($1::uuid[])`,
      [billable.rows.map((r) => r.te_id), invoice.invoiceNumber]
    );
    await writeAudit(app.db, {
      actorType: 'staff', actorId: request.staff!.id, actorLabel: request.staff!.fullName,
      action: 'entity_group.consolidated_invoice', objectType: 'entity_group', objectId: id,
      details: { invoice_number: invoice.invoiceNumber, engagements: billable.rows.length, total_cents: invoice.totalCents },
    });
    return reply.code(201).send({ ...invoice, engagements: billable.rows.length });
  });

  // ── Jobs ────────────────────────────────────────────────────────────────
  // Manual trigger now; the scheduler wires it to a cadence in M8.
  app.post('/jobs/health-refresh', { preHandler: [app.authenticate, requirePermission('jobs.run')] }, async () => {
    return runHealthRefresh(app);
  });
}
