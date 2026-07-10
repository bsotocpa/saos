// Referral flows both directions (MP automations 14–15, Nonprofit Referral
// Integrity, OF Form 3).
//
// §7216 INTERPRETATION (documented for Brian's review): the statute protects
// TAX RETURN INFORMATION. We therefore gate:
//   soto_to_hilo — ALWAYS requires signed §7216 consent (a Soto tax client's
//                  information is flowing across the entity boundary), and
//   hilo_to_soto — requires consent ONLY when the contact already has tax
//                  engagements at Soto (i.e., tax return information exists).
//                  A pure Hilo entrepreneur has no Soto tax data to protect —
//                  and their §7216 consent is queued AT Soto intake, which is
//                  where the transition lands them.
// The referral-integrity DISCLOSURE trail is mandatory for every hilo_to_soto
// conversion regardless (DB CHECK enforces it — protects the 990).

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { has7216Consent, require7216Consent } from '../compliance/consent.ts';
import { firstActiveByRole, notifyOnce } from '../../staffing.ts';
import { closeTasksForSource, createTask } from '../tasks/service.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { createScopedToken, verifyScopedToken } from '../../crypto.ts';
import { processSotoIntake } from '../forms/service.ts';

const TRANSITION_PURPOSE = 'hilo_transition';
const TRANSITION_TTL_SECONDS = 14 * 24 * 3600;

async function contactHasTaxData(app: FastifyInstance, contactId: string): Promise<boolean> {
  const { rows } = await app.db.query(
    `SELECT 1 FROM engagements WHERE contact_id = $1 AND service_line = 'tax' LIMIT 1`,
    [contactId]
  );
  return rows.length > 0;
}

/** The §7216 gate for referral creation, per the interpretation above. */
export async function assertReferralAllowed(
  app: FastifyInstance,
  contactId: string,
  direction: 'hilo_to_soto' | 'soto_to_hilo'
): Promise<void> {
  if (direction === 'soto_to_hilo') {
    await require7216Consent(app.db, contactId);
    return;
  }
  if (await contactHasTaxData(app, contactId)) {
    await require7216Consent(app.db, contactId);
  }
}

export async function createReferral(
  app: FastifyInstance,
  actor: { type: 'staff' | 'client' | 'system'; id?: string | null; label?: string | null },
  input: {
    contactId: string;
    direction: 'hilo_to_soto' | 'soto_to_hilo';
    source: 'session_summary' | 'manual' | 'portal_cta' | 'intake' | 'directory';
    notes?: string | undefined;
  }
): Promise<{ id: string }> {
  await assertReferralAllowed(app, input.contactId, input.direction);

  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO referrals (contact_id, direction, status, source, suggested_by_staff_id, notes)
     VALUES ($1, $2::referral_direction, 'pending_approval', $3::referral_source, $4, $5)
     RETURNING id`,
    [input.contactId, input.direction, input.source, actor.type === 'staff' ? actor.id : null, input.notes ?? null]
  );
  const id = rows[0]!.id;

  // The approval queue lives with the receiving side's lead: Jackson approves
  // Hilo→Soto handoffs; the ED/COO role also holds the Soto→Hilo queue.
  const approver = await firstActiveByRole(app.db, 'ed_coo');
  if (approver) {
    await notifyOnce(app.db, {
      staffId: approver,
      type: 'referral_pending',
      severity: 'info',
      title: `Referral awaiting approval (${input.direction === 'hilo_to_soto' ? 'Hilo → Soto' : 'Soto → Hilo'})`,
      contactId: input.contactId,
      relatedObjectType: 'referral',
      relatedObjectId: id,
    });
    // M25: the approval is a WORK ITEM — a task in the owner rollup, closed
    // automatically by the decision (v4.4 unified-task rule).
    await createTask(app, {
      title: `Approve referral: ${input.direction === 'hilo_to_soto' ? 'Hilo → Soto' : 'Soto → Hilo'}`,
      assignedStaffId: approver,
      contactId: input.contactId,
      priority: 1,
      source: 'automation',
      sourceType: 'referral_approval',
      sourceId: id,
    });
  }
  await writeAudit(app.db, {
    actorType: actor.type,
    actorId: actor.id ?? null,
    actorLabel: actor.label ?? null,
    action: 'referral.suggested',
    objectType: 'referral',
    objectId: id,
    contactId: input.contactId,
    details: { direction: input.direction, source: input.source },
  });
  return { id };
}

interface ReferralRow {
  id: string;
  contact_id: string;
  direction: 'hilo_to_soto' | 'soto_to_hilo';
  status: string;
  suggested_by_staff_id: string | null;
  first_name: string;
  last_name: string;
  email: string | null;
  language: 'en' | 'es';
}

async function loadReferral(app: FastifyInstance, id: string): Promise<ReferralRow> {
  const { rows } = await app.db.query<ReferralRow>(
    `SELECT r.id, r.contact_id, r.direction, r.status, r.suggested_by_staff_id,
            c.first_name, c.last_name, c.email, c.language
     FROM referrals r JOIN contacts c ON c.id = r.contact_id
     WHERE r.id = $1`,
    [id]
  );
  if (!rows[0]) throw new AppError(404, 'not_found', 'Referral not found.');
  return rows[0];
}

/** One-tap approve (Jackson/Brian from mobile). */
export async function approveReferral(
  app: FastifyInstance,
  actor: { id: string; label: string },
  referralId: string
): Promise<void> {
  const r = await loadReferral(app, referralId);
  if (r.status !== 'pending_approval' && r.status !== 'suggested') {
    throw new AppError(409, 'invalid_status', `Referral is '${r.status}' — cannot approve.`);
  }
  await app.db.query(
    `UPDATE referrals SET status = 'approved', approved_by_staff_id = $2, approved_at = now() WHERE id = $1`,
    [referralId, actor.id]
  );
  await closeTasksForSource(app, 'referral_approval', referralId, 'referral approved');
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.label,
    action: 'referral.approved', objectType: 'referral', objectId: referralId, contactId: r.contact_id,
  });
}

export async function declineReferral(
  app: FastifyInstance,
  actor: { id: string; label: string },
  referralId: string
): Promise<void> {
  const r = await loadReferral(app, referralId);
  await app.db.query(`UPDATE referrals SET status = 'declined' WHERE id = $1`, [referralId]);
  await closeTasksForSource(app, 'referral_approval', referralId, 'referral declined');
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.label,
    action: 'referral.declined', objectType: 'referral', objectId: referralId, contactId: r.contact_id,
  });
}

/**
 * Send the referral to the client:
 *   hilo_to_soto → warm-handoff email with the pre-filled transition link
 *                  (status stays 'approved'; it becomes 'converted' when the
 *                  client submits Form 3 WITH the disclosure acknowledged)
 *   soto_to_hilo → warm intro to Hilo (status → 'sent')
 */
export async function sendReferral(
  app: FastifyInstance,
  actor: { id: string; label: string },
  referralId: string
): Promise<{ transitionUrl?: string }> {
  const r = await loadReferral(app, referralId);
  if (r.status !== 'approved') throw new AppError(409, 'invalid_status', 'Approve the referral first.');
  if (!r.email) throw new AppError(400, 'recipient_missing', 'Contact has no email address.');

  if (r.direction === 'hilo_to_soto') {
    const token = createScopedToken(app.config.APP_ENCRYPTION_KEY, r.id, TRANSITION_PURPOSE, TRANSITION_TTL_SECONDS);
    const transitionUrl = `${app.config.PORTAL_BASE_URL}/transition?rt=${token}`;
    await sendTemplatedEmail(app, {
      to: r.email,
      templateKey: 'referral_intro_hilo_to_soto',
      language: r.language,
      contactId: r.contact_id,
      vars: { first_name: r.first_name, transition_link: transitionUrl },
    });
    await app.db.query(`UPDATE referrals SET sent_at = now() WHERE id = $1`, [referralId]);
    await writeAudit(app.db, {
      actorType: 'staff', actorId: actor.id, actorLabel: actor.label,
      action: 'referral.link_sent', objectType: 'referral', objectId: referralId, contactId: r.contact_id,
    });
    return { transitionUrl };
  }

  await sendTemplatedEmail(app, {
    to: r.email,
    templateKey: 'referral_intro_soto_to_hilo',
    language: r.language,
    contactId: r.contact_id,
    vars: { first_name: r.first_name },
  });
  await app.db.query(`UPDATE referrals SET status = 'sent', sent_at = now() WHERE id = $1`, [referralId]);
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.label,
    action: 'referral.sent', objectType: 'referral', objectId: referralId, contactId: r.contact_id,
  });
  return {};
}

// ── Form 3: the pre-filled transition (client-facing, token-authed) ─────────

async function disclosurePolicyVersion(app: FastifyInstance): Promise<string> {
  const { rows } = await app.db.query<{ value: string }>(
    `SELECT value #>> '{}' AS value FROM app_settings WHERE key = 'referral.disclosure_policy_version'`
  );
  return rows[0]?.value ?? 'unversioned';
}

export async function transitionPrefill(app: FastifyInstance, rt: string) {
  const referralId = verifyScopedToken(app.config.APP_ENCRYPTION_KEY, rt, TRANSITION_PURPOSE);
  if (!referralId) throw new AppError(401, 'invalid_transition_link', 'This link is invalid or expired.');
  const r = await loadReferral(app, referralId);
  if (r.status === 'converted') throw new AppError(409, 'already_converted', 'This transition was already completed.');

  const contact = await app.db.query<{
    first_name: string; last_name: string; email: string | null; phone: string | null;
    language: 'en' | 'es'; hilo_status: string;
  }>(
    `SELECT first_name, last_name, email, phone, language, hilo_status FROM contacts WHERE id = $1`,
    [r.contact_id]
  );
  const c = contact.rows[0]!;
  const business = await app.db.query<{ name: string; entity_type: string | null; industry: string | null; zip: string | null }>(
    `SELECT b.name, b.entity_type, b.industry, b.zip
     FROM businesses b JOIN business_members m ON m.business_id = b.id
     WHERE m.contact_id = $1 AND m.is_primary LIMIT 1`,
    [r.contact_id]
  );
  // Pre-check services from session-summary flags (meeting intelligence).
  const taxNeed = await app.db.query(
    `SELECT 1 FROM meeting_summaries ms JOIN meetings m ON m.id = ms.meeting_id
     WHERE m.contact_id = $1 AND ms.tax_need LIMIT 1`,
    [r.contact_id]
  );

  // The referral-integrity block (admin-editable template; REQUIRED screen).
  const disclosure = await app.db.query<{ body_en: string; body_es: string | null }>(
    `SELECT body_en, body_es FROM templates WHERE key = 'referral_disclosure'`
  );
  const d = disclosure.rows[0];

  return {
    language: c.language,
    contact: { firstName: c.first_name, lastName: c.last_name, email: c.email, phone: c.phone },
    business: business.rows[0] ?? null,
    preCheckedServices: taxNeed.rows.length > 0 ? ['tax_personal'] : [],
    disclosure: c.language === 'es' ? (d?.body_es ?? d?.body_en ?? '') : (d?.body_en ?? ''),
    policyVersion: await disclosurePolicyVersion(app),
  };
}

export async function transitionSubmit(
  app: FastifyInstance,
  rt: string,
  input: {
    services: string[];
    disclosureAcknowledged: boolean;
    communicationConsent: boolean;
    esignConsent: boolean;
    ein?: string | undefined;
    smsOk?: boolean | undefined;
  },
  meta: { ip?: string | null }
): Promise<{ contactId: string }> {
  const referralId = verifyScopedToken(app.config.APP_ENCRYPTION_KEY, rt, TRANSITION_PURPOSE);
  if (!referralId) throw new AppError(401, 'invalid_transition_link', 'This link is invalid or expired.');
  const r = await loadReferral(app, referralId);
  if (r.status === 'converted') throw new AppError(409, 'already_converted', 'This transition was already completed.');

  // The acknowledgement is REQUIRED — no trail, no conversion (protects the 990).
  if (!input.disclosureAcknowledged) {
    throw new AppError(400, 'disclosure_ack_required', 'The referral disclosure must be acknowledged to continue.');
  }
  if (!input.communicationConsent || !input.esignConsent) {
    throw new AppError(400, 'consents_required', 'Communication and e-sign consents are required.');
  }

  const contact = await app.db.query<{
    first_name: string; last_name: string; email: string | null; phone: string | null; language: 'en' | 'es';
  }>(`SELECT first_name, last_name, email, phone, language FROM contacts WHERE id = $1`, [r.contact_id]);
  const c = contact.rows[0]!;
  if (!c.email) throw new AppError(400, 'recipient_missing', 'Contact has no email address.');

  // Who suggested it — feeds BR3 (referred by Jackson) + BR6.
  const suggester = r.suggested_by_staff_id
    ? await app.db.query<{ full_name: string; role_key: string }>(
        `SELECT st.full_name, r2.key AS role_key FROM staff st JOIN roles r2 ON r2.id = st.role_id WHERE st.id = $1`,
        [r.suggested_by_staff_id]
      )
    : null;

  // Reuse the intake automation (#1) with server-injected bridge data —
  // Form 3 IS Form 1 with everything Hilo already knows pre-filled.
  const answers = {
    language: c.language,
    first_name: c.first_name,
    last_name: c.last_name,
    email: c.email,
    mobile_phone: c.phone ?? '',
    sms_ok: input.smsOk === false ? 'no' : 'yes',
    preferred_contact_method: 'portal',
    owns_business: 'no', // primary business (if any) is already on the record
    services: input.services,
    filed_last_year: 'yes',
    irs_letters: 'no',
    how_heard: 'hilo',
    communication_consent: true,
    esign_consent: true,
    _hilo: {
      referringContactId: r.contact_id,
      referredByJackson: suggester?.rows[0]?.role_key === 'ed_coo',
      staff: suggester?.rows[0]?.full_name ?? null,
    },
  };
  const submission = await app.db.query<{ id: string }>(
    `INSERT INTO form_submissions (form_key, form_version, contact_id, status, language, answers, source, submitted_at)
     VALUES ('soto_transition', 1, $1, 'submitted', $2, $3::jsonb, 'hilo_link', now()) RETURNING id`,
    [r.contact_id, c.language, JSON.stringify(answers)]
  );
  const result = await processSotoIntake(app, submission.rows[0]!.id, answers);

  // Disclosure trail + conversion (the DB CHECK requires the trail — belt and suspenders).
  const policyVersion = await disclosurePolicyVersion(app);
  await app.db.query(
    `UPDATE referrals
     SET status = 'converted', converted_at = now(),
         disclosure_shown_at = now(), disclosure_policy_version = $2
     WHERE id = $1`,
    [referralId, policyVersion]
  );
  await writeAudit(app.db, {
    actorType: 'client',
    actorLabel: c.email,
    action: 'referral.converted',
    objectType: 'referral',
    objectId: referralId,
    contactId: r.contact_id,
    ip: meta.ip,
    details: { disclosure_policy_version: policyVersion, services: input.services },
  });

  // Brian notified (spec: "Soto lead created with full attribution, Brian notified").
  const brian = await firstActiveByRole(app.db, 'ceo');
  if (brian) {
    await notifyOnce(app.db, {
      staffId: brian,
      type: 'hilo_transition_converted',
      severity: 'info',
      title: `Hilo → Soto: ${c.first_name} ${c.last_name} completed the transition`,
      contactId: r.contact_id,
      relatedObjectType: 'referral',
      relatedObjectId: referralId,
    });
  }
  return result;
}

// ── Automation 15: the Soto CTA in the (future) Hilo portal ─────────────────

/** §7216-aware CTA: fires for hilo_status='referral' or session tax-need flags. */
export async function sotoCtaState(app: FastifyInstance, contactId: string): Promise<{ show: boolean; reason: string | null }> {
  const contact = await app.db.query<{ hilo_status: string }>(
    `SELECT hilo_status FROM contacts WHERE id = $1`,
    [contactId]
  );
  const hiloStatus = contact.rows[0]?.hilo_status;
  const taxNeed = await app.db.query(
    `SELECT 1 FROM meeting_summaries ms JOIN meetings m ON m.id = ms.meeting_id
     WHERE m.contact_id = $1 AND ms.tax_need LIMIT 1`,
    [contactId]
  );
  const triggered = hiloStatus === 'referral' || taxNeed.rows.length > 0;
  if (!triggered) return { show: false, reason: null };

  // 7216-aware: when Soto tax data exists for this contact, the CTA (a
  // cross-entity use of that relationship) needs the signed consent.
  if (await contactHasTaxData(app, contactId)) {
    if (!(await has7216Consent(app.db, contactId))) return { show: false, reason: 'consent_7216_required' };
  }
  return { show: true, reason: hiloStatus === 'referral' ? 'hilo_status_referral' : 'session_tax_need' };
}
