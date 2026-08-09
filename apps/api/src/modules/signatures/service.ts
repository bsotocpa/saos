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
import { makeKbaVerifier, assertKbaUsable } from './kba.ts';

export type EnvelopeType = 'engagement_letter' | 'consent_7216' | 'f8879' | 'w9' | 'grant_agreement' | 'other';

/** DB template key per envelope type (engagement letters are per service line). */
export function templateKeyFor(type: EnvelopeType, serviceLine?: string | null): string | null {
  switch (type) {
    case 'engagement_letter':
      return `engagement_letter_${serviceLine ?? 'tax'}`;
    case 'consent_7216':
      return 'consent_7216_use';
    default:
      return null; // f8879/W9: IRS forms living in Docuseal, not DB copy
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

  // GATE 2 — remote 8879 requires a PASSED KBA (IRS Pub 1345).
  if (env.type === 'f8879' && env.signature_method === 'remote_kba') {
    const kba = await app.db.query<{ status: string }>(
      `SELECT status FROM kba_verifications WHERE envelope_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [envelopeId]
    );
    if (kba.rows[0]?.status !== 'passed') {
      throw new AppError(
        409,
        'kba_required',
        'Blocked: knowledge-based authentication has not passed for this signer. Remote 8879 signatures require KBA before the envelope is sent.'
      );
    }
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
export async function startRemote8879(
  app: FastifyInstance,
  actor: { id: string; label: string },
  taxEngagementId: string
): Promise<{ envelopeId: string; kbaId: string; vendor: string }> {
  assertKbaUsable(app.config);
  const { rows } = await app.db.query<{ contact_id: string; email: string | null; first_name: string; last_name: string }>(
    `SELECT c.id AS contact_id, c.email, c.first_name, c.last_name
     FROM tax_engagements te
     JOIN engagements e ON e.id = te.engagement_id
     JOIN contacts c ON c.id = e.contact_id
     WHERE te.id = $1`,
    [taxEngagementId]
  );
  const te = rows[0];
  if (!te) throw new AppError(404, 'not_found', 'Tax engagement not found.');
  if (!te.email) throw new AppError(400, 'recipient_missing', 'Contact has no email address.');

  const envelope = await createEnvelope(app, { type: 'staff', id: actor.id, label: actor.label }, {
    contactId: te.contact_id,
    type: 'f8879',
    taxEngagementId,
    signatureMethod: 'remote_kba',
    status: 'kba_required',
  });

  const verifier = makeKbaVerifier(app.config);
  const { vendorRef } = await verifier.start({
    envelopeId: envelope.id,
    contactId: te.contact_id,
    recipientEmail: te.email,
    recipientName: `${te.first_name} ${te.last_name}`,
  });
  const kba = await app.db.query<{ id: string }>(
    `INSERT INTO kba_verifications (envelope_id, vendor, vendor_ref, status, attempts)
     VALUES ($1, $2, $3, 'pending', 1) RETURNING id`,
    [envelope.id, verifier.vendor, vendorRef]
  );
  await app.db.query(`UPDATE signature_envelopes SET status = 'kba_pending' WHERE id = $1`, [envelope.id]);
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.label,
    action: 'kba.started', objectType: 'signature_envelope', objectId: envelope.id,
    contactId: te.contact_id, details: { vendor: verifier.vendor },
  });
  return { envelopeId: envelope.id, kbaId: kba.rows[0]!.id, vendor: verifier.vendor };
}

/**
 * v4.3 flow 2: ONE bundled envelope + ONE KBA for an entity group's 8879s.
 * The group's signer (member_role 'owner', else the first contact member)
 * verifies once; completion stamps f8879 on EVERY covered engagement.
 */
export async function startGroupRemote8879(
  app: FastifyInstance,
  actor: { id: string; label: string },
  groupId: string,
  taxYear: number
): Promise<{ envelopeId: string; kbaId: string; vendor: string; covered: number }> {
  assertKbaUsable(app.config);
  const signer = await app.db.query<{ contact_id: string; email: string | null; first_name: string; last_name: string }>(
    `SELECT c.id AS contact_id, c.email, c.first_name, c.last_name
     FROM entity_group_members gm
     JOIN contacts c ON c.id = gm.contact_id
     WHERE gm.group_id = $1 AND gm.contact_id IS NOT NULL
     ORDER BY (gm.member_role = 'owner') DESC, c.created_at
     LIMIT 1`,
    [groupId]
  );
  const s = signer.rows[0];
  if (!s) throw new AppError(400, 'no_signer', 'The group has no contact member to sign for it.');
  if (!s.email) throw new AppError(400, 'recipient_missing', 'The signer has no email address.');

  const engagements = await app.db.query<{ id: string }>(
    `SELECT te.id
     FROM tax_engagements te
     JOIN engagements e ON e.id = te.engagement_id
     WHERE e.business_id IN (SELECT business_id FROM entity_group_members WHERE group_id = $1 AND business_id IS NOT NULL)
       AND te.tax_year = $2
       AND te.f8879_signed_at IS NULL
       AND te.stage NOT IN ('completed', 'withdrawn')`,
    [groupId, taxYear]
  );
  if (engagements.rows.length === 0) {
    throw new AppError(400, 'nothing_to_sign', `No ${taxYear} group engagements are awaiting an 8879.`);
  }

  const envelope = await createEnvelope(app, { type: 'staff', id: actor.id, label: actor.label }, {
    contactId: s.contact_id,
    type: 'f8879',
    signatureMethod: 'remote_kba',
    status: 'kba_required',
  });
  await app.db.query(`UPDATE signature_envelopes SET entity_group_id = $2 WHERE id = $1`, [envelope.id, groupId]);
  for (const te of engagements.rows) {
    await app.db.query(
      `INSERT INTO signature_envelope_items (envelope_id, tax_engagement_id) VALUES ($1, $2)`,
      [envelope.id, te.id]
    );
  }

  const verifier = makeKbaVerifier(app.config);
  const { vendorRef } = await verifier.start({
    envelopeId: envelope.id,
    contactId: s.contact_id,
    recipientEmail: s.email,
    recipientName: `${s.first_name} ${s.last_name}`,
  });
  const kba = await app.db.query<{ id: string }>(
    `INSERT INTO kba_verifications (envelope_id, vendor, vendor_ref, status, attempts)
     VALUES ($1, $2, $3, 'pending', 1) RETURNING id`,
    [envelope.id, verifier.vendor, vendorRef]
  );
  await app.db.query(`UPDATE signature_envelopes SET status = 'kba_pending' WHERE id = $1`, [envelope.id]);
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.label,
    action: 'kba.started', objectType: 'signature_envelope', objectId: envelope.id,
    contactId: s.contact_id,
    details: { vendor: verifier.vendor, entity_group_id: groupId, covered: engagements.rows.length },
  });
  return { envelopeId: envelope.id, kbaId: kba.rows[0]!.id, vendor: verifier.vendor, covered: engagements.rows.length };
}

/** KBA outcome (vendor webhook in production; simulate endpoint in sandbox). Pass → envelope auto-sends. */
export async function resolveKba(
  app: FastifyInstance,
  docuseal: DocusealAdapter,
  kbaId: string,
  outcome: 'passed' | 'failed',
  failureReason?: string
): Promise<{ envelopeId: string; sent: boolean }> {
  const { rows } = await app.db.query<{ id: string; envelope_id: string; status: string; contact_id: string }>(
    `SELECT k.id, k.envelope_id, k.status, se.contact_id
     FROM kba_verifications k JOIN signature_envelopes se ON se.id = k.envelope_id
     WHERE k.id = $1`,
    [kbaId]
  );
  const kba = rows[0];
  if (!kba) throw new AppError(404, 'not_found', 'KBA verification not found.');
  if (kba.status !== 'pending') throw new AppError(409, 'kba_already_resolved', `KBA is already '${kba.status}'.`);

  await app.db.query(
    `UPDATE kba_verifications
     SET status = $2, verified_at = CASE WHEN $2 = 'passed' THEN now() END, failure_reason = $3
     WHERE id = $1`,
    [kbaId, outcome, failureReason ?? null]
  );
  await writeAudit(app.db, {
    actorType: 'system', action: `kba.${outcome}`,
    objectType: 'signature_envelope', objectId: kba.envelope_id, contactId: kba.contact_id,
  });

  if (outcome === 'passed') {
    await sendEnvelope(app, docuseal, { type: 'system', label: 'kba passed' }, kba.envelope_id);
    return { envelopeId: kba.envelope_id, sent: true };
  }
  await app.db.query(`UPDATE signature_envelopes SET status = 'kba_required' WHERE id = $1`, [kba.envelope_id]);
  return { envelopeId: kba.envelope_id, sent: false };
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
  } else if (env.type === 'consent_7216') {
    await record7216Consent(app, {
      contactId: env.contact_id,
      type: '7216_use',
      method: 'docuseal',
      documentId: doc.id,
      envelopeId: env.id,
    });
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
