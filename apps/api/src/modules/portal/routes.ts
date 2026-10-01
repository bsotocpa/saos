// Client portal endpoints. ROW-LEVEL RULE (MP: "clients see only their own
// records"): every query here filters by request.client.contactId — the id
// from the verified session. Client-supplied ids are NEVER used for scoping;
// anything not owned by the caller behaves as if it does not exist.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { alertRecipientForRole, notifyOnce, ownerForRole } from '../../staffing.ts';
import { refreshEnrichmentGaps } from '../crm/service.ts';
import { cascadeUnblock, createTask } from '../tasks/service.ts';
import { computeQuote } from '../pricing/service.ts';
import { addDays, overdueSince, todayChicago, upcomingEstimateDates } from '../tax/deadlines.ts';
import { WITHDRAWN_KIND_SQL, WITHDRAWN_ON_SQL } from '../tax/withdrawn.ts';

/**
 * A FILED RETURN'S ANSWERS, PER JURISDICTION (R48, 2026-09-26; R84, 2026-09-27): one line per row the
 * return declared (tax_engagement_jurisdictions) that has answered, an e-file row by its acceptance
 * day and a paper row by its mailing day, federal first. A return filed before the jurisdictions table
 * existed (migration 0104) has no declared rows and reads its lines from the summary columns. Both
 * My Returns and the Home services card read these, so the two never say different things.
 */
export type AnswerLine = { jurisdiction: string; kind: 'accepted' | 'mailed'; answered_on: string };
export async function answerLinesFor(
  app: FastifyInstance,
  returns: ReadonlyArray<{ id: string; federal_accepted_on: string | null; state_accepted_on: string | null; state_accepted_code: string | null }>
): Promise<Map<string, AnswerLine[]>> {
  const out = new Map<string, AnswerLine[]>();
  if (returns.length === 0) return out;
  const declared = (await app.db.query<{ tax_engagement_id: string; jurisdiction: string; accepted_on: string | null; mailed_on: string | null }>(
    `SELECT tax_engagement_id, jurisdiction, accepted_on::text AS accepted_on, mailed_on::text AS mailed_on
       FROM tax_engagement_jurisdictions
      WHERE tax_engagement_id = ANY($1::uuid[])
      ORDER BY (jurisdiction <> 'federal'), jurisdiction`,
    [returns.map((r) => r.id)]
  )).rows;
  for (const r of returns) {
    const mine = declared.filter((d) => d.tax_engagement_id === r.id);
    if (mine.length > 0) {
      out.set(r.id, mine.flatMap((d): AnswerLine[] => {
        if (d.mailed_on) return [{ jurisdiction: d.jurisdiction, kind: 'mailed', answered_on: d.mailed_on }];
        if (d.accepted_on) return [{ jurisdiction: d.jurisdiction, kind: 'accepted', answered_on: d.accepted_on }];
        return [];
      }));
      continue;
    }
    const summary: AnswerLine[] = [];
    if (r.federal_accepted_on) summary.push({ jurisdiction: 'federal', kind: 'accepted', answered_on: r.federal_accepted_on });
    if (r.state_accepted_on && r.state_accepted_code) summary.push({ jurisdiction: r.state_accepted_code.toUpperCase(), kind: 'accepted', answered_on: r.state_accepted_on });
    out.set(r.id, summary);
  }
  return out;
}

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
  // v4.3: quarterly-estimate dates/reminders toggle (notification settings).
  estimateReminders: z.boolean().optional(),
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
              address_line1, address_line2, city, state, zip, soto_status, hilo_status,
              estimate_reminders_enabled, sms_consent, sms_consent_at
       FROM contacts WHERE id = $1`,
      [client.contactId]
    );
    const contact = (rows[0] ?? null) as { estimate_reminders_enabled?: boolean } | null;
    // v4.3: next quarterly estimate date shows in the portal while the
    // toggle is ON (default); staff surfaces are unaffected by the toggle.
    const nextEstimate = contact?.estimate_reminders_enabled
      ? upcomingEstimateDates(todayChicago(), 1)[0] ?? null
      : null;
    return { contact, nextEstimate };
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
      estimate_reminders_enabled: b.estimateReminders,
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
    await refreshEnrichmentGaps(app, client.contactId);
    await writeAudit(app.db, {
      actorType: 'client', actorId: client.portalUserId, actorLabel: client.displayName,
      action: 'contact.self_updated', objectType: 'contact', objectId: client.contactId,
      contactId: client.contactId, ip: request.ip,
      details: { fields: sets.map((s) => s.split(' =')[0]) },
    });
    return { status: 'ok' };
  });

  /**
   * SMS consent, offered in the portal welcome flow (Brian's addition,
   * 2026-08-09). The migrated book has 433 active clients and ZERO SMS consent
   * on record, so without a backfill path that number only moves through new
   * onboarding — and every text nudge stays permanently suppressed for existing
   * clients.
   *
   * TCPA discipline:
   *  · consent is EXPRESS and affirmative — the client posts `true`; there is no
   *    pre-ticked box and no consent-by-silence
   *  · a phone number is required, because consent without a number is not
   *    consent to anything
   *  · the exact disclosure text the client saw is versioned into the consents
   *    row, so what they agreed to is reconstructable years later
   *  · revocation is symmetric and immediate, and does NOT require STOP by text
   */
  app.post('/portal/sms-consent', scoped, async (request) => {
    const client = request.client!;
    const b = z
      .object({
        consent: z.boolean(),
        phone: z.string().min(7).max(40).optional(),
        policyVersion: z.string().min(1).max(64).default('sms-portal-optin-v1'),
      })
      .parse(request.body);

    if (b.consent) {
      const existing = await app.db.query<{ phone: string | null }>(
        `SELECT phone FROM contacts WHERE id = $1`,
        [client.contactId]
      );
      const phone = b.phone ?? existing.rows[0]?.phone ?? null;
      if (!phone) {
        throw new AppError(
          400,
          'phone_required',
          'A mobile number is needed before text messages can be turned on.'
        );
      }
      await app.db.query(
        `UPDATE contacts SET sms_consent = true, sms_consent_at = now(), phone = $2 WHERE id = $1`,
        [client.contactId, phone]
      );
      await app.db.query(
        `INSERT INTO consents (contact_id, type, status, method, policy_version, signed_at)
         VALUES ($1, 'sms', 'signed', 'portal_checkbox', $2, now())`,
        [client.contactId, b.policyVersion]
      );
    } else {
      await app.db.query(
        `UPDATE contacts SET sms_consent = false, sms_consent_at = NULL WHERE id = $1`,
        [client.contactId]
      );
      await app.db.query(
        `INSERT INTO consents (contact_id, type, status, method, policy_version, revoked_at)
         VALUES ($1, 'sms', 'revoked', 'portal_checkbox', $2, now())`,
        [client.contactId, b.policyVersion]
      );
    }

    await writeAudit(app.db, {
      actorType: 'client', actorId: client.portalUserId, actorLabel: client.displayName,
      action: b.consent ? 'sms.consent_granted' : 'sms.consent_revoked',
      objectType: 'contact', objectId: client.contactId,
      contactId: client.contactId, ip: request.ip,
      details: { policy_version: b.policyVersion, source: 'portal_welcome' },
    });
    return { smsConsent: b.consent };
  });

  // ── Client to-dos (v4.4): ONE standing list — staff-added client-visible
  // tasks + system items aggregated live from open document requests and
  // pending signatures. Aggregation makes auto-close inherent: an upload
  // fulfills its request item and the to-do disappears.
  app.get('/portal/todos', scoped, async (request) => {
    const client = request.client!;
    const tasks = await app.db.query(
      `SELECT id, title, description, due_date::text AS due_date, 'task' AS kind
       FROM tasks
       WHERE contact_id = $1 AND client_visible AND status IN ('not_started', 'in_progress', 'waiting_for_input')
       ORDER BY due_date NULLS LAST, created_at`,
      [client.contactId]
    );
    const docItems = await app.db.query(
      `SELECT i.id, COALESCE(NULLIF(CASE WHEN c.language = 'es' THEN i.label_es ELSE i.label_en END, ''), i.label_en) AS title,
              NULL AS description, r.due_date::text AS due_date, 'upload' AS kind
       FROM document_request_items i
       JOIN document_requests r ON r.id = i.request_id
       JOIN contacts c ON c.id = r.contact_id
       WHERE r.contact_id = $1 AND i.status = 'pending' AND r.status <> 'complete'
       ORDER BY r.due_date NULLS LAST`,
      [client.contactId]
    );
    const envelopes = await app.db.query(
      `SELECT id, 'Sign: ' || replace(type::text, '_', ' ') AS title, NULL AS description, NULL AS due_date, 'signature' AS kind
       FROM signature_envelopes
       WHERE contact_id = $1 AND status IN ('sent', 'viewed', 'kba_required', 'kba_pending')`,
      [client.contactId]
    );
    return { todos: [...docItems.rows, ...envelopes.rows, ...tasks.rows] };
  });

  // Client checks off a STAFF-ADDED to-do ("mark Q2 estimate paid" style).
  app.post<{ Params: { taskId: string } }>('/portal/todos/:taskId/complete', scoped, async (request) => {
    const client = request.client!;
    const taskId = z.uuid().parse(request.params.taskId);
    // v4.6: blocked tasks cannot complete — from the portal either.
    const res = await app.db.query(
      `UPDATE tasks SET status = 'completed', completed_at = now(), updated_at = now()
       WHERE id = $1 AND contact_id = $2 AND client_visible AND status IN ('not_started', 'in_progress', 'waiting_for_input')
         AND NOT EXISTS (
           SELECT 1 FROM task_dependencies d JOIN tasks bt ON bt.id = d.blocker_task_id
           WHERE d.blocked_task_id = tasks.id AND bt.status NOT IN ('completed', 'cancelled')
         )`,
      [taskId, client.contactId]
    );
    if (res.rowCount === 0) throw new AppError(404, 'not_found', 'To-do not found.');
    await cascadeUnblock(app, taskId);
    await writeAudit(app.db, {
      actorType: 'client', actorId: client.portalUserId, actorLabel: client.displayName,
      action: 'task.client_completed', objectType: 'task', objectId: taskId, contactId: client.contactId,
    });
    return { status: 'ok' };
  });

  /*
   * A PAGE FAILED IN THE CLIENT'S BROWSER (R49, Brian, 2026-09-26).
   *
   * The portal's error boundary (apps/portal/app/error.tsx) posts here when a page throws while
   * rendering. The client saw one sentence and a Reload control and nothing else; the firm gets
   * a task (one open per route, deduped on the route) and an Ops alert pointing at it, the way a
   * blocked sign-in does. The report carries the ROUTE and the browser's error MESSAGE, nothing
   * more: the query string is dropped (a token or an address may ride there), and anything in the
   * message shaped like an address or a run of four or more digits is masked before it is written.
   * Rate-limited per session in memory, five reports per ten minutes, because a page that fails
   * on every render would otherwise report on every reload.
   */
  const ClientErrorBody = z.object({
    route: z.string().min(1).max(200),
    message: z.string().min(1).max(500),
    digest: z.string().max(100).optional(),
  });
  const clientErrorReports = new Map<string, number[]>();
  const CLIENT_ERROR_WINDOW_MS = 10 * 60_000;
  const CLIENT_ERROR_MAX_PER_WINDOW = 5;
  const scrub = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<address>').replace(/\d{4,}/g, '<digits>');
  app.post('/portal/client-errors', scoped, async (request, reply) => {
    const client = request.client!;
    const body = ClientErrorBody.parse(request.body ?? {});
    const now = Date.now();
    const recent = (clientErrorReports.get(client.portalUserId) ?? []).filter((at) => now - at < CLIENT_ERROR_WINDOW_MS);
    if (recent.length >= CLIENT_ERROR_MAX_PER_WINDOW) {
      throw new AppError(429, 'too_many_reports', 'Enough reports from this session for now; the first ones were recorded.');
    }
    recent.push(now);
    clientErrorReports.set(client.portalUserId, recent);

    const route = body.route.replace(/[?#].*$/, '').slice(0, 200) || '/';
    const message = scrub(body.message);
    const digest = body.digest ? scrub(body.digest) : null;
    const recipient = await alertRecipientForRole(app.db, 'ceo', 'portal_page_error');
    const created = await createTask(app, {
      title: `The portal page ${route} failed in a client's browser`,
      description:
        `Route: ${route}\nError: ${message}${digest ? `\nReference: ${digest}` : ''}\n\n` +
        `The client saw one plain sentence and a Reload control, nothing about the error. ` +
        `Reproduce on a copy of production before changing anything; the procedure is on the SOP.`,
      ...(recipient ? { assignedStaffId: recipient } : {}),
      contactId: client.contactId,
      priority: 2,
      source: 'automation',
      sourceType: 'portal_page_error',
      // One open task per route: a page that fails for every client is one defect, not one per client.
      sourceId: route,
    });
    if (recipient) {
      await notifyOnce(app.db, {
        staffId: recipient,
        type: 'portal_page_error',
        severity: 'warning',
        title: `A portal page failed in a client's browser: ${route}`,
        contactId: client.contactId,
        relatedObjectType: 'task',
        relatedObjectId: created.id,
      });
    }
    await writeAudit(app.db, {
      actorType: 'client', actorId: client.portalUserId, actorLabel: client.displayName,
      action: 'portal.client_error', objectType: 'task', objectId: created.id, contactId: client.contactId,
      ip: request.ip,
      details: { route, message, task_created: created.created, alerted: recipient !== null },
    });
    return reply.code(202).send({ status: 'recorded', taskId: created.id, created: created.created });
  });

  app.get('/portal/documents', scoped, async (request) => {
    const client = request.client!;
    const { rows } = await app.db.query(
      // Withdrawn files are gone from the client's view but not from the record —
      // see withdrawDocument(). A client who uploaded the wrong thing should not keep
      // seeing it; an auditor should still be able to.
      // R96: each row says which checklist item it counts as, so an unmatched one can be matched here.
      //
      // R110 (Brian, 2026-09-30): each file names the return it belongs to, so the page can group it:
      // the return it was filed against, or the return whose checklist item it answers. A superseded
      // file (a signed authorization replaced by its correction) is hidden from the client and stays in Ops.
      `SELECT d.id, d.category, d.status, d.filename, d.tax_year, d.uploaded_at, ${(await import('../documents/counts-as.ts')).COUNTS_AS_SQL} AS counts_as,
              rt.id AS return_id, rt.tax_year AS return_year, rt.return_type AS return_type, rb.name AS return_business
       FROM documents d
       LEFT JOIN LATERAL (
         SELECT te.id, te.tax_year, te.return_type::text AS return_type, te.engagement_id
           FROM tax_engagements te
          WHERE te.id = COALESCE(d.tax_engagement_id, (
                  SELECT dr.tax_engagement_id FROM document_request_items ri JOIN document_requests dr ON dr.id = ri.request_id
                   WHERE ri.document_id = d.id AND dr.tax_engagement_id IS NOT NULL ORDER BY ri.id LIMIT 1))
       ) rt ON true
       LEFT JOIN engagements re ON re.id = rt.engagement_id
       LEFT JOIN businesses rb ON rb.id = re.business_id
       WHERE d.contact_id = $1 AND d.archived_at IS NULL AND d.withdrawn_at IS NULL AND d.superseded_by IS NULL
       ORDER BY d.uploaded_at DESC`,
      [client.contactId]
    );
    return { documents: rows };
  });

  /*
   * R96 (Brian, 2026-09-29): the client picks the checklist item a document already on file is for.
   * Scoped to the session contact; someone else's document reads as not found. Audited as the client.
   */
  app.post<{ Params: { id: string } }>('/portal/documents/:id/counts-as', scoped, async (request) => {
    const client = request.client!;
    const id = z.uuid().parse(request.params.id);
    const b = z.object({ itemId: z.uuid() }).parse(request.body);
    const { countDocumentAs } = await import('../documents/counts-as.ts');
    return countDocumentAs(app, { type: 'client', id: client.portalUserId, label: client.displayName, ip: request.ip }, {
      documentId: id, itemId: b.itemId, clientContactId: client.contactId,
    });
  });

  /**
   * Withdraw a file uploaded by mistake (Brian's ruling: withdraw, never delete).
   *
   * Scoped to the session contact, so a client can only withdraw their own — and an
   * unknown id returns the same 404 as someone else's, with no existence oracle.
   */
  app.post<{ Params: { id: string } }>('/portal/documents/:id/withdraw', scoped, async (request) => {
    const client = request.client!;
    const id = z.uuid().parse(request.params.id);
    const body = z.object({ reason: z.string().max(300).optional() }).parse(request.body ?? {});
    const { withdrawDocument } = await import('../documents/service.ts');
    return withdrawDocument(
      app,
      id,
      { type: 'client', id: client.portalUserId, label: client.displayName, ip: request.ip },
      { reason: body.reason, clientContactId: client.contactId }
    );
  });

  // My Returns: delivered final return PDFs (ATX handoff), all years.
  /**
   * The client's own IRS notices (M28, wireframe customer step 8): "you see it's
   * handled — in plain language."
   *
   * The whole notice engine — 48-hour actioning, the escalation ladder, owned
   * tickets — was invisible to the person it is meant to reassure, so the panel's
   * promise ("no more did-you-get-my-letter calls") went unmet.
   *
   * Deliberately NOT exposed: the handler's name, the service tier, internal
   * resolution notes, or the escalation state. A client needs to know we have it,
   * what it is about, and when the response is due. Who is chasing whom inside the
   * firm is ours.
   */
  app.get('/portal/notices', scoped, async (request) => {
    const client = request.client!;
    const { rows } = await app.db.query<{
      id: string; notice_type: string; tax_year: number | null;
      response_deadline: string | null; status: string; received_at: Date | null;
    }>(
      `SELECT id, notice_type, tax_year, response_deadline::text AS response_deadline,
              status::text AS status, received_at
       FROM irs_notices
       WHERE contact_id = $1
       ORDER BY received_at DESC NULLS LAST, created_at DESC
       LIMIT 50`,
      [client.contactId]
    );
    // Internal stages collapse into three client-meaningful states. A client does
    // not need to know the difference between 'under_review' and
    // 'response_drafted' — both mean "we're on it".
    const notices = rows.map((n) => ({
      id: n.id,
      noticeType: n.notice_type,
      taxYear: n.tax_year,
      responseDeadline: n.response_deadline,
      receivedAt: n.received_at,
      clientState:
        n.status === 'resolved'
          ? 'resolved'
          : n.status === 'response_sent'
            ? 'response_sent'
            : 'in_progress',
    }));
    return { notices };
  });

  /*
   * WHAT HAPPENS NEXT (Brian, 2026-09-26, R48). Each delivered return carries the state of the return
   * it belongs to, folded into one key the page turns into a sentence in the client's language. Read
   * from the return record and the R53 "8879 sent" fields; null when the document hangs on no return.
   *
   *   f8879_pending      delivered, the 8879 not yet sent    → "We will send Form 8879 next."
   *   f8879_adobe_sign   sent through Adobe Sign             → "Look for an email from Adobe Sign."
   *   f8879_in_office    to be signed at the visit
   *   f8879_mailed       a paper copy in the mail
   *   f8879_sent         sent, the method not on the record (an import-declared row)
   *   f8879_on_file      the signed 8879 is on file           → "We are filing your return."
   *   filed              filed, acknowledgments pending
   *   accepted           completed (every jurisdiction answered)
   *
   * THE COMPLETED LINE READS PER JURISDICTION (Brian, 2026-09-26, R48): "Accepted by the IRS on
   * <date>. Accepted by Illinois on <date>." or "Mailed to Illinois on <date>." — one line per row the
   * return declared (tax_engagement_jurisdictions), an e-file row by its acceptance date and a paper row
   * by its mailing date. `completed_lines` carries the code, the kind and the calendar day; the portal
   * names the jurisdiction in the reader's language and renders the day through its date helper. A
   * return completed before the jurisdictions table existed (migration 0104) has no declared rows and
   * reads its lines from the summary columns.
   */
  app.get('/portal/returns', scoped, async (request) => {
    const client = request.client!;
    const { rows } = await app.db.query<{
      id: string; filename: string; tax_year: number | null; uploaded_at: Date; tax_engagement_id: string | null;
      stage: string | null; f8879_sent_method: string | null; f8879_sent_on: string | null; f8879_on_file: boolean | null;
      federal_accepted_on: string | null; state_accepted_on: string | null; state_accepted_code: string | null;
    }>(
      `SELECT d.id, d.filename, d.tax_year, d.uploaded_at, d.tax_engagement_id,
              te.stage::text AS stage,
              te.f8879_sent_method::text AS f8879_sent_method,
              te.f8879_sent_on::text AS f8879_sent_on,
              (te.f8879_document_id IS NOT NULL) AS f8879_on_file,
              te.federal_accepted_on::text AS federal_accepted_on,
              te.state_accepted_on::text AS state_accepted_on,
              te.state_accepted_code
         FROM documents d
         LEFT JOIN tax_engagements te ON te.id = d.tax_engagement_id
        WHERE d.contact_id = $1 AND d.category = 'return_deliverable' AND d.archived_at IS NULL
        ORDER BY d.tax_year DESC NULLS LAST, d.uploaded_at DESC`,
      [client.contactId]
    );
    const completedRows = rows.filter((r) => r.stage === 'completed' && r.tax_engagement_id);
    const answers = await answerLinesFor(app, [...new Map(completedRows.map((r) => [r.tax_engagement_id!, { ...r, id: r.tax_engagement_id! }])).values()]);
    const completedLinesFor = (r: typeof rows[number]): AnswerLine[] =>
      r.stage === 'completed' && r.tax_engagement_id ? (answers.get(r.tax_engagement_id) ?? []) : [];
    const nextStepFor = (r: typeof rows[number]): string | null => {
      if (!r.stage || r.stage === 'withdrawn') return null;
      if (r.stage === 'completed') return 'accepted';
      if (r.stage === 'filed') return 'filed';
      if (r.f8879_on_file) return 'f8879_on_file';
      if (r.f8879_sent_on) {
        if (r.f8879_sent_method === 'adobe_sign') return 'f8879_adobe_sign';
        if (r.f8879_sent_method === 'in_office') return 'f8879_in_office';
        if (r.f8879_sent_method === 'mailed') return 'f8879_mailed';
        return 'f8879_sent';
      }
      if (r.stage === 'rejected') return null;
      return 'f8879_pending';
    };
    return {
      returns: rows.map((r) => ({
        id: r.id, filename: r.filename, tax_year: r.tax_year, uploaded_at: r.uploaded_at,
        next_step: nextStepFor(r),
        completed_lines: completedLinesFor(r),
      })),
    };
  });

  // Plain-English engagement status for the dashboard.
  /*
   * EVERY service the client has with us, not just the tax ones (#35).
   *
   * This selected FROM tax_engagements, so it could only ever return work that had a tax
   * row. A bookkeeping or payroll client saw an empty "your services" section — and in
   * production four of six active tax engagements had no tax_engagements row either, so
   * they were invisible to their own clients too.
   *
   * The client-facing name is composed from the service line and the tax year, NOT from
   * `engagements.title`: that column is internal and carries legacy values like "Accepted
   * quote", which is not a thing to show someone about their own business.
   *
   * `kind` separates the two honest shapes of progress. Tax work is a PIPELINE with a
   * finish line, so a stage means something. Bookkeeping and payroll are ONGOING — they
   * have no end state, and drawing a progress bar across a recurring service would invent
   * a completion that does not exist.
   */
  app.get('/portal/engagements', scoped, async (request) => {
    const client = request.client!;
    const { rows } = await app.db.query(
      `SELECT e.id,
              e.service_line::text AS service_line,
              e.status::text       AS status,
              e.title,
              te.tax_year,
              te.return_type,
              te.stage::text       AS stage,
              te.extension_filed,
              COALESCE(te.extended_deadline, te.original_deadline)::text AS deadline,
              CASE WHEN te.id IS NOT NULL THEN 'pipeline' ELSE 'ongoing' END AS kind,
              te.f8879_sent_method::text AS f8879_sent_method,
              te.f8879_sent_on::text     AS f8879_sent_on,
              (te.f8879_document_id IS NOT NULL) AS f8879_on_file,
              te.id AS tax_engagement_id,
              te.federal_accepted_on::text AS federal_accepted_on,
              te.state_accepted_on::text AS state_accepted_on,
              te.state_accepted_code,
              -- R108 (2026-09-30): a withdrawn return is listed as one line, with the day and a reason in
              -- the client's words (never the staff's note). A withdrawn engagement with no return stays out.
              ${WITHDRAWN_ON_SQL} AS withdrawn_on, ${WITHDRAWN_KIND_SQL} AS withdrawn_kind
         FROM engagements e
         LEFT JOIN tax_engagements te ON te.engagement_id = e.id
        WHERE e.contact_id = $1
          AND e.status <> 'draft'
          AND (e.status <> 'withdrawn' OR te.stage = 'withdrawn')
        ORDER BY te.tax_year DESC NULLS LAST, e.service_line, e.created_at`,
      [client.contactId]
    );

    /*
     * #47 — what each service actually covers, in the client's own language.
     *
     * "Impuestos — En marcha" twice was #41: two engagements with nothing to tell them
     * apart. The scope rows are the answer, and they carry both languages because they were
     * snapshotted from a quote the client read in one of them.
     *
     * Engagements created before #47 have no scope and get `null` — the page keeps
     * composing from service line and tax year, which is honest about what is known.
     */
    const { scopeForEngagements, scopeForYear, scopeName } = await import('../engagements/scope.ts');
    const ids = rows.map((r) => String(r.id));
    const scopes = await scopeForEngagements(app, ids);
    const lang = client.language;
    // R84: a filed or completed return says what the IRS and each state answered, never a deadline.
    const filed = rows.filter((r) => r.tax_engagement_id && (r.stage === 'filed' || r.stage === 'completed'));
    const answers = await answerLinesFor(app, filed.map((r) => ({
      id: String(r.tax_engagement_id), federal_accepted_on: r.federal_accepted_on ?? null,
      state_accepted_on: r.state_accepted_on ?? null, state_accepted_code: r.state_accepted_code ?? null,
    })));
    return {
      engagements: rows.map((r) => {
        // R89: one row per return; a multi-year engagement's row reads its own year's lines.
        const all = scopes.get(String(r.id)) ?? [];
        const items = r.tax_engagement_id && r.tax_year ? scopeForYear(all, Number(r.tax_year)) : all;
        const isFiled = r.stage === 'filed' || r.stage === 'completed';
        // R93: a deadline that passed with no filing reads as overdue, never as a bare past date.
        const overdue = r.stage ? overdueSince(r.deadline ?? null, todayChicago(), { stage: String(r.stage) }) : null;
        return {
          ...r,
          deadline: isFiled || overdue || r.stage === 'withdrawn' ? null : r.deadline,
          overdue_since: overdue,
          answer_lines: isFiled ? (answers.get(String(r.tax_engagement_id)) ?? []) : [],
          scopeName: scopeName(items, lang),
          scope: items.map((i) => ({
            itemCode: i.itemCode,
            description: lang === 'es' ? i.descriptionEs || i.descriptionEn : i.descriptionEn,
            quantity: i.quantity,
            isPassThrough: i.isPassThrough,
          })),
        };
      }),
    };
  });

  /*
   * What the client has booked (#35). Upcoming first; a recently-past meeting still
   * shows briefly, because "did I actually book that?" is asked most right after it
   * happens. Cancelled bookings are excluded rather than struck through — a cancelled
   * meeting is not something the client needs to keep looking at.
   */
  app.get('/portal/bookings', scoped, async (request) => {
    const client = request.client!;
    const { rows } = await app.db.query(
      `SELECT id, event_slug, title, starts_at, location
         FROM client_bookings
        WHERE contact_id = $1
          AND cancelled_at IS NULL
          AND (starts_at IS NULL OR starts_at > now() - interval '1 day')
        ORDER BY starts_at NULLS LAST
        LIMIT 10`,
      [client.contactId]
    );
    return { bookings: rows };
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
    const rene = await ownerForRole(app.db, 'comms_billing');
    /*
     * No `sourceId`: a client asking for a second service is a second request, not a duplicate
     * of the first. `createTask()` dedupes on (source_type, source_id), so giving this one a
     * stable id would silently swallow every request after the first — the opposite of the
     * 24-hour promise. Omitting it opts out of dedupe deliberately.
     */
    const task = await createTask(app, {
      title: `Service request (${b.service}) — respond within 24h`,
      description: b.notes ?? null,
      assignedStaffId: rene,
      contactId: client.contactId,
      priority: 1,
      source: 'automation',
      sourceType: 'service_request',
      dueDate: addDays(todayChicago(), 1),
    });
    if (rene) {
      await notifyOnce(app.db, {
        staffId: rene, type: 'service_request', severity: 'info',
        title: `New service request: ${b.service}`,
        contactId: client.contactId, relatedObjectType: 'task', relatedObjectId: task.id,
      });
    }
    await writeAudit(app.db, {
      actorType: 'client', actorId: client.portalUserId, actorLabel: client.displayName,
      action: 'service_request.created', objectType: 'task', objectId: task.id,
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
      actorType: 'client', actorId: client.portalUserId, actorLabel: client.displayName,
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
                'senderType', m.sender_type,
                -- Reference plus immutable text: the body already SAYS what was
                -- attached, so a null id (deleted or refiled document) degrades the
                -- link without leaving a hole in the conversation.
                'documentId', m.document_id,
                'documentFilename', d.filename
              ) ORDER BY m.sent_at) FILTER (WHERE m.id IS NOT NULL), '[]') AS messages
       FROM message_threads t
       LEFT JOIN messages m ON m.thread_id = t.id
       LEFT JOIN documents d ON d.id = m.document_id
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
    // An unfilled role is audited and falls back to the CEO (staffing.ts, 2026-09-12): never a silent skip.
    const rene = await alertRecipientForRole(app.db, 'comms_billing', 'portal_message');
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
