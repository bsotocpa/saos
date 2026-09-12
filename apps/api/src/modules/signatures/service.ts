// Signature envelope lifecycle (MP E-Signature Module).
//
// GATES (all enforced here, in code):
//  1. PLACEHOLDER: an envelope whose template is flagged is UNSENDABLE in any
//     environment — same non-negotiable as templated email (M5).
//  2. KBA: a remote 8879 envelope cannot reach Docuseal until its KBA
//     verification is PASSED (IRS Pub 1345). Wet path bypasses KBA by design.
//  3. Production refuses the stub Docuseal adapter at send time.
//
// Completion (webhook) is what feeds the M7 pipeline gates: engagement-letter
// completion sets engagement_letter_signed_at; 8879 completion sets
// f8879_signed_at (+ method); §7216 completion records the consent (M6).

import type { FastifyInstance } from 'fastify';
import type { Client as MinioClient } from 'minio';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { record7216Consent } from '../compliance/consent.ts';
import { uploadDocument } from '../documents/service.ts';
import type { DocusealAdapter } from './docuseal.ts';

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

/** Send an envelope to Docuseal — ALL THREE GATES live here. */
export async function sendEnvelope(
  app: FastifyInstance,
  docuseal: DocusealAdapter,
  actor: { type: 'staff' | 'system'; id?: string | null; label?: string | null },
  envelopeId: string
): Promise<{ submissionId: string }> {
  const env = await loadEnvelope(app, envelopeId);
  // kba_required/kba_pending fall through so the KBA gate below answers with
  // the precise reason instead of a generic status error.
  if (!['draft', 'kba_required', 'kba_pending'].includes(env.status)) {
    throw new AppError(409, 'invalid_envelope_status', `Envelope is '${env.status}' — cannot send.`);
  }
  if (!env.recipient_email) {
    throw new AppError(400, 'recipient_missing', 'Contact has no email address for signing.');
  }

  // GATE 1 — PLACEHOLDER (CLAUDE.md non-negotiable): flagged template copy
  // can never reach a client, in any environment.
  if (env.template_key) {
    const t = await app.db.query<{ is_placeholder: boolean }>(
      `SELECT is_placeholder FROM templates WHERE key = $1`,
      [env.template_key]
    );
    if (!t.rows[0]) throw new AppError(500, 'template_missing', `Template '${env.template_key}' not found.`);
    if (t.rows[0].is_placeholder) {
      throw new AppError(
        409,
        'template_placeholder_blocked',
        `Template '${env.template_key}' is flagged PLACEHOLDER and cannot be sent. Brian supplies final legal text in admin first.`
      );
    }
  }

  // The remote 8879 path is retired (2026-09-12): an f8879 envelope is never sent from here.
  if (env.type === 'f8879') {
    throw new AppError(410, 'remote_8879_retired', 'Form 8879 is wet-signed and uploaded to the return; it is not sent for e-signature.');
  }

  // GATE 3 — production never pretends to send.
  if (app.config.NODE_ENV === 'production' && docuseal.mode === 'stub') {
    throw new AppError(503, 'docuseal_not_configured', 'Docuseal is not configured (DOCUSEAL_MODE=stub in production).');
  }

  const { submissionId } = await docuseal.createSubmission({
    docusealTemplateId: env.docuseal_template_id,
    envelopeId: env.id,
    recipientEmail: env.recipient_email,
    recipientName: `${env.first_name} ${env.last_name}`,
  });
  await app.db.query(
    `UPDATE signature_envelopes SET status = 'sent', docuseal_submission_id = $2, sent_at = now() WHERE id = $1`,
    [envelopeId, submissionId]
  );
  await writeAudit(app.db, {
    actorType: actor.type, actorId: actor.id ?? null, actorLabel: actor.label ?? null,
    action: 'signature.envelope_sent', objectType: 'signature_envelope', objectId: envelopeId,
    contactId: env.contact_id, details: { type: env.type, docuseal_mode: docuseal.mode },
  });
  return { submissionId };
}

/** Start the remote 8879 path: envelope + KBA session (nothing goes to Docuseal yet). */
export async function sendPacketEnvelope(
  app: FastifyInstance,
  docuseal: DocusealAdapter,
  actor: { type: 'staff' | 'system'; id?: string | null; label?: string | null },
  packetId: string,
  envelopeId: string,
  language: 'en' | 'es' = 'en'
): Promise<{
  result: { submissionId: string };
  sections: Array<{ kind: string; code: string | null; templateKey: string; templateVersion: number }>;
  excludedConsents: string[];
}> {
  const env = await loadEnvelope(app, envelopeId);
  if (!['draft', 'kba_required', 'kba_pending'].includes(env.status)) {
    throw new AppError(409, 'invalid_envelope_status', `Envelope is '${env.status}' — cannot send.`);
  }
  if (!env.recipient_email) {
    throw new AppError(400, 'recipient_missing', 'Contact has no email address for signing.');
  }
  if (env.docuseal_template_id) {
    throw new AppError(
      500,
      'packet_envelope_templated',
      'This packet envelope carries a Docuseal template id. A packet is generated per client — the static all-in-one template bundled schedules the client had not engaged and both §7216 consents.'
    );
  }
  if (app.config.NODE_ENV === 'production' && docuseal.mode === 'stub') {
    throw new AppError(503, 'docuseal_not_configured', 'Docuseal is not configured (DOCUSEAL_MODE=stub in production).');
  }

  // Building the document applies the placeholder gate to every schedule in it and
  // refuses if a §7216 consent ever reaches the signing document.
  const { buildPacketDocument } = await import('../engagements/packet-document.ts');
  const doc = await buildPacketDocument(app, packetId, language);

  const sent = await docuseal.createSubmissionFromHtml({
    html: doc.html,
    documentName: `Engagement packet ${packetId}`,
    envelopeId,
    recipientEmail: env.recipient_email,
    recipientName: `${env.first_name} ${env.last_name}`,
  });

  await app.db.query(
    `UPDATE signature_envelopes SET status = 'sent', docuseal_submission_id = $2, sent_at = now() WHERE id = $1`,
    [envelopeId, sent.submissionId]
  );
  await writeAudit(app.db, {
    actorType: actor.type, actorId: actor.id ?? null, actorLabel: actor.label ?? null,
    action: 'packet.sent', objectType: 'signature_envelope', objectId: envelopeId,
    contactId: env.contact_id,
    details: {
      packet_id: packetId,
      // WHAT the client was asked to sign, recorded per section with its version.
      sections: doc.sections.map((s) => ({ kind: s.kind, code: s.code, key: s.templateKey, version: s.templateVersion })),
      excluded_consents: doc.deliberatelyExcluded.map((e) => e.templateKey),
      docuseal_mode: docuseal.mode,
      generated_template_id: sent.generatedTemplateId,
    },
  });

  return {
    result: { submissionId: sent.submissionId },
    sections: doc.sections.map((s) => ({
      kind: s.kind, code: s.code, templateKey: s.templateKey, templateVersion: s.templateVersion,
    })),
    excludedConsents: doc.deliberatelyExcluded.map((e) => e.templateKey),
  };
}

/** Docuseal completion: store the signed PDF, link everything, feed the M7 gates. */
export async function completeEnvelopeBySubmission(
  app: FastifyInstance,
  docuseal: DocusealAdapter,
  minio: MinioClient,
  submissionId: string
): Promise<{ envelopeId: string } | null> {
  const { rows } = await app.db.query<EnvelopeRow>(
    `SELECT se.id, se.contact_id, se.engagement_id, se.tax_engagement_id, se.type, se.status,
            se.template_key, se.docuseal_template_id, se.signature_method, se.recipient_email,
            c.first_name, c.last_name
     FROM signature_envelopes se JOIN contacts c ON c.id = se.contact_id
     WHERE se.docuseal_submission_id = $1`,
    [submissionId]
  );
  const env = rows[0];
  if (!env) return null; // unknown submission — acknowledge, don't error (webhook retries)
  if (env.status === 'completed') return { envelopeId: env.id }; // idempotent

  const signed = await docuseal.fetchSignedDocument(submissionId);
  const doc = await uploadDocument(app, minio, { type: 'system', label: 'docuseal webhook' }, {
    contactId: env.contact_id,
    category: 'signed_authorizations',
    filename: signed.filename,
    mimeType: 'application/pdf',
    buffer: signed.buffer,
    taxEngagementId: env.tax_engagement_id ?? undefined,
  });

  await app.db.query(
    `UPDATE signature_envelopes SET status = 'completed', completed_at = now(), signed_document_id = $2 WHERE id = $1`,
    [env.id, doc.id]
  );

  // Feed the compliance gates.
  if (env.type === 'engagement_letter') {
    if (env.tax_engagement_id) {
      await app.db.query(
        `UPDATE tax_engagements SET engagement_letter_signed_at = COALESCE(engagement_letter_signed_at, now()) WHERE id = $1`,
        [env.tax_engagement_id]
      );
    }
    await app.db.query(`UPDATE contacts SET engagement_letter_status = 'signed' WHERE id = $1`, [env.contact_id]);

    // v3: if this envelope carried a Master packet, ONE signature just accepted
    // the Master AND every schedule attached to it. Record each acceptance.
    const packet = await app.db.query<{ id: string }>(
      `SELECT id FROM engagement_packets WHERE envelope_id = $1 AND status <> 'signed'`,
      [env.id]
    );
    if (packet.rows[0]) {
      const { recordMasterSignature } = await import('../engagements/packet.ts');
      await recordMasterSignature(app, packet.rows[0].id, { method: 'docuseal' });
    }

    // v4.3 flow 4 GATE: late fees are only ever applied to clients whose
    /*
     * SIGNED letter carries the late-fee disclosure. Stamp it here — the fee job reads
     * this stamp and nothing else (CLAUDE.md hard rule).
     *
     * The RATE is stamped with it (finding #25). Templates are versioned by mutation, so
     * the text signed in March cannot be recovered from the table in June; copying the
     * disclosed rate at signature is what lets the assessment cap a charge at what THIS
     * client actually agreed to, and stops a later edit to the Master raising it for
     * people who signed the old one.
     */
    if (env.template_key) {
      await app.db.query(
        `UPDATE contacts c
            SET late_fee_disclosure_signed_at = COALESCE(c.late_fee_disclosure_signed_at, now()),
                late_fee_disclosed_rate_percent =
                  COALESCE(c.late_fee_disclosed_rate_percent, t.late_fee_rate_percent)
           FROM templates t
          WHERE c.id = $1 AND t.key = $2 AND t.has_late_fee_disclosure`,
        [env.contact_id, env.template_key]
      );
    }
  } else if (env.type === 'consent_7216') {
    await record7216Consent(app, {
      contactId: env.contact_id,
      type: '7216_use',
      method: 'docuseal',
      documentId: doc.id,
      envelopeId: env.id,
    });
  } else if (env.type === 'f8821') {
    // v4.6: transcripts are now authorized — the request task appears itself.
    const { onF8821Signed } = await import('../tax/resolution-case.ts');
    await onF8821Signed(app, env.id);
  } else if (env.type === 'f8879') {
    // Single OR bundled (entity group): stamp EVERY engagement the envelope
    // covers — the direct link plus signature_envelope_items.
    const items = await app.db.query<{ tax_engagement_id: string }>(
      `SELECT tax_engagement_id FROM signature_envelope_items WHERE envelope_id = $1`,
      [env.id]
    );
    const ids = [
      ...(env.tax_engagement_id ? [env.tax_engagement_id] : []),
      ...items.rows.map((r) => r.tax_engagement_id),
    ];
    if (ids.length > 0) {
      await app.db.query(
        `UPDATE tax_engagements
         SET f8879_signed_at = COALESCE(f8879_signed_at, now()),
             f8879_signature_method = COALESCE(f8879_signature_method, $2::signature_method)
         WHERE id = ANY($1::uuid[])`,
        [ids, env.signature_method ?? 'remote_kba']
      );
    }
  }

  await writeAudit(app.db, {
    actorType: 'system',
    action: 'signature.completed',
    objectType: 'signature_envelope',
    objectId: env.id,
    contactId: env.contact_id,
    details: { type: env.type, signed_document_id: doc.id, method: env.signature_method },
  });
  return { envelopeId: env.id };
}
