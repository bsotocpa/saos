import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { AppError } from '../../types.ts';
import { createEnvelope, sendEnvelope, templateKeyFor } from './service.ts';

const CreateBody = z.object({
  contactId: z.uuid(),
  type: z.enum(['engagement_letter', 'consent_7216', 'w9', 'grant_agreement', 'other']),
  engagementId: z.uuid().optional(),
  taxEngagementId: z.uuid().optional(),
  serviceLine: z.string().optional(), // picks the engagement-letter variant
});

export function registerSignatureRoutes(app: FastifyInstance): void {
  const manage = { preHandler: [app.authenticate, requirePermission('engagements.tax.manage')] };

  // Create (draft — intake and staff queue these; sending is the gated step).
  app.post('/signature-envelopes', manage, async (request, reply) => {
    const b = CreateBody.parse(request.body);
    const result = await createEnvelope(
      app,
      { type: 'staff', id: request.staff!.id, label: request.staff!.fullName },
      {
        contactId: b.contactId,
        type: b.type,
        engagementId: b.engagementId,
        taxEngagementId: b.taxEngagementId,
        templateKey: templateKeyFor(b.type, b.serviceLine ?? null),
      }
    );
    return reply.code(201).send(result);
  });

  // RETIRED (2026-09-12, ruling 3b): no e-sign vendor. Answers 410 naming where signatures happen now.
  app.post<{ Params: { id: string } }>('/signature-envelopes/:id/send', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    await sendEnvelope(app, id);
  });

  app.get('/signature-envelopes', manage, async (request) => {
    const q = z.object({ contactId: z.uuid().optional(), status: z.string().optional() }).parse(request.query);
    const clauses: string[] = ['true'];
    const params: unknown[] = [];
    if (q.contactId) { params.push(q.contactId); clauses.push(`se.contact_id = $${params.length}`); }
    if (q.status) { params.push(q.status); clauses.push(`se.status = $${params.length}::envelope_status`); }
    const { rows } = await app.db.query(
      `SELECT se.id, se.type, se.status, se.signature_method, se.template_key, se.sent_at, se.completed_at,
              se.signed_document_id, c.id AS contact_id, c.first_name, c.last_name
       FROM signature_envelopes se JOIN contacts c ON c.id = se.contact_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY se.created_at DESC LIMIT 200`,
      params
    );
    return { envelopes: rows };
  });

  // Remote 8879: KBA first, Docuseal only after a pass (MP compliance flow).
  /*
   * RETIRED (2026-09-12, Brian's ruling). The remote 8879 e-sign path — KBA vendor, Docuseal
   * template — never existed as anything but a route: no vendor was ever selected and no 8879
   * template exists in Docuseal. Form 8879 is wet-signed in office, scanned, and uploaded to the
   * return under Signed Authorizations (POST /documents with signedOn + preparerPtinHolderId).
   * That upload is the authorization. The routes below answer 410 so a stale client is told why.
   */
  app.post<{ Params: { id: string } }>('/tax-engagements/:id/signatures/remote-8879', manage, async () => {
    throw new AppError(410, 'remote_8879_retired', 'The remote 8879 path is retired. Upload the wet-signed, scanned 8879 to the return under Signed Authorizations.');
  });
  app.post<{ Params: { kbaId: string } }>('/kba/:kbaId/simulate', manage, async () => {
    throw new AppError(410, 'remote_8879_retired', 'KBA is retired with the remote 8879 path.');
  });
  // The vendor completion webhook (POST /webhooks/docuseal) is gone with the vendor (2026-09-12).

  /*
   * Portal: the client's "Sign Documents" list — scoped to the session contact.
   *
   * R46 (Brian, 2026-09-26): documents of withdrawn engagements never show. The list used to return
   * every envelope of the contact with no look at the engagement it hangs on, so the engagement
   * letters queued for two withdrawn 1040s sat under "Waiting for your signature" beside the signed
   * packet. An envelope on a withdrawn engagement (or a withdrawn return) is left out; one on no
   * engagement (a §7216 consent from intake) stays. Each row now names what it belongs to — the
   * business, or the return's type and year — so two envelopes of one type can be told apart, and
   * two of one type on one engagement can be folded into one row by the page.
   */
  app.get('/portal/signature-envelopes', { preHandler: [app.authenticateClient] }, async (request) => {
    const client = request.client!;
    const { rows } = await app.db.query(
      /*
       * R88 (2026-09-27): a wet-signed 8879 is signed on a CALENDAR DAY. The upload stores that day as
       * midnight UTC in completed_at, and the portal formatted the instant in the reader's zone, so
       * Chicago read "Sep 19" for a day recorded as 2026-09-20. signed_on carries the day itself.
       */
      `SELECT se.id, se.type, se.status, se.sent_at, se.completed_at, se.signed_document_id,
              CASE WHEN se.type = 'f8879' AND se.completed_at IS NOT NULL
                   THEN to_char(se.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') END AS signed_on,
              se.engagement_id, se.tax_engagement_id, e.service_line::text AS service_line,
              te.tax_year, te.return_type::text AS return_type, b.name AS business_name
         FROM signature_envelopes se
         LEFT JOIN engagements e ON e.id = se.engagement_id
         -- R89: an envelope for the whole engagement (no return named) reads the engagement's newest open return.
         LEFT JOIN tax_engagements te ON te.id = COALESCE(se.tax_engagement_id, (SELECT t2.id FROM tax_engagements t2 WHERE t2.engagement_id = e.id ORDER BY (t2.stage = 'withdrawn'), t2.tax_year DESC LIMIT 1))
         LEFT JOIN businesses b ON b.id = e.business_id
        WHERE se.contact_id = $1 AND se.status NOT IN ('voided', 'declined')
          -- R87: a §7216 consent is answered on /consent and read from its own state (GET /portal/consents);
          -- the intake envelope that once stood for it is not a second, disagreeing row.
          AND se.type <> 'consent_7216'
          AND (e.id IS NULL OR e.status <> 'withdrawn')
          AND (te.id IS NULL OR te.stage <> 'withdrawn')
        ORDER BY se.created_at DESC`,
      [client.contactId]
    );
    return { envelopes: rows };
  });
}
