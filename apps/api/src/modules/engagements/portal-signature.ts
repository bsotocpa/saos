// Portal-native E-SIGN / UETA signature for engagement packets.
//
// Docuseal self-hosted keeps Form 8879, where IRS Pub 1345 requires KBA. Engagement
// packets do not need KBA, Master §4 already carries the client's consent to
// electronic records and signatures, and signing here keeps every client document
// in-house at zero recurring cost.
//
// The design rests on ONE idea: the client signs a HASH, not a promise.
//
//   1. `presentForSignature` renders the packet document and returns it with the
//      sha256 of its exact bytes.
//   2. The client signs, submitting that hash back.
//   3. `signPacketInPortal` re-renders, re-hashes, and REFUSES if the hashes differ.
//
// So if a price, a template, or a schedule changed between reading and signing, the
// signature is rejected rather than silently binding the client to text they never
// saw. That is the whole reason this is safe to do ourselves.

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Client as MinioClient } from 'minio';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { buildPacketDocument } from './packet-document.ts';
import { recordMasterSignature } from './packet.ts';

export function hashDocument(html: string): string {
  return createHash('sha256').update(html, 'utf8').digest('hex');
}

export interface PresentedPacket {
  packetId: string;
  language: 'en' | 'es';
  html: string;
  documentSha256: string;
  scheduleCodes: string[];
  sections: Array<{ kind: string; code: string | null; title: string; templateVersion: number }>;
  alreadySigned: boolean;
  /** What the client must affirm — surfaced so the portal cannot invent its own wording. */
  affirmations: { intent: string; esignConsent: string };
}

const AFFIRMATIONS = {
  intent:
    'I have read the agreement and the schedules above, and I intend to be bound by them. ' +
    'Typing my name below is my signature.',
  esignConsent:
    'I agree to sign electronically and to receive records, notices, and disclosures ' +
    'electronically, as described in the agreement. I can request a paper copy at any time.',
};

/** The document to show, plus the hash the signature must come back with. */
export async function presentForSignature(
  app: FastifyInstance,
  contactId: string,
  language: 'en' | 'es' = 'en'
): Promise<PresentedPacket> {
  const { rows } = await app.db.query<{ id: string; status: string; schedule_codes: string[] }>(
    `SELECT id, status, schedule_codes FROM engagement_packets
     WHERE contact_id = $1 AND status IN ('draft', 'sent', 'signed')
     ORDER BY created_at DESC LIMIT 1`,
    [contactId]
  );
  const packet = rows[0];
  if (!packet) {
    throw new AppError(404, 'no_packet', 'There is no engagement packet waiting for your signature.');
  }

  const doc = await buildPacketDocument(app, packet.id, language);
  return {
    packetId: packet.id,
    language,
    html: doc.html,
    documentSha256: hashDocument(doc.html),
    scheduleCodes: packet.schedule_codes,
    sections: doc.sections.map((s) => ({
      kind: s.kind, code: s.code, title: s.title, templateVersion: s.templateVersion,
    })),
    alreadySigned: packet.status === 'signed',
    affirmations: AFFIRMATIONS,
  };
}

export interface SignInput {
  /** Typed by the client. Their signature, and their intent made visible. */
  signedName: string;
  intentAffirmed: boolean;
  esignConsentAck: boolean;
  /** The hash of the document they were shown. */
  documentSha256: string;
  language?: 'en' | 'es' | undefined;
}

/**
 * Record the signature. Attribution comes from the verified session — the caller
 * passes the session's contact and portal user, never anything from the request body.
 */
export async function signPacketInPortal(
  app: FastifyInstance,
  minio: MinioClient,
  session: { contactId: string; portalUserId: string },
  input: SignInput,
  meta: { ip?: string | null; userAgent?: string | null } = {}
): Promise<{ packetId: string; signatureId: string; accepted: string[]; documentSha256: string }> {
  if (!input.intentAffirmed) {
    throw new AppError(
      400, 'intent_required',
      'A signature needs an affirmative act of intent. Confirm you intend to be bound before signing.'
    );
  }
  if (!input.esignConsentAck) {
    throw new AppError(
      400, 'esign_consent_required',
      'Signing electronically requires your consent to do so. Confirm the electronic-records statement, or ask us for a paper copy.'
    );
  }
  if (input.signedName.trim().length < 2) {
    throw new AppError(400, 'signed_name_required', 'Type your full name to sign.');
  }

  const language = input.language ?? 'en';
  const presented = await presentForSignature(app, session.contactId, language);
  if (presented.alreadySigned) {
    throw new AppError(
      409, 'already_signed',
      'This agreement is already signed. Services added later are accepted per-schedule, not by signing again.'
    );
  }

  // THE INTEGRITY CHECK. A mismatch means the document changed between the client
  // reading it and signing it — refuse, and make them read the current version.
  if (presented.documentSha256 !== input.documentSha256) {
    throw new AppError(
      409,
      'document_changed',
      'The agreement changed while you had it open, so this signature was not recorded. ' +
        'Please reload and read the current version before signing — we will not bind you to text you did not see.'
    );
  }

  // Store the exact bytes signed, before recording the signature: if this fails,
  // there is no signature without a retained copy.
  const bucket = 'saos-signed-docs';
  const objectKey = `packet-signatures/${presented.packetId}/${presented.documentSha256}.html`;
  const body = Buffer.from(presented.html, 'utf8');
  try {
    await minio.putObject(bucket, objectKey, body, body.length, { 'Content-Type': 'text/html; charset=utf-8' });
  } catch (err) {
    throw new AppError(
      502, 'signed_copy_storage_failed',
      `The signed copy could not be stored, so the signature was not recorded: ${(err as Error).message}`
    );
  }

  const sig = await app.db.query<{ id: string }>(
    `INSERT INTO packet_signatures
       (packet_id, contact_id, portal_user_id, signed_name, intent_affirmed, esign_consent_ack,
        document_sha256, document_object_key, section_versions, language, ip, user_agent)
     VALUES ($1,$2,$3,$4,true,true,$5,$6,$7::jsonb,$8,$9,$10)
     RETURNING id`,
    [
      presented.packetId, session.contactId, session.portalUserId, input.signedName.trim(),
      presented.documentSha256, objectKey,
      JSON.stringify(presented.sections), language,
      meta.ip ?? null, meta.userAgent ?? null,
    ]
  );

  // Everything downstream is unchanged: one signature accepts the Master and every
  // schedule attached, keeps contacts.engagement_letter_status in step, and stamps
  // the late-fee disclosure because the Master carries it. The method is stamped in
  // the same statement that marks the packet signed.
  const result = await recordMasterSignature(app, presented.packetId, { ...meta, method: 'portal_esign' });

  // The disclosed RATE is stamped with the timestamp (finding #25): the assessment caps
  // every charge at the rate the client's own signed letter disclosed, and a later edit
  // to the Master must not raise it for someone who signed the earlier text.
  await app.db.query(
    `UPDATE contacts c
        SET late_fee_disclosure_signed_at = COALESCE(c.late_fee_disclosure_signed_at, now()),
            late_fee_disclosed_rate_percent =
              COALESCE(c.late_fee_disclosed_rate_percent, t.late_fee_rate_percent)
       FROM engagement_packets p
       JOIN templates t ON t.key = p.master_template_key
      WHERE c.id = $1 AND p.id = $2 AND t.has_late_fee_disclosure`,
    [session.contactId, presented.packetId]
  );

  // ONBOARDING STEP 2 IS DONE BY DEFINITION. Signing the agreement IS "sign your
  // documents", so it is marked here rather than waiting for the client to tick it —
  // a checklist that still shows step 2 open after they just signed is the system
  // disagreeing with the thing the client did thirty seconds ago.
  await app.db.query(
    `INSERT INTO portal_onboarding (contact_id) VALUES ($1) ON CONFLICT (contact_id) DO NOTHING`,
    [session.contactId]
  );
  await app.db.query(
    `UPDATE portal_onboarding
     SET step_sign_docs_at = COALESCE(step_sign_docs_at, now())
     WHERE contact_id = $1`,
    [session.contactId]
  );
  await app.db.query(
    // Same completion rule as the checklist route: the retired book_consult step is
    // gone, and the deposit only counts when one was actually owed. Leaving the old
    // condition here would have meant no client could finish onboarding again.
    `UPDATE portal_onboarding o SET completed_at = now()
      WHERE o.contact_id = $1 AND o.completed_at IS NULL
        AND o.step_sign_docs_at IS NOT NULL
        AND o.step_confirm_info_at IS NOT NULL
        AND o.step_upload_documents_at IS NOT NULL
        AND o.step_track_services_at IS NOT NULL
        AND (
          o.step_pay_deposit_at IS NOT NULL
          OR NOT EXISTS (
            SELECT 1 FROM quotes q WHERE q.contact_id = $1 AND q.deposit_invoice_id IS NOT NULL
          )
        )`,
    [session.contactId]
  );

  await writeAudit(app.db, {
    actorType: 'client', actorId: session.contactId, actorLabel: input.signedName.trim(),
    action: 'packet.signed_in_portal', objectType: 'engagement_packet', objectId: presented.packetId,
    contactId: session.contactId,
    ip: meta.ip ?? null, userAgent: meta.userAgent ?? null,
    details: {
      method: 'portal_esign',
      document_sha256: presented.documentSha256,
      document_object_key: objectKey,
      schedules: result.accepted,
      sections: presented.sections,
      language,
    },
  });

  return {
    packetId: presented.packetId,
    signatureId: sig.rows[0]!.id,
    accepted: result.accepted,
    documentSha256: presented.documentSha256,
  };
}
