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

const ContactCreateBody = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.email().optional(),
  phone: z.string().optional(),
  secondaryPhone: z.string().optional(),
  language: z.enum(['en', 'es']).default('en'),
  preferredContactMethod: z.enum(['phone', 'email', 'portal', 'text']).optional(),
  sotoStatus: z.enum(['none', 'lead', 'active', 'inactive', 'former']).default('lead'),
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

  // ── Contacts ────────────────────────────────────────────────────────────
  app.get('/contacts', read, async (request) => {
    const q = SearchQuery.parse(request.query);
    const clauses: string[] = ['NOT c.is_archived'];
    const params: unknown[] = [];
    if (q.search) {
      params.push(`%${q.search}%`);
      clauses.push(
        `(c.first_name ILIKE $${params.length} OR c.last_name ILIKE $${params.length} OR (c.first_name || ' ' || c.last_name) ILIKE $${params.length} OR c.email::text ILIKE $${params.length} OR c.phone ILIKE $${params.length})`
      );
    }
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
    params.push(q.limit, q.offset);
    const { rows } = await app.db.query(
      `SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.language,
              c.soto_status, c.hilo_status, c.health_score, c.assigned_manager_id, c.client_since
       FROM contacts c
       WHERE ${clauses.join(' AND ')}
       ORDER BY c.last_name, c.first_name
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return { contacts: rows, limit: q.limit, offset: q.offset };
  });

  app.post('/contacts', write, async (request, reply) => {
    const b = ContactCreateBody.parse(request.body);
    const actor = request.staff!;
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO contacts (first_name, last_name, email, phone, secondary_phone, language,
                             preferred_contact_method, soto_status, hilo_status, assigned_manager_id,
                             client_since, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::soto_status,$9::hilo_status,$10,$11,$12)
       RETURNING id`,
      [
        b.firstName, b.lastName, b.email ?? null, b.phone ?? null, b.secondaryPhone ?? null, b.language,
        b.preferredContactMethod ?? null, b.sotoStatus, b.hiloStatus, b.assignedManagerId ?? null,
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
              c.soto_status, c.hilo_status, c.client_since, c.hilo_first_contact, c.assigned_manager_id,
              c.consent_7216_status, c.engagement_letter_status,
              c.health_score, c.health_components, c.health_computed_at,
              c.sms_consent, c.source, c.ssn_status, c.ssn_last4, c.notes,
              c.br1_referred_by_hilo, c.br3_referred_by_jackson, c.br4_hilo_program_participant
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
      soto_status: b.sotoStatus, hilo_status: b.hiloStatus, assigned_manager_id: b.assignedManagerId,
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

  // ── Jobs ────────────────────────────────────────────────────────────────
  // Manual trigger now; the scheduler wires it to a cadence in M8.
  app.post('/jobs/health-refresh', { preHandler: [app.authenticate, requirePermission('jobs.run')] }, async () => {
    return runHealthRefresh(app);
  });
}
