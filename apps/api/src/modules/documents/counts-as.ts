/*
 * "COUNTS AS" — A DOCUMENT ALREADY ON FILE MATCHED TO A CHECKLIST ITEM (Brian, 2026-09-29, R96).
 *
 * A document uploaded to a return before its checklist existed (R91's backfill came after), or under a
 * general category, sits on the record and satisfies nothing. Staff match it from the document row in
 * Ops, and the client from their own Documents page by picking the item it is for. Both go through
 * this one function: the document and the item belong to the same client, the file is not quarantined
 * or withdrawn, the item is a checklist item still pending on a return still being worked; then the
 * item is received with this document (fulfillRequestItem, the same path an upload into the item's
 * slot takes) and one audit row records who matched which document to which item.
 */
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types.ts';
import { writeAudit } from '../../audit.ts';
import { fulfillRequestItem } from './service.ts';

export interface CountsAsActor { type: 'staff' | 'client'; id: string; label: string; ip?: string | null }

export async function countDocumentAs(
  app: FastifyInstance,
  actor: CountsAsActor,
  input: { documentId: string; itemId: string; clientContactId?: string | undefined; canReadCategory?: ((category: string) => boolean) | undefined }
): Promise<{ documentId: string; itemId: string; labelEn: string; labelEs: string | null }> {
  const d = await app.db.query<{ contact_id: string; category: string; scan_status: string; gone: boolean }>(
    `SELECT contact_id, category::text AS category, scan_status::text AS scan_status,
            (archived_at IS NOT NULL OR withdrawn_at IS NOT NULL) AS gone
       FROM documents WHERE id = $1`,
    [input.documentId]
  );
  const doc = d.rows[0];
  // A client asking about someone else's document reads the same answer as an unknown one.
  if (!doc || (input.clientContactId && doc.contact_id !== input.clientContactId)) throw new AppError(404, 'not_found', 'Document not found.');
  if (input.canReadCategory && !input.canReadCategory(doc.category)) {
    throw new AppError(403, 'category_not_allowed', `Your role does not handle '${doc.category}' documents.`);
  }
  if (doc.gone) throw new AppError(409, 'document_not_live', 'This document was withdrawn or archived; it cannot count for anything.');
  if (doc.scan_status === 'infected') throw new AppError(409, 'document_quarantined', 'This file failed the virus scan; it cannot count for a checklist item.');
  const i = await app.db.query<{ contact_id: string; source: string | null; status: string; label_en: string; label_es: string | null; request_id: string; doc_key: string | null; stage: string | null }>(
    `SELECT dr.contact_id, dr.source, i.status::text AS status, i.label_en, i.label_es, dr.id AS request_id,
            i.checklist_doc_key AS doc_key, te.stage::text AS stage
       FROM document_request_items i
       JOIN document_requests dr ON dr.id = i.request_id
       LEFT JOIN tax_engagements te ON te.id = dr.tax_engagement_id
      WHERE i.id = $1`,
    [input.itemId]
  );
  const item = i.rows[0];
  if (!item || item.contact_id !== doc.contact_id) throw new AppError(404, 'item_not_found', 'That checklist item is not this client\'s.');
  if (item.source !== 'checklist') throw new AppError(409, 'not_a_checklist_item', 'Only an item on a return\'s document checklist can be matched this way.');
  if (item.status !== 'pending') throw new AppError(409, 'item_already_received', 'That item is already received or waived.');
  if (item.stage === 'completed' || item.stage === 'withdrawn') throw new AppError(409, 'return_closed', `That return is ${item.stage}; its checklist is closed.`);

  await fulfillRequestItem(app, input.itemId, input.documentId, doc.contact_id);
  await writeAudit(app.db, {
    actorType: actor.type, actorId: actor.id, actorLabel: actor.label,
    action: 'document.counted_as_checklist_item', objectType: 'document', objectId: input.documentId,
    contactId: doc.contact_id, ip: actor.ip ?? null,
    details: { item_id: input.itemId, request_id: item.request_id, doc_key: item.doc_key, label_en: item.label_en, category: doc.category },
  });
  return { documentId: input.documentId, itemId: input.itemId, labelEn: item.label_en, labelEs: item.label_es };
}

/** The client's pending checklist items on returns still being worked, in the order written: what a document can count as. */
export async function openChecklistItemsFor(app: FastifyInstance, contactId: string) {
  const { rows } = await app.db.query<{ id: string; label_en: string; label_es: string | null; tax_year: number; return_type: string }>(
    `SELECT i.id, i.label_en, i.label_es, te.tax_year, te.return_type::text AS return_type
       FROM document_request_items i
       JOIN document_requests dr ON dr.id = i.request_id
       JOIN tax_engagements te ON te.id = dr.tax_engagement_id
      WHERE dr.contact_id = $1 AND dr.source = 'checklist' AND dr.status <> 'cancelled'
        AND i.status = 'pending' AND te.stage NOT IN ('completed', 'withdrawn')
      ORDER BY te.tax_year DESC, i.seq`,
    [contactId]
  );
  return rows;
}

/** SQL for a documents row's matches: the checklist items it counts as, both languages. */
export const COUNTS_AS_SQL = `(SELECT COALESCE(json_agg(json_build_object('itemId', ci.id, 'labelEn', ci.label_en, 'labelEs', ci.label_es) ORDER BY ci.seq), '[]')
   FROM document_request_items ci JOIN document_requests cr ON cr.id = ci.request_id
  WHERE ci.document_id = d.id AND cr.source = 'checklist')`;
