// CRM: contacts, businesses, entity groups (MP Unified Contact Record,
// v4.2 module 2). Contact detail reads are audit-logged — contact identity
// fields are PII under the WISP rule. SSNs are NEVER returned by these
// endpoints (status + last-4 only).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../audit.ts';
import { requirePermission } from '../../plugins/auth.ts';
import { AppError } from '../../types.ts';
import { refreshEnrichmentGaps } from './service.ts';
import { runHealthRefresh } from './health.ts';
import { startGroupRemote8879 } from '../signatures/service.ts';
import { createInvoice } from '../billing/service.ts';

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

const ContactUpdateBody = ContactCreateBody.partial();

const BusinessBody = z.object({
  name: z.string().min(1),
  ein: z.string().regex(/^\d{2}-?\d{7}$/, 'EIN must be 9 digits (XX-XXXXXXX)').optional(),
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
});

const BusinessUpdateBody = BusinessBody.omit({ memberRole: true }).partial();

const GroupBody = z.object({ name: z.string().min(1), notes: z.string().optional() });
const GroupMemberBody = z
  .object({ businessId: z.uuid().optional(), contactId: z.uuid().optional(), memberRole: z.string().optional() })
  .refine((b) => (b.businessId === undefined) !== (b.contactId === undefined), {
    message: 'Provide exactly one of businessId or contactId.',
  });

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
          WHERE bm.contact_id = c.id AND b.name ILIKE $1
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
               WHERE bm.contact_id = c.id
               ORDER BY
                 CASE WHEN $1::text IS NOT NULL AND b.name ILIKE $1 THEN 0 ELSE 1 END,
                 bm.is_primary DESC, b.name
               LIMIT 1) AS business_name,
              (SELECT count(*)::int FROM engagements e
               WHERE e.contact_id = c.id AND e.status IN ('active', 'on_hold')) AS active_engagements
       FROM contacts c
       WHERE ${clauses.join(' AND ')}
       ORDER BY c.last_name, c.first_name
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return { contacts: rows, total: totalRow.rows[0]!.n, limit: q.limit, offset: q.offset };
  });

  app.post('/contacts', write, async (request, reply) => {
    const b = ContactCreateBody.parse(request.body);
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
    await refreshEnrichmentGaps(app.db, id);
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
      action: 'contact.created', objectType: 'contact', objectId: id, contactId: id, ...meta(request),
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
                AS portal_link_sent_at
       FROM contacts c WHERE c.id = $1 AND NOT c.is_archived`,
      [id]
    );
    if (!contact.rows[0]) throw new AppError(404, 'not_found', 'Contact not found.');

    const businesses = await app.db.query(
      `SELECT b.id, b.name, b.ein, b.entity_type, b.industry, b.naics_code, b.state,
              b.fiscal_year_end_month, b.il_sos_status, m.member_role, m.is_primary
       FROM businesses b JOIN business_members m ON m.business_id = b.id
       WHERE m.contact_id = $1 ORDER BY m.is_primary DESC, b.name`,
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
      actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
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
    const res = await app.db.query(`UPDATE contacts SET ${sets.join(', ')} WHERE id = $1 AND NOT is_archived`, params);
    if (res.rowCount === 0) throw new AppError(404, 'not_found', 'Contact not found.');

    const gaps = await refreshEnrichmentGaps(app.db, id);
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
      action: 'contact.updated', objectType: 'contact', objectId: id, contactId: id, ...meta(request),
      details: { fields: sets.map((s) => s.split(' =')[0]) },
    });
    return { status: 'ok', enrichmentGaps: gaps };
  });

  // ── Businesses ──────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/contacts/:id/businesses', write, async (request, reply) => {
    const contactId = z.uuid().parse(request.params.id);
    const b = BusinessBody.parse(request.body);
    const actor = request.staff!;

    const existing = await app.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM business_members WHERE contact_id = $1`,
      [contactId]
    );
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO businesses (name, ein, entity_type, industry, naics_code, irs_activity_code,
                               years_in_business, revenue_range, employees_range, zip, state, fiscal_year_end_month)
       VALUES ($1,$2,$3::business_entity_type,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [
        b.name, b.ein ?? null, b.entityType ?? null, b.industry ?? null, b.naicsCode ?? null,
        b.irsActivityCode ?? null, b.yearsInBusiness ?? null, b.revenueRange ?? null, b.employeesRange ?? null,
        b.zip ?? null, b.state, b.fiscalYearEndMonth,
      ]
    );
    const businessId = rows[0]!.id;
    await app.db.query(
      `INSERT INTO business_members (business_id, contact_id, member_role, is_primary) VALUES ($1, $2, $3, $4)`,
      [businessId, contactId, b.memberRole, existing.rows[0]!.n === 0]
    );
    await refreshEnrichmentGaps(app.db, contactId);
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
      action: 'business.created', objectType: 'business', objectId: businessId, contactId, ...meta(request),
    });
    return reply.code(201).send({ id: businessId });
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
      `SELECT b.id, b.name, b.entity_type FROM businesses b ${where} ORDER BY b.name LIMIT $${params.length}`,
      params
    );
    return { businesses: rows };
  });

  app.patch<{ Params: { id: string } }>('/businesses/:id', write, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = BusinessUpdateBody.parse(request.body);
    const actor = request.staff!;

    const sets: string[] = [];
    const params: unknown[] = [id];
    const map: Record<string, unknown> = {
      name: b.name, ein: b.ein, industry: b.industry, naics_code: b.naicsCode,
      irs_activity_code: b.irsActivityCode, years_in_business: b.yearsInBusiness,
      revenue_range: b.revenueRange, employees_range: b.employeesRange, zip: b.zip, state: b.state,
      fiscal_year_end_month: b.fiscalYearEndMonth,
    };
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
    if (sets.length === 0) throw new AppError(400, 'empty_update', 'No fields to update.');
    const res = await app.db.query(`UPDATE businesses SET ${sets.join(', ')} WHERE id = $1`, params);
    if (res.rowCount === 0) throw new AppError(404, 'not_found', 'Business not found.');

    const members = await app.db.query<{ contact_id: string }>(
      `SELECT contact_id FROM business_members WHERE business_id = $1`,
      [id]
    );
    for (const m of members.rows) await refreshEnrichmentGaps(app.db, m.contact_id);
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
      action: 'business.updated', objectType: 'business', objectId: id, ...meta(request),
      details: { fields: sets.map((s) => s.split(' =')[0]) },
    });
    return { status: 'ok' };
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
      actorType: 'staff', actorId: request.staff!.id, actorLabel: request.staff!.email,
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
      business_id: string; business_name: string; te_id: string | null; tax_year: number | null;
      return_type: string | null; stage: string | null;
      estimated_fee_min_cents: number | null; estimated_fee_max_cents: number | null;
      final_fee_cents: number | null; f8879_signed_at: Date | null; invoice_number: string | null;
    }>(
      `SELECT b.id AS business_id, b.name AS business_name,
              te.id AS te_id, te.tax_year, te.return_type, te.stage,
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
      engagements: withTe.length,
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
    const result = await startGroupRemote8879(app, { id: request.staff!.id, label: request.staff!.email }, id, b.taxYear);
    return reply.code(201).send(result);
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
      te_id: string; business_name: string; return_type: string; tax_year: number;
      final_fee_cents: number; contact_id: string;
    }>(
      `SELECT te.id AS te_id, b.name AS business_name, te.return_type, te.tax_year,
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
      throw new AppError(400, 'nothing_billable', 'No filed group engagements with a final fee are awaiting an invoice.');
    }
    const invoice = await createInvoice(
      app,
      { type: 'staff', id: request.staff!.id, label: request.staff!.email },
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
      actorType: 'staff', actorId: request.staff!.id, actorLabel: request.staff!.email,
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
