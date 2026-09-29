/**
 * THE DOCUMENT CHECKLIST FROM THE QUOTED LINES (Brian, 2026-09-27, R83).
 *
 *   openChecklistRequest   acceptance of a tax quote: the return's one checklist request, built from
 *                          its lines against document_checklist_items (Admin -> Document checklist).
 *                          Two lines asking for the same doc_key ask once. No email: the portal shows
 *                          it, and staff decide when to ask with "Request documents".
 *   checklistCounts        received / missing per return, for the Ops return row.
 *   sendChecklistRequest   "Request documents": the missing items, emailed through the
 *                          document_checklist_request automation (seeded off; a held send is one
 *                          counted *_suppressed row). The stage moves either way; this never moves it.
 *
 * The request and its items are the document_requests tables every other request uses, so the
 * portal's upload slot, the "This fulfills" link, withdraw, the rescan hold and the done-rollup
 * (docs_received_at) all apply unchanged.
 */
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { isAutomationEnabled } from '../../automations.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { AppError } from '../../types.ts';

/** "1120s" → "1120-S", "990ez" → "990-EZ", "w7_itin" → "W-7": the form number a client reads. */
export function formNumber(returnType: string): string {
  if (returnType === 'w7_itin') return 'W-7';
  if (returnType === 'fbar') return 'FBAR';
  const base = returnType.replace(/_.*$/, '');
  const m = /^([a-z]*)(\d+)([a-z]*)$/.exec(base);
  if (!m) return returnType.toUpperCase();
  return `${m[1]!.toUpperCase()}${m[2]}${m[3] ? `-${m[3].toUpperCase()}` : ''}`;
}

/**
 * The return's checklist, opened at acceptance inside the acceptance transaction. Returns the
 * request id, or null when none of the lines asks for a document (or the return already has one).
 */
export async function openChecklistRequest(
  app: FastifyInstance,
  input: { taxEngagementId: string; engagementId: string; contactId: string; itemCodes: readonly string[]; taxYear: number; returnType: string }
): Promise<{ requestId: string; items: number } | null> {
  const docs = await app.db.query<{ doc_key: string; label_en: string; label_es: string; line_pos: number; sort_order: number }>(
    `SELECT DISTINCT ON (doc_key) doc_key, label_en, label_es,
            array_position($1::text[], item_code) AS line_pos, sort_order
       FROM document_checklist_items
      WHERE item_code = ANY($1::text[]) AND active
      ORDER BY doc_key, array_position($1::text[], item_code), sort_order`,
    [input.itemCodes]
  );
  if (docs.rows.length === 0) return null;
  // The client reads them in the order of the quote's lines, each line's rows in their own order.
  const ordered = [...docs.rows].sort((a, b) => a.line_pos - b.line_pos || a.sort_order - b.sort_order || a.doc_key.localeCompare(b.doc_key));
  const form = formNumber(input.returnType);
  const created = await app.db.query<{ id: string }>(
    `INSERT INTO document_requests (contact_id, engagement_id, tax_engagement_id, source, title_en, title_es)
     VALUES ($1, $2, $3, 'checklist', $4, $5)
     ON CONFLICT (tax_engagement_id) WHERE source = 'checklist' DO NOTHING
     RETURNING id`,
    [
      input.contactId, input.engagementId, input.taxEngagementId,
      `Documents for your ${input.taxYear} Form ${form}`,
      `Documentos para su Formulario ${form} de ${input.taxYear}`,
    ]
  );
  const requestId = created.rows[0]?.id;
  if (!requestId) return null;
  for (const d of ordered) {
    await app.db.query(
      `INSERT INTO document_request_items (request_id, label_en, label_es, checklist_doc_key) VALUES ($1, $2, $3, $4)`,
      [requestId, d.label_en, d.label_es, d.doc_key]
    );
  }
  await writeAudit(app.db, {
    actorType: 'system',
    action: 'document_request.checklist_opened',
    objectType: 'tax_engagement',
    objectId: input.taxEngagementId,
    contactId: input.contactId,
    details: { request_id: requestId, items: ordered.length, doc_keys: ordered.map((d) => d.doc_key) },
  });
  return { requestId, items: ordered.length };
}

export interface ChecklistCount { received: number; missing: number; waived: number; total: number }

/** Received / missing / waived per return, for the returns that have a checklist. */
export async function checklistCounts(app: FastifyInstance, taxEngagementIds: readonly string[]): Promise<Map<string, ChecklistCount>> {
  const out = new Map<string, ChecklistCount>();
  if (taxEngagementIds.length === 0) return out;
  const { rows } = await app.db.query<{ tax_engagement_id: string; received: number; missing: number; waived: number; total: number }>(
    `SELECT dr.tax_engagement_id,
            count(*) FILTER (WHERE i.status = 'received')::int AS received,
            count(*) FILTER (WHERE i.status = 'pending')::int  AS missing,
            count(*) FILTER (WHERE i.status = 'waived')::int   AS waived,
            count(*)::int AS total
       FROM document_requests dr
       JOIN document_request_items i ON i.request_id = dr.id
      WHERE dr.source = 'checklist' AND dr.status <> 'cancelled' AND dr.tax_engagement_id = ANY($1::uuid[])
      GROUP BY dr.tax_engagement_id`,
    [taxEngagementIds]
  );
  for (const r of rows) out.set(r.tax_engagement_id, { received: r.received, missing: r.missing, waived: r.waived, total: r.total });
  return out;
}

export type ChecklistRequestOutcome =
  | { emailed: true; missing: number }
  | { emailed: false; reason: 'automation_off' | 'no_email' | 'nothing_missing' | 'no_checklist'; missing: number };

/**
 * "REQUEST DOCUMENTS" (R83): the missing items on the return's checklist, emailed in the client's
 * language through document_checklist_request. Seeded off: while off the send is held and counted
 * (one *_suppressed row, which Admin -> Automations counts), and nothing else changes.
 */
export async function sendChecklistRequest(
  app: FastifyInstance,
  actor: { staffId: string | null },
  taxEngagementId: string
): Promise<ChecklistRequestOutcome> {
  const { rows } = await app.db.query<{
    request_id: string; contact_id: string; first_name: string; email: string | null; language: 'en' | 'es';
    tax_year: number; return_type: string;
  }>(
    `SELECT dr.id AS request_id, c.id AS contact_id, c.first_name, c.email, c.language, te.tax_year, te.return_type::text AS return_type
       FROM document_requests dr
       JOIN tax_engagements te ON te.id = dr.tax_engagement_id
       JOIN contacts c ON c.id = dr.contact_id
      WHERE dr.tax_engagement_id = $1 AND dr.source = 'checklist' AND dr.status <> 'cancelled'`,
    [taxEngagementId]
  );
  const r = rows[0];
  if (!r) return { emailed: false, reason: 'no_checklist', missing: 0 };
  const items = await app.db.query<{ label_en: string; label_es: string | null }>(
    `SELECT label_en, label_es FROM document_request_items WHERE request_id = $1 AND status = 'pending' ORDER BY seq`,
    [r.request_id]
  );
  const missing = items.rows.length;
  if (missing === 0) return { emailed: false, reason: 'nothing_missing', missing };
  if (!r.email) return { emailed: false, reason: 'no_email', missing };
  if (!(await isAutomationEnabled(app, 'document_checklist_request'))) {
    await writeAudit(app.db, {
      actorType: 'system',
      action: 'document_request.checklist_request_suppressed',
      objectType: 'tax_engagement',
      objectId: taxEngagementId,
      contactId: r.contact_id,
      details: { automation: 'document_checklist_request', reason: 'automation_off', missing, requested_by: actor.staffId },
    });
    return { emailed: false, reason: 'automation_off', missing };
  }
  const es = r.language === 'es';
  const form = formNumber(r.return_type);
  await sendTemplatedEmail(app, {
    to: r.email,
    templateKey: 'doc_checklist_request',
    language: r.language,
    contactId: r.contact_id,
    vars: {
      first_name: r.first_name,
      tax_year: String(r.tax_year),
      return_name: es ? `declaración (Formulario ${form})` : `return (Form ${form})`,
      items_list: items.rows.map((i) => `• ${(es ? i.label_es : null) ?? i.label_en}`).join('\n'),
      portal_link: app.config.PORTAL_BASE_URL,
    },
  });
  await app.db.query(
    `UPDATE document_requests SET last_reminder_at = now(), reminder_count = reminder_count + 1, updated_at = now() WHERE id = $1`,
    [r.request_id]
  );
  return { emailed: true, missing };
}

export const BACKFILL_NOTE = 'Checklist added after the fact from the accepted quote.';

/**
 * THE CHECKLIST BACKFILL (Brian, 2026-09-29, R91). A return opened from a quote accepted before
 * migration 0132 has no checklist; this door gives it one from the lines the client accepted (its
 * engagement's scope snapshot, in the quote's order), audited in the ruled words. Refused for a
 * return that is completed or withdrawn, one that already has its checklist, and one with no quoted
 * lines (opened by hand: there is nothing to build a checklist from).
 */
export async function backfillChecklist(
  app: FastifyInstance,
  actor: { id: string; fullName: string },
  taxEngagementId: string
): Promise<{ requestId: string; items: number }> {
  const { rows } = await app.db.query<{ engagement_id: string; contact_id: string; stage: string; tax_year: number; return_type: string }>(
    `SELECT te.engagement_id, e.contact_id, te.stage::text AS stage, te.tax_year, te.return_type::text AS return_type
       FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id WHERE te.id = $1`,
    [taxEngagementId]
  );
  const te = rows[0];
  if (!te) throw new AppError(404, 'not_found', 'Tax engagement not found.');
  if (te.stage === 'completed' || te.stage === 'withdrawn') {
    throw new AppError(409, 'return_closed', `This return is ${te.stage}; a checklist is for a return still being worked.`);
  }
  const has = await app.db.query(`SELECT 1 FROM document_requests WHERE tax_engagement_id = $1 AND source = 'checklist'`, [taxEngagementId]);
  if (has.rows.length > 0) throw new AppError(409, 'checklist_exists', 'This return already has its document checklist.');
  const lines = await app.db.query<{ item_code: string }>(
    `SELECT item_code FROM engagement_scope_items
      WHERE engagement_id = $1 AND source_quote_id IS NOT NULL AND item_code IS NOT NULL
        AND (tax_year IS NULL OR tax_year = $2)
      ORDER BY sort_order, item_code`,
    // R89: this return's own year's lines (a row with no year is the engagement's one return's).
    [te.engagement_id, te.tax_year]
  );
  if (lines.rows.length === 0) {
    throw new AppError(409, 'no_quoted_lines', 'This return was not opened from an accepted quote, so there are no quoted lines to build a checklist from.');
  }
  const opened = await openChecklistRequest(app, {
    taxEngagementId, engagementId: te.engagement_id, contactId: te.contact_id,
    itemCodes: lines.rows.map((l) => l.item_code), taxYear: te.tax_year, returnType: te.return_type,
  });
  if (!opened) throw new AppError(409, 'no_checklist_items', 'None of the quoted lines asks for a document (Admin -> Document checklist).');
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
    action: 'document_request.checklist_backfilled',
    objectType: 'tax_engagement', objectId: taxEngagementId, contactId: te.contact_id,
    details: { note: BACKFILL_NOTE, request_id: opened.requestId, items: opened.items },
  });
  return opened;
}
