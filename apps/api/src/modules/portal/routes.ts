// Client portal endpoints. ROW-LEVEL RULE (MP: "clients see only their own
// records"): every query here filters by request.client.contactId — the id
// from the verified session. Client-supplied ids are NEVER used for scoping;
// anything not owned by the caller behaves as if it does not exist.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { firstActiveByRole, notifyOnce } from '../../staffing.ts';
import { refreshEnrichmentGaps } from '../crm/service.ts';
import { computeQuote } from '../pricing/service.ts';

const ProfileBody = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().optional(),
  secondaryPhone: z.string().optional(),
  preferredContactMethod: z.enum(['phone', 'email', 'portal', 'text']).optional(),
  language: z.enum(['en', 'es']).optional(),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zip: z.string().optional(),
});

const ServiceRequestBody = z.object({
  service: z.enum(['tax', 'bookkeeping', 'advisory', 'entity', 'irs_notice_help', 'other']),
  notes: z.string().max(2000).optional(),
});

const EstimateBody = z.object({
  filingStatus: z.enum(['single', 'mfj', 'mfs', 'hoh']),
  schC: z.number().int().min(0).max(10).default(0),
  rentals: z.number().int().min(0).max(20).default(0),
  k1s: z.number().int().min(0).max(20).default(0),
  states: z.number().int().min(1).max(10).default(1),
  businessReturn: z.enum(['none', '1065', '1120s', '1120']).default('none'),
});

const MessageBody = z.object({
  threadId: z.uuid().optional(),
  subject: z.string().max(200).optional(),
  body: z.string().min(1).max(10000),
});

const FILING_STATUS_ITEM: Record<string, string> = {
  single: 'IND_BASE_SINGLE', mfj: 'IND_BASE_MFJ', mfs: 'IND_BASE_MFS', hoh: 'IND_BASE_HOH',
};
const BUSINESS_RETURN_ITEM: Record<string, string> = {
  '1065': 'BIZ_1065', '1120s': 'BIZ_1120S', '1120': 'BIZ_1120',
};

export function registerPortalRoutes(app: FastifyInstance): void {
  const scoped = { preHandler: [app.authenticateClient] };

  app.get('/portal/me', scoped, async (request) => {
    const client = request.client!;
    const { rows } = await app.db.query(
      `SELECT id, first_name, last_name, email, phone, secondary_phone, preferred_contact_method, language,
              address_line1, address_line2, city, state, zip, soto_status, hilo_status
       FROM contacts WHERE id = $1`,
      [client.contactId]
    );
    return { contact: rows[0] ?? null };
  });

  // Profile + LANGUAGE TOGGLE persistence (applied to all outbound comms).
  app.patch('/portal/me', scoped, async (request) => {
    const client = request.client!;
    const b = ProfileBody.parse(request.body);
    const sets: string[] = [];
    const params: unknown[] = [client.contactId];
    const map: Record<string, unknown> = {
      first_name: b.firstName, last_name: b.lastName, phone: b.phone, secondary_phone: b.secondaryPhone,
      language: b.language, address_line1: b.addressLine1, address_line2: b.addressLine2,
      city: b.city, state: b.state, zip: b.zip,
    };
    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) { params.push(val); sets.push(`${col} = $${params.length}`); }
    }
    if (b.preferredContactMethod !== undefined) {
      params.push(b.preferredContactMethod);
      sets.push(`preferred_contact_method = $${params.length}::contact_method`);
    }
    if (sets.length === 0) throw new AppError(400, 'empty_update', 'No fields to update.');
    await app.db.query(`UPDATE contacts SET ${sets.join(', ')} WHERE id = $1`, params);
    await refreshEnrichmentGaps(app.db, client.contactId);
    await writeAudit(app.db, {
      actorType: 'client', actorId: client.portalUserId, actorLabel: client.email,
      action: 'contact.self_updated', objectType: 'contact', objectId: client.contactId,
      contactId: client.contactId, ip: request.ip,
      details: { fields: sets.map((s) => s.split(' =')[0]) },
    });
    return { status: 'ok' };
  });

  app.get('/portal/documents', scoped, async (request) => {
    const client = request.client!;
    const { rows } = await app.db.query(
      `SELECT id, category, status, filename, tax_year, uploaded_at
       FROM documents
       WHERE contact_id = $1 AND archived_at IS NULL
       ORDER BY uploaded_at DESC`,
      [client.contactId]
    );
    return { documents: rows };
  });

  // My Returns: delivered final return PDFs (ATX handoff), all years.
  app.get('/portal/returns', scoped, async (request) => {
    const client = request.client!;
    const { rows } = await app.db.query(
      `SELECT id, filename, tax_year, uploaded_at
       FROM documents
       WHERE contact_id = $1 AND category = 'return_deliverable' AND archived_at IS NULL
       ORDER BY tax_year DESC NULLS LAST, uploaded_at DESC`,
      [client.contactId]
    );
    return { returns: rows };
  });

  // Plain-English engagement status for the dashboard.
  app.get('/portal/engagements', scoped, async (request) => {
    const client = request.client!;
    const { rows } = await app.db.query(
      `SELECT te.id, te.tax_year, te.return_type, te.stage, te.extension_filed,
              COALESCE(te.extended_deadline, te.original_deadline)::text AS deadline
       FROM tax_engagements te
       JOIN engagements e ON e.id = te.engagement_id
       WHERE e.contact_id = $1 AND te.stage NOT IN ('withdrawn')
       ORDER BY te.tax_year DESC`,
      [client.contactId]
    );
    return { engagements: rows };
  });

  // Resource Library (published entries, both languages carried).
  app.get('/portal/resources', scoped, async () => {
    const { rows } = await app.db.query(
      `SELECT id, title_en, title_es, description_en, description_es, resource_type, url, document_id
       FROM resource_library
       WHERE is_published AND audience IN ('soto', 'both')
       ORDER BY sort_order, title_en`
    );
    return { resources: rows };
  });

  // Request a Service → CRM opportunity + 24h response commitment (MP).
  app.post('/portal/service-requests', scoped, async (request, reply) => {
    const client = request.client!;
    const b = ServiceRequestBody.parse(request.body);
    const rene = await firstActiveByRole(app.db, 'comms_billing');
    const task = await app.db.query<{ id: string }>(
      `INSERT INTO tasks (title, description, assigned_staff_id, contact_id, priority, source, source_type, due_date)
       VALUES ($1, $2, $3, $4, 1, 'automation', 'service_request', CURRENT_DATE + 1)
       RETURNING id`,
      [
        `Service request (${b.service}) — respond within 24h`,
        b.notes ?? null, rene, client.contactId,
      ]
    );
    if (rene) {
      await notifyOnce(app.db, {
        staffId: rene, type: 'service_request', severity: 'info',
        title: `New service request: ${b.service}`,
        contactId: client.contactId, relatedObjectType: 'task', relatedObjectId: task.rows[0]!.id,
      });
    }
    await writeAudit(app.db, {
      actorType: 'client', actorId: client.portalUserId, actorLabel: client.email,
      action: 'service_request.created', objectType: 'task', objectId: task.rows[0]!.id,
      contactId: client.contactId, details: { service: b.service },
    });
    return reply.code(201).send({ status: 'ok' });
  });

  // Get an Estimate: guided answers → price RANGE (never an exact figure, MP).
  app.post('/portal/estimate', scoped, async (request) => {
    const client = request.client!;
    const b = EstimateBody.parse(request.body);
    const items: Array<{ code: string; qty?: number }> = [{ code: FILING_STATUS_ITEM[b.filingStatus]! }];
    if (b.schC > 0) items.push({ code: 'IND_SCH_C', qty: b.schC });
    if (b.rentals > 0) items.push({ code: 'IND_SCH_E_RENTAL', qty: b.rentals });
    if (b.k1s > 0) items.push({ code: 'IND_SCH_E_K1', qty: b.k1s });
    if (b.states > 1) items.push({ code: 'IND_ADDL_STATE', qty: b.states - 1 });
    if (b.businessReturn !== 'none') items.push({ code: BUSINESS_RETURN_ITEM[b.businessReturn]! });

    const quote = await computeQuote(app, { items, language: client.language });
    const range = quote.revenue.one_time ?? { minCents: 0, maxCents: 0 };
    await writeAudit(app.db, {
      actorType: 'client', actorId: client.portalUserId, actorLabel: client.email,
      action: 'estimate.requested', contactId: client.contactId,
      details: { inputs: b, range_cents: range },
    });
    // RANGE ONLY — no itemized breakdown to the client.
    return { minCents: range.minCents, maxCents: range.maxCents };
  });

  // Messages: one conversation history (email/SMS join it in Phase 2).
  app.get('/portal/messages', scoped, async (request) => {
    const client = request.client!;
    const { rows } = await app.db.query(
      `SELECT t.id, t.subject, t.last_message_at,
              COALESCE(json_agg(json_build_object(
                'id', m.id, 'direction', m.direction, 'body', m.body, 'sentAt', m.sent_at,
                'senderType', m.sender_type
              ) ORDER BY m.sent_at) FILTER (WHERE m.id IS NOT NULL), '[]') AS messages
       FROM message_threads t
       LEFT JOIN messages m ON m.thread_id = t.id
       WHERE t.contact_id = $1
       GROUP BY t.id
       ORDER BY t.last_message_at DESC NULLS LAST`,
      [client.contactId]
    );
    return { threads: rows };
  });

  app.post('/portal/messages', scoped, async (request, reply) => {
    const client = request.client!;
    const b = MessageBody.parse(request.body);
    let threadId = b.threadId ?? null;
    if (threadId) {
      const owned = await app.db.query(`SELECT 1 FROM message_threads WHERE id = $1 AND contact_id = $2`, [
        threadId, client.contactId,
      ]);
      if (!owned.rows[0]) throw new AppError(404, 'not_found', 'Thread not found.');
    } else {
      const t = await app.db.query<{ id: string }>(
        `INSERT INTO message_threads (contact_id, subject) VALUES ($1, $2) RETURNING id`,
        [client.contactId, b.subject ?? 'Portal message']
      );
      threadId = t.rows[0]!.id;
    }
    await app.db.query(
      `INSERT INTO messages (thread_id, direction, channel, sender_type, body, language)
       VALUES ($1, 'inbound', 'portal', 'client', $2, $3)`,
      [threadId, b.body, client.language]
    );
    await app.db.query(`UPDATE message_threads SET last_message_at = now(), status = 'open' WHERE id = $1`, [threadId]);
    const rene = await firstActiveByRole(app.db, 'comms_billing');
    if (rene) {
      await app.db.query(
        `INSERT INTO notifications (staff_id, type, severity, title, contact_id, related_object_type, related_object_id)
         VALUES ($1, 'portal_message', 'info', $2, $3, 'message_thread', $4)`,
        [rene, `Portal message from ${client.email}`, client.contactId, threadId]
      );
    }
    return reply.code(201).send({ threadId });
  });
}
