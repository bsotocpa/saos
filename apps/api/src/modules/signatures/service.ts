// Signature envelope records (MP E-Signature Module), after the vendor.
//
// THE E-SIGN VENDOR IS RETIRED (2026-09-12, Brian's ruling 3b). Docuseal was the only vendor,
// its token was refused, and nothing called it: the Master and its schedules are signed and
// accepted in the portal (engagements/portal-signature.ts, packet.ts), §7216 consents are
// recorded from the portal (compliance/consent-presentation.ts), and Form 8879 is a wet-signed
// upload (tax/signed-8879.ts). An envelope row is still the record of what was asked and what
// came back; SENDING one answers 410, and there is no completion webhook.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';

export type EnvelopeType =
  | 'engagement_letter' | 'consent_7216' | 'f8879' | 'w9' | 'grant_agreement'
  | 'f8821' | 'f2848'   // v4.6 resolution lane: transcripts vs representation
  | 'other';

/**
 * DB template key per envelope type.
 *
 * v3 (Master + Schedules) collapsed the five per-service-line engagement letters
 * into ONE Master Engagement Agreement. The service line no longer selects the
 * letter — it selects which SCHEDULES ride along in the packet (see
 * modules/engagements/packet.ts). So every engagement-letter envelope points at
 * the Master, which is also what carries the late-fee disclosure the fee job
 * reads. `serviceLine` is kept in the signature for callers that still pass it.
 */
export function templateKeyFor(type: EnvelopeType, _serviceLine?: string | null): string | null {
  switch (type) {
    case 'engagement_letter':
      return 'engagement_master';
    case 'consent_7216':
      return 'consent_7216_use';
    default:
      return null; // f8879 is a wet-signed upload (2026-09-12); W9/others have no DB template
  }
}

interface EnvelopeRow {
  id: string;
  contact_id: string;
  engagement_id: string | null;
  tax_engagement_id: string | null;
  type: EnvelopeType;
  status: string;
  template_key: string | null;
  docuseal_template_id: string | null;
  signature_method: string | null;
  recipient_email: string | null;
  first_name: string;
  last_name: string;
}

async function loadEnvelope(app: FastifyInstance, id: string): Promise<EnvelopeRow> {
  const { rows } = await app.db.query<EnvelopeRow>(
    `SELECT se.id, se.contact_id, se.engagement_id, se.tax_engagement_id, se.type, se.status,
            se.template_key, se.docuseal_template_id, se.signature_method, se.recipient_email,
            c.first_name, c.last_name
     FROM signature_envelopes se JOIN contacts c ON c.id = se.contact_id
     WHERE se.id = $1`,
    [id]
  );
  if (!rows[0]) throw new AppError(404, 'not_found', 'Signature envelope not found.');
  return rows[0];
}

/** Create an envelope in draft (always allowed — intake QUEUES these; sending is gated). */
export async function createEnvelope(
  app: FastifyInstance,
  actor: { type: 'staff' | 'system'; id?: string | null; label?: string | null },
  input: {
    contactId: string;
    type: EnvelopeType;
    engagementId?: string | undefined;
    taxEngagementId?: string | undefined;
    templateKey?: string | null | undefined;
    docusealTemplateId?: string | undefined;
    signatureMethod?: 'remote_kba' | 'in_person_wet' | undefined;
    status?: 'draft' | 'kba_required' | undefined;
  }
): Promise<{ id: string }> {
  const contact = await app.db.query<{ email: string | null }>(`SELECT email FROM contacts WHERE id = $1`, [
    input.contactId,
  ]);
  if (!contact.rows[0]) throw new AppError(404, 'not_found', 'Contact not found.');

  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO signature_envelopes
       (contact_id, engagement_id, tax_engagement_id, type, status, template_key,
        docuseal_template_id, recipient_email, signature_method, created_by_staff_id)
     VALUES ($1,$2,$3,$4::envelope_type,$5::envelope_status,$6,$7,$8,$9::signature_method,$10)
     RETURNING id`,
    [
      input.contactId, input.engagementId ?? null, input.taxEngagementId ?? null, input.type,
      input.status ?? 'draft', input.templateKey ?? null, input.docusealTemplateId ?? null,
      contact.rows[0].email, input.signatureMethod ?? null,
      actor.type === 'staff' ? actor.id : null,
    ]
  );
  const id = rows[0]!.id;
  await writeAudit(app.db, {
    actorType: actor.type, actorId: actor.id ?? null, actorLabel: actor.label ?? null,
    action: 'signature.envelope_created', objectType: 'signature_envelope', objectId: id,
    contactId: input.contactId, details: { type: input.type },
  });
  return { id };
}

/**
 * Sending an envelope to a vendor is retired (2026-09-12). The envelope must exist (404
 * otherwise); then the answer is the same for every type, so a stale client is told why and
 * where the signature actually happens now.
 */
export async function sendEnvelope(app: FastifyInstance, envelopeId: string): Promise<never> {
  const env = await loadEnvelope(app, envelopeId);
  throw new AppError(
    410,
    'esign_vendor_retired',
    env.type === 'f8879'
      ? 'Form 8879 is wet-signed and uploaded to the return under Signed Authorizations; it is not sent for e-signature.'
      : 'The e-signature vendor is retired. The Master and its schedules are signed in the client portal; §7216 consents are recorded there; other forms are wet-signed and uploaded.'
  );
}
