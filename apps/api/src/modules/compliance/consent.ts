// §7216 enforcement (MP Compliance Layer — non-negotiable).
//
// "The referral engine, upsell flagging, and any cross-entity use of tax
// return information is BLOCKED per-client until a signed 7216 consent is on
// file." Every code path that uses tax return information across the
// Soto/Hilo boundary MUST call require7216Consent first. Migrated legacy
// clients default to 'not_on_file' (the contacts column default).

import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db.ts';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';

export async function has7216Consent(db: Db, contactId: string): Promise<boolean> {
  const { rows } = await db.query<{ consent_7216_status: string }>(
    `SELECT consent_7216_status FROM contacts WHERE id = $1`,
    [contactId]
  );
  return rows[0]?.consent_7216_status === 'signed';
}

/** Gate: throws 403 unless a signed §7216 consent is on file for the contact. */
export async function require7216Consent(db: Db, contactId: string): Promise<void> {
  if (!(await has7216Consent(db, contactId))) {
    throw new AppError(
      403,
      'consent_7216_required',
      'Blocked: no signed §7216 consent on file for this client. Cross-entity use of tax return information, referrals, and upsell flagging are unavailable until the consent is signed.'
    );
  }
}

/**
 * Record a signed §7216 consent (Docuseal webhook in M11; wet-signature upload
 * path for in-office clients). Creates the consent row and maintains the
 * contact rollup the gate reads.
 */
export async function record7216Consent(
  app: FastifyInstance,
  opts: {
    contactId: string;
    type: '7216_use' | '7216_disclose';
    method: 'docuseal' | 'wet_signature';
    policyVersion?: string | null;
    documentId?: string | null;
    envelopeId?: string | null;
    actorStaffId?: string | null;
    actorLabel?: string | null;
  }
): Promise<void> {
  await app.db.query(
    `INSERT INTO consents (contact_id, type, status, method, policy_version, document_id, envelope_id, signed_at)
     VALUES ($1, $2, 'signed', $3, $4, $5, $6, now())`,
    [opts.contactId, opts.type, opts.method, opts.policyVersion ?? null, opts.documentId ?? null, opts.envelopeId ?? null]
  );
  await app.db.query(`UPDATE contacts SET consent_7216_status = 'signed' WHERE id = $1`, [opts.contactId]);
  await writeAudit(app.db, {
    actorType: opts.actorStaffId ? 'staff' : 'system',
    actorId: opts.actorStaffId ?? null,
    actorLabel: opts.actorLabel ?? null,
    action: 'consent.7216_recorded',
    objectType: 'contact',
    objectId: opts.contactId,
    contactId: opts.contactId,
    details: { type: opts.type, method: opts.method },
  });
}
