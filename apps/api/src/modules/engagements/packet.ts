// Master + Schedules packet assembly (legal package v3 FINAL).
//
// Master §1 is the specification:
//
//   "Your signature below constitutes acceptance of this Agreement and every
//    Service Schedule attached at signing. Services added later are engaged by
//    your electronic acceptance of the applicable Schedule through the client
//    portal, without re-execution of this Agreement."
//
// So there are exactly two ways a schedule becomes binding, and both are recorded
// with WHICH way it was:
//
//   1. `master_signature` — attached at signing, covered by the one signature.
//   2. `portal_acceptance` — added later, accepted per-schedule in the portal.
//
// Two refusals that matter more than the happy path:
//
//  · ATTEST HAS NO v3 SCHEDULE. Schedules A–E do not cover CPA review/audit work.
//    Assembly REFUSES rather than attaching attest work to Advisory terms it does
//    not belong under. That is a gap for the attorney, not something to paper over.
//  · A SCHEDULE CANNOT BE ACCEPTED BEFORE THE MASTER, because each Schedule
//    incorporates it. Portal acceptance without a signed Master is refused.

import type { FastifyInstance } from 'fastify';
import { stripWetSignatureLines } from '../compliance/consent-presentation.ts';
import { writeAudit } from '../../audit.ts';
import { AppError, type AuthedStaff } from '../../types.ts';

export type ServiceLine =
  | 'tax' | 'bookkeeping' | 'payroll' | 'sales_tax' | 'advisory'
  | 'coo' | 'entity' | 'attest' | 'specialized_cpa' | 'nonprofit_cfo';

/**
 * Return types that make a tax engagement a BUSINESS return (Schedule B) rather
 * than an individual one (Schedule A). This is a legal-scope determination from
 * the schedule text, not an admin preference, so it lives in code.
 */
export const BUSINESS_RETURN_TYPES = new Set([
  '1065', '1120s', '1120', '990', '990ez', '1120c', '1120f', '1120h', '1120pol',
  '1041', '1120f_foreign', 'ag990il',
]);

/**
 * Service lines with no schedule at all. Assembly refuses these by name.
 *
 * `attest` used to live here. Schedule F (SOTO_Schedule_F_Attest_FINALFORM) now
 * covers CPA review, audit, and insurance/WC audit work, so attest is assemblable
 * — but under a stricter rule than any other line: see `assertAttestAddendum`.
 * Nothing else is currently unscheduled; the map stays because the NEXT service
 * line Brian invents will need it, and a named refusal beats silent mis-filing.
 */
export const UNSCHEDULED_SERVICE_LINES: Record<string, string> = {};

export interface ResolvedSchedules {
  codes: string[];
  titles: Record<string, string>;
  /** Service lines that drove each schedule, for the audit trail and the UI. */
  reasons: Record<string, string[]>;
}

/**
 * Which schedules a client's services require. Reads the service_lines mapping
 * from `service_schedules` (admin-editable data) and adds the A/B tax split from
 * the return types actually on file.
 */
export async function resolveSchedules(
  app: FastifyInstance,
  contactId: string,
  opts: { extraServiceLines?: ServiceLine[] } = {}
): Promise<ResolvedSchedules> {
  /*
   * `on_hold` belongs here (#44). A paused engagement still HAS an agreement, and dropping
   * its schedule out of the packet would mean pausing one service silently rewrites the
   * legal document covering all of them.
   */
  const engagements = await app.db.query<{ service_line: ServiceLine }>(
    `SELECT DISTINCT service_line::text AS service_line FROM engagements
     WHERE contact_id = $1 AND status IN ('draft', 'active', 'on_hold')`,
    [contactId]
  );
  const lines = new Set<ServiceLine>([
    ...engagements.rows.map((r) => r.service_line),
    ...(opts.extraServiceLines ?? []),
  ]);

  const unscheduled = [...lines].filter((l) => UNSCHEDULED_SERVICE_LINES[l]);
  if (unscheduled.length > 0) {
    throw new AppError(
      409,
      'service_line_unscheduled',
      unscheduled.map((l) => UNSCHEDULED_SERVICE_LINES[l]).join(' '),
    );
  }

  // ::text[] is load-bearing. node-postgres has no parser for an array of a
  // custom enum type, so `service_line[]` arrives as the raw string '{tax}' and
  // every .filter() on it throws. text[] it parses natively.
  const mapping = await app.db.query<{ schedule_code: string; title: string; service_lines: ServiceLine[] }>(
    `SELECT schedule_code, title, service_lines::text[] AS service_lines
     FROM service_schedules ORDER BY sort_order`
  );

  const codes = new Set<string>();
  const titles: Record<string, string> = {};
  const reasons: Record<string, string[]> = {};
  for (const m of mapping.rows) {
    titles[m.schedule_code] = m.title;
    const hit = m.service_lines.filter((l) => lines.has(l));
    if (hit.length > 0) {
      codes.add(m.schedule_code);
      reasons[m.schedule_code] = hit;
    }
  }

  // The A/B split: 'tax' maps to A by default; a business return type adds B.
  if (lines.has('tax')) {
    const returns = await app.db.query<{ return_type: string }>(
      `SELECT DISTINCT te.return_type::text AS return_type
       FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id
       WHERE e.contact_id = $1`,
      [contactId]
    );
    const types = returns.rows.map((r) => r.return_type);
    const business = types.filter((t) => BUSINESS_RETURN_TYPES.has(t));
    const individual = types.filter((t) => !BUSINESS_RETURN_TYPES.has(t));
    if (business.length > 0) {
      codes.add('B');
      reasons.B = [...(reasons.B ?? []), ...business];
    }
    // No returns on file yet (quote accepted, engagement created, return not
    // created) defaults to A — the individual case is by far the common one, and
    // adding B later is a portal acceptance rather than a re-signature.
    if (individual.length > 0 || types.length === 0) {
      codes.add('A');
      reasons.A = [...(reasons.A ?? []), ...(individual.length > 0 ? individual : ['tax (return type not yet set)'])];
    } else {
      // Business-only: A is not needed.
      codes.delete('A');
      delete reasons.A;
    }
  }

  return { codes: [...codes].sort(), titles, reasons };
}

export interface AttestAddendumSummary {
  id: string;
  engagementId: string;
  entityName: string;
  engagementType: 'review' | 'audit' | 'insurance_wc';
  statementsAndPeriods: string;
  reportingFramework: string;
  feeSummary: string;
  depositSummary: string;
  expectedReportDate: string;
}

const ATTEST_TYPE_LABEL: Record<string, string> = {
  review: 'Review (SSARS)',
  audit: 'Audit (US GAAS)',
  insurance_wc: 'Insurance / workers’ compensation audit',
};

const usd = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

/**
 * ATTEST HAS A HARDER GATE THAN EVERY OTHER SCHEDULE.
 *
 * Schedule F carries the standing terms, but AU-C 210 (audits) and AR-C 90
 * (reviews) require the terms of EACH engagement — entity, statements and period,
 * framework, fee — to be agreed before work begins. So an attest packet without a
 * complete Addendum is not merely untidy: the engagement is not properly agreed.
 *
 * The database CHECK already makes an incomplete Addendum unstorable. This refuses
 * the packet when there is NO Addendum, and names which engagement is missing one.
 */
export async function attestAddendumFor(
  app: FastifyInstance,
  contactId: string
): Promise<AttestAddendumSummary | null> {
  const { rows } = await app.db.query<{
    id: string; engagement_id: string; entity_name: string; engagement_type: string;
    statements_and_periods: string; reporting_framework: string; fee_basis: string;
    fee_fixed_cents: number | null; fee_hourly_rate_cents: number | null;
    estimated_hours: string | null; deposit_cents: number; expected_report_date: string;
  }>(
    `SELECT a.id, a.engagement_id, a.entity_name, a.engagement_type::text AS engagement_type,
            a.statements_and_periods, a.reporting_framework, a.fee_basis::text AS fee_basis,
            a.fee_fixed_cents, a.fee_hourly_rate_cents, a.estimated_hours, a.deposit_cents,
            to_char(a.expected_report_date, 'YYYY-MM-DD') AS expected_report_date
     FROM attest_addenda a
     JOIN engagements e ON e.id = a.engagement_id
     WHERE a.contact_id = $1 AND e.status IN ('draft', 'active', 'on_hold')
     ORDER BY a.created_at DESC LIMIT 1`,
    [contactId]
  );
  const a = rows[0];
  if (!a) return null;
  return {
    id: a.id,
    engagementId: a.engagement_id,
    entityName: a.entity_name,
    engagementType: a.engagement_type as AttestAddendumSummary['engagementType'],
    statementsAndPeriods: a.statements_and_periods,
    reportingFramework: a.reporting_framework,
    feeSummary:
      a.fee_basis === 'fixed'
        ? `${usd(a.fee_fixed_cents ?? 0)} fixed fee`
        : `${usd(a.fee_hourly_rate_cents ?? 0)} per hour, estimated ${a.estimated_hours} hours`,
    depositSummary: usd(a.deposit_cents),
    expectedReportDate: a.expected_report_date,
  };
}

/** Refuses when Schedule F is in the packet but no complete Addendum exists. */
export async function assertAttestAddendum(
  app: FastifyInstance,
  contactId: string,
  codes: string[]
): Promise<AttestAddendumSummary | null> {
  if (!codes.includes('F')) return null;
  const addendum = await attestAddendumFor(app, contactId);
  if (!addendum) {
    const eng = await app.db.query<{ id: string; title: string | null }>(
      `SELECT id, title FROM engagements
       WHERE contact_id = $1 AND service_line = 'attest' AND status IN ('draft', 'active', 'on_hold')
       ORDER BY created_at LIMIT 1`,
      [contactId]
    );
    const which = eng.rows[0] ? ` (engagement ${eng.rows[0].title ?? eng.rows[0].id})` : '';
    throw new AppError(
      409,
      'attest_addendum_required',
      `An attest engagement${which} needs its Engagement Addendum before the packet can be assembled — entity, statements and period, reporting framework, fee, and deposit. AU-C 210 / AR-C 90 require those terms to be agreed for each engagement, so Schedule F alone is not enough.`
    );
  }
  return addendum;
}

export interface PacketPreview extends ResolvedSchedules {
  masterKey: string;
  masterVersion: number;
  alreadySigned: boolean;
  /** Schedules already accepted, so a second packet only carries what is new. */
  alreadyAccepted: string[];
  newSchedules: string[];
  /** Present when Schedule F rides in this packet. */
  attestAddendum: AttestAddendumSummary | null;
}

export async function previewPacket(
  app: FastifyInstance,
  contactId: string,
  opts: { extraServiceLines?: ServiceLine[] } = {}
): Promise<PacketPreview> {
  const resolved = await resolveSchedules(app, contactId, opts);
  const master = await app.db.query<{ key: string; version: number }>(
    `SELECT key, version FROM templates WHERE kind = 'master' AND is_active AND NOT is_placeholder`
  );
  if (!master.rows[0]) {
    throw new AppError(
      409,
      'master_not_final',
      'No final Master Engagement Agreement is loaded. Legal text must be in place before anything can be papered.'
    );
  }

  // THE PLACEHOLDER GATE, EXTENDED TO SCHEDULES. Previously only the Master was
  // checked, so a packet could carry a schedule whose text was still under review
  // and a Master signature would record acceptance of it. Any schedule in the
  // packet must be final — this is what makes it safe to load Schedule F with its
  // flag still set while Brian confirms the attorney clearance.
  const draftSchedules = await app.db.query<{ schedule_code: string; name: string }>(
    `SELECT s.schedule_code, t.name
     FROM service_schedules s JOIN templates t ON t.key = s.template_key
     WHERE s.schedule_code = ANY($1) AND (t.is_placeholder OR NOT t.is_active)
     ORDER BY s.schedule_code`,
    [resolved.codes]
  );
  if (draftSchedules.rows.length > 0) {
    throw new AppError(
      409,
      'schedule_not_final',
      `Cannot assemble this packet: ${draftSchedules.rows
        .map((r) => `${r.name} (Schedule ${r.schedule_code})`)
        .join(', ')} is still flagged PLACEHOLDER. Final text must be in place in Admin → Templates before a client can be asked to accept it.`
    );
  }

  const attestAddendum = await assertAttestAddendum(app, contactId, resolved.codes);

  const signed = await app.db.query(
    `SELECT 1 FROM engagement_packets WHERE contact_id = $1 AND status = 'signed'`,
    [contactId]
  );
  const accepted = await app.db.query<{ schedule_code: string }>(
    `SELECT schedule_code FROM schedule_acceptances WHERE contact_id = $1`,
    [contactId]
  );
  const already = accepted.rows.map((r) => r.schedule_code);
  return {
    ...resolved,
    masterKey: master.rows[0].key,
    masterVersion: master.rows[0].version,
    alreadySigned: signed.rows.length > 0,
    alreadyAccepted: already,
    newSchedules: resolved.codes.filter((c) => !already.includes(c)),
    attestAddendum,
  };
}

/**
 * Build the packet for a FIRST signature: Master + every schedule the client's
 * services require, as one envelope. Refused if a Master is already signed —
 * later services go through `acceptScheduleInPortal`, per Master §1.
 */
export async function createPacket(
  app: FastifyInstance,
  contactId: string,
  actor: AuthedStaff,
  opts: { extraServiceLines?: ServiceLine[] } = {}
): Promise<{ packetId: string; scheduleCodes: string[]; masterKey: string }> {
  const preview = await previewPacket(app, contactId, opts);
  if (preview.alreadySigned) {
    throw new AppError(
      409,
      'master_already_signed',
      'This client has already signed the Master Engagement Agreement. Added services are accepted per-schedule in the portal — the Master is never re-executed.'
    );
  }
  if (preview.codes.length === 0) {
    throw new AppError(
      400,
      'no_services',
      'No services are configured for this client, so there is no schedule to attach. Create the engagement first.'
    );
  }

  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO engagement_packets
       (contact_id, master_template_key, master_version, schedule_codes,
        created_by_staff_id, attest_addendum_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      contactId, preview.masterKey, preview.masterVersion, preview.codes, actor.id,
      preview.attestAddendum?.id ?? null,
    ]
  );
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'packet.created', objectType: 'engagement_packet', objectId: rows[0]!.id,
    contactId,
    details: {
      schedules: preview.codes, reasons: preview.reasons, master_version: preview.masterVersion,
      attest_addendum_id: preview.attestAddendum?.id ?? null,
      attest_engagement_type: preview.attestAddendum?.engagementType ?? null,
    },
  });
  return { packetId: rows[0]!.id, scheduleCodes: preview.codes, masterKey: preview.masterKey };
}

/**
 * SEND A PACKET FOR PORTAL SIGNATURE — the permanent path (Brian's Option 2
 * decision, 2026-08-11). Docuseal self-hosted stays for Form 8879, where IRS Pub
 * 1345 requires KBA and the vendor's identity trail is the point; an engagement
 * packet needs no KBA and Master §4 already carries the client's E-SIGN/UETA
 * consent, so signing it in our own portal keeps every client document in-house.
 *
 * This deliberately does NOT create a signature envelope. The old Docuseal path
 * could not carry a generated document at all on community edition, and the static
 * all-in-one template it fell back on bundled schedules the client had not engaged
 * plus both §7216 consents.
 *
 * Order matters: the document is BUILT first, because building it applies the
 * placeholder gate to every schedule, refuses attest without an Addendum, and
 * refuses if a §7216 consent ever reached the signing document. Only then is the
 * client told it is waiting. A failed build sends nothing and marks nothing.
 */
export async function sendPacketForPortalSignature(
  app: FastifyInstance,
  packetId: string,
  actor: AuthedStaff,
  language: 'en' | 'es' = 'en'
): Promise<{
  packetId: string;
  scheduleCodes: string[];
  emailedTo: string;
  sections: Array<{ kind: string; code: string | null; templateKey: string; templateVersion: number }>;
  excludedConsents: string[];
}> {
  const { rows } = await app.db.query<{
    contact_id: string; status: string; schedule_codes: string[];
    first_name: string; email: string | null; language: 'en' | 'es';
  }>(
    `SELECT p.contact_id, p.status, p.schedule_codes, c.first_name, c.email, c.language
     FROM engagement_packets p JOIN contacts c ON c.id = p.contact_id
     WHERE p.id = $1`,
    [packetId]
  );
  const p = rows[0];
  if (!p) throw new AppError(404, 'not_found', 'Packet not found.');
  if (p.status === 'signed') throw new AppError(409, 'already_signed', 'This packet is already signed.');
  if (p.status === 'void') throw new AppError(409, 'packet_void', 'This packet was voided. Create a new one.');
  if (!p.email) {
    throw new AppError(400, 'no_email', 'This client has no email address, so the signing link cannot be sent.');
  }

  // Build first — this is where every gate fires.
  const { buildPacketDocument } = await import('./packet-document.ts');
  const doc = await buildPacketDocument(app, packetId, language);

  // The portal needs a session to sign, so the client must have portal access.
  const portalUser = await app.db.query(
    `SELECT 1 FROM portal_users WHERE contact_id = $1 AND is_active`,
    [p.contact_id]
  );
  if (portalUser.rows.length === 0) {
    throw new AppError(
      409,
      'no_portal_access',
      'This client has no portal access yet, and the agreement is signed in the portal. Grant access first — they will get a sign-in link with it.'
    );
  }

  const titles = doc.sections
    .filter((s) => s.kind === 'schedule')
    .map((s) => s.title)
    .join(', ');

  const { sendTemplatedEmail } = await import('../templates/service.ts');
  await sendTemplatedEmail(app, {
    to: p.email,
    templateKey: 'packet_ready_to_sign',
    // The CLIENT's language, not the staffer's. English controls until Brian
    // approves the translation, and renderTemplate falls back on its own.
    language: p.language,
    vars: {
      first_name: p.first_name,
      schedules: titles || 'your engagement',
      sign_link: `${app.config.PORTAL_BASE_URL}/sign`,
    },
    contactId: p.contact_id,
  });

  await markPacketSent(app, packetId);

  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'packet.sent', objectType: 'engagement_packet', objectId: packetId,
    contactId: p.contact_id,
    details: {
      method: 'portal_esign',
      schedules: p.schedule_codes,
      sections: doc.sections.map((s) => ({ kind: s.kind, code: s.code, key: s.templateKey, version: s.templateVersion })),
      excluded_consents: doc.deliberatelyExcluded.map((e) => e.templateKey),
    },
  });

  return {
    packetId,
    scheduleCodes: p.schedule_codes,
    emailedTo: p.email,
    sections: doc.sections.map((s) => ({
      kind: s.kind, code: s.code, templateKey: s.templateKey, templateVersion: s.templateVersion,
    })),
    excludedConsents: doc.deliberatelyExcluded.map((e) => e.templateKey),
  };
}

/**
 * RETAINED FOR THE DOCUSEAL PATH ONLY — no longer used by engagement packets.
 * Kept because a historical packet may still carry an envelope_id from before the
 * portal-native decision, and the completion webhook reads it.
 */
export async function envelopeForPacket(
  app: FastifyInstance,
  packetId: string,
  actor: AuthedStaff
): Promise<{ envelopeId: string; contactId: string; reused: boolean }> {
  const { rows } = await app.db.query<{
    contact_id: string; envelope_id: string | null; status: string; master_template_key: string;
  }>(
    `SELECT contact_id, envelope_id, status, master_template_key
     FROM engagement_packets WHERE id = $1`,
    [packetId]
  );
  const p = rows[0];
  if (!p) throw new AppError(404, 'not_found', 'Packet not found.');
  if (p.status === 'signed') throw new AppError(409, 'already_signed', 'This packet is already signed.');
  if (p.status === 'void') throw new AppError(409, 'packet_void', 'This packet was voided. Create a new one.');
  if (p.envelope_id) return { envelopeId: p.envelope_id, contactId: p.contact_id, reused: true };

  // NO docusealTemplateId, ever. The document is generated by SAOS; marking the
  // envelope is_packet_envelope makes pointing it at a Docuseal template
  // unrepresentable (CHECK signature_envelopes_packet_never_templated).
  const { createEnvelope } = await import('../signatures/service.ts');
  const env = await createEnvelope(app, { type: 'staff', id: actor.id, label: actor.email }, {
    contactId: p.contact_id,
    type: 'engagement_letter',
    templateKey: p.master_template_key,
  });
  await app.db.query(
    `UPDATE signature_envelopes SET is_packet_envelope = true WHERE id = $1`,
    [env.id]
  );
  await app.db.query(`UPDATE engagement_packets SET envelope_id = $2 WHERE id = $1`, [packetId, env.id]);
  return { envelopeId: env.id, contactId: p.contact_id, reused: false };
}

/** Mark a packet sent. Called only after the envelope actually reached Docuseal. */
export async function markPacketSent(app: FastifyInstance, packetId: string): Promise<void> {
  await app.db.query(
    `UPDATE engagement_packets SET status = 'sent', sent_at = COALESCE(sent_at, now())
     WHERE id = $1 AND status = 'draft'`,
    [packetId]
  );
}

/**
 * Record the Master signature. ONE signature accepts the Master and every schedule
 * in the packet — so this writes one acceptance row per schedule, each marked
 * `master_signature` and pointing at the packet that carried it.
 */
export async function recordMasterSignature(
  app: FastifyInstance,
  packetId: string,
  meta: {
    ip?: string | null;
    userAgent?: string | null;
    /**
     * HOW it was signed, stamped in the same statement that marks it signed.
     * A signed packet must always say which path produced the signature
     * (CHECK engagement_packets_signed_has_method), so this cannot be a
     * follow-up write that might not happen.
     */
    method?: 'portal_esign' | 'docuseal' | undefined;
  } = {}
): Promise<{ contactId: string; accepted: string[] }> {
  const { rows } = await app.db.query<{
    contact_id: string; schedule_codes: string[]; status: string; master_version: number;
  }>(
    `SELECT contact_id, schedule_codes, status, master_version FROM engagement_packets WHERE id = $1`,
    [packetId]
  );
  const p = rows[0];
  if (!p) throw new AppError(404, 'not_found', 'Packet not found.');
  if (p.status === 'signed') throw new AppError(409, 'already_signed', 'This packet is already signed.');

  await app.db.query(
    `UPDATE engagement_packets
     SET status = 'signed', signed_at = now(), signature_method = $2
     WHERE id = $1`,
    [packetId, meta.method ?? 'docuseal']
  );

  for (const code of p.schedule_codes) {
    const tpl = await app.db.query<{ version: number }>(
      `SELECT t.version FROM templates t
       JOIN service_schedules s ON s.template_key = t.key
       WHERE s.schedule_code = $1`,
      [code]
    );
    await app.db.query(
      `INSERT INTO schedule_acceptances
         (contact_id, schedule_code, via, packet_id, template_version, ip, user_agent)
       VALUES ($1, $2, 'master_signature', $3, $4, $5, $6)
       ON CONFLICT (contact_id, schedule_code) DO NOTHING`,
      [p.contact_id, code, packetId, tpl.rows[0]?.version ?? 1, meta.ip ?? null, meta.userAgent ?? null]
    );
  }

  // The old single flag stays in step, so every existing gate keeps working.
  await app.db.query(
    `UPDATE contacts SET engagement_letter_status = 'signed' WHERE id = $1`,
    [p.contact_id]
  );
  await writeAudit(app.db, {
    actorType: 'client', actorId: p.contact_id, actorLabel: 'master signature',
    action: 'packet.signed', objectType: 'engagement_packet', objectId: packetId,
    contactId: p.contact_id,
    details: { schedules: p.schedule_codes, master_version: p.master_version, ...meta },
  });
  // #42: signing the Master is one half of "active" — the lifecycle asks the record
  // for the other half (an open engagement) rather than assuming it.
  const { refreshContactStatus } = await import('../crm/lifecycle.ts');
  await refreshContactStatus(app, p.contact_id, 'master_signed');
  return { contactId: p.contact_id, accepted: p.schedule_codes };
}

/**
 * A later-added service, accepted per-schedule in the portal. No re-execution of
 * the Master — but the Master must already be signed, because the schedule
 * incorporates it.
 */
export async function acceptScheduleInPortal(
  app: FastifyInstance,
  contactId: string,
  scheduleCode: string,
  meta: { ip?: string | null; userAgent?: string | null } = {}
): Promise<{ accepted: boolean; alreadyAccepted: boolean }> {
  const signed = await app.db.query(
    `SELECT 1 FROM engagement_packets WHERE contact_id = $1 AND status = 'signed'`,
    [contactId]
  );
  if (signed.rows.length === 0) {
    throw new AppError(
      409,
      'master_not_signed',
      'Each Schedule incorporates the Master Engagement Agreement, so the Master must be signed first.'
    );
  }
  const tpl = await app.db.query<{ version: number }>(
    `SELECT t.version FROM templates t
     JOIN service_schedules s ON s.template_key = t.key
     WHERE s.schedule_code = $1 AND t.is_active AND NOT t.is_placeholder`,
    [scheduleCode]
  );
  if (!tpl.rows[0]) throw new AppError(404, 'schedule_not_found', `No active Schedule ${scheduleCode}.`);

  const existing = await app.db.query(
    `SELECT 1 FROM schedule_acceptances WHERE contact_id = $1 AND schedule_code = $2`,
    [contactId, scheduleCode]
  );
  if (existing.rows.length > 0) return { accepted: true, alreadyAccepted: true };

  await app.db.query(
    `INSERT INTO schedule_acceptances
       (contact_id, schedule_code, via, template_version, ip, user_agent)
     VALUES ($1, $2, 'portal_acceptance', $3, $4, $5)`,
    [contactId, scheduleCode, tpl.rows[0].version, meta.ip ?? null, meta.userAgent ?? null]
  );
  await writeAudit(app.db, {
    actorType: 'client', actorId: contactId, actorLabel: 'portal acceptance',
    action: 'schedule.accepted', objectType: 'contact', objectId: contactId, contactId,
    details: { schedule_code: scheduleCode, via: 'portal_acceptance', template_version: tpl.rows[0].version, ...meta },
  });
  return { accepted: true, alreadyAccepted: false };
}

/**
 * The Master rendered with its one variable filled — "Service Schedules attached
 * at signing: A, C". The list is not decoration: it is the sentence that defines
 * what the single signature covered, so it comes from the packet's own
 * schedule_codes and never from a caller's guess.
 */
export async function renderMasterForPacket(
  app: FastifyInstance,
  packetId: string,
  language: 'en' | 'es' = 'en'
): Promise<{ body: string; scheduleCodes: string[]; titles: Record<string, string> }> {
  const { rows } = await app.db.query<{ master_template_key: string; schedule_codes: string[] }>(
    `SELECT master_template_key, schedule_codes FROM engagement_packets WHERE id = $1`,
    [packetId]
  );
  const p = rows[0];
  if (!p) throw new AppError(404, 'not_found', 'Packet not found.');

  const titleRows = await app.db.query<{ schedule_code: string; title: string }>(
    `SELECT schedule_code, title FROM service_schedules WHERE schedule_code = ANY($1) ORDER BY sort_order`,
    [p.schedule_codes]
  );
  const titles: Record<string, string> = {};
  for (const r of titleRows.rows) titles[r.schedule_code] = r.title;

  const { renderTemplate } = await import('../templates/service.ts');
  const rendered = await renderTemplate(app, p.master_template_key, language, {
    /*
     * FINDING #20 — the title ALREADY carries the code.
     *
     * This composed `${code} — ${title}`, and every title is stored as "Schedule A —
     * Individual Tax", so the signed Master read "Service Schedules attached at signing:
     * A — Schedule A — Individual Tax; C — Schedule C — Bookkeeping…". The client's own
     * agreement stuttered its way through the list of what they were agreeing to.
     *
     * The title is the label; the code is part of it. Prefixing it again was composing a
     * name out of a name.
     */
    schedules_attached: titleRows.rows.map((r) => r.title).join('; '),
  });
  // WET-SIGNATURE LINES DROPPED (Brian, 2026-08-13). This packet is signed in the
  // portal by typing a name and tapping a button; ruled lines reading
  // "Client signature: ______" tell the reader to look for a pen and imply the tap was
  // not the signature. Stripped at render, not removed from the template, because the
  // paper lane still exists for older filing years.
  return {
    body: stripWetSignatureLines(rendered.body),
    scheduleCodes: p.schedule_codes,
    titles,
  };
}

/**
 * Schedule F rendered with its Addendum filled in. The Addendum's blanks are the
 * agreed terms, so they are filled from `attest_addenda` — never left as blanks on
 * a document a client is asked to accept.
 */
export async function renderScheduleF(
  app: FastifyInstance,
  contactId: string,
  language: 'en' | 'es' = 'en'
): Promise<{ body: string; addendum: AttestAddendumSummary }> {
  const addendum = await attestAddendumFor(app, contactId);
  if (!addendum) {
    throw new AppError(409, 'attest_addendum_required', 'No attest Addendum on file for this client.');
  }
  const key = await app.db.query<{ template_key: string }>(
    `SELECT template_key FROM service_schedules WHERE schedule_code = 'F'`
  );
  if (!key.rows[0]) throw new AppError(500, 'schedule_f_missing', 'Schedule F is not mapped.');

  const { renderTemplate } = await import('../templates/service.ts');
  const rendered = await renderTemplate(app, key.rows[0].template_key, language, {
    entity_name: addendum.entityName,
    engagement_type: ATTEST_TYPE_LABEL[addendum.engagementType] ?? addendum.engagementType,
    statements_and_periods: addendum.statementsAndPeriods,
    reporting_framework: addendum.reportingFramework,
    fee_summary: addendum.feeSummary,
    deposit_summary: addendum.depositSummary,
    expected_report_date: addendum.expectedReportDate,
  });
  return { body: rendered.body, addendum };
}

/**
 * Which schedules a client still needs to accept — what the portal shows as
 * "one more thing to agree to" when a service is added after signing.
 */
export async function pendingSchedules(app: FastifyInstance, contactId: string) {
  const preview = await previewPacket(app, contactId);

  /**
   * FINDING #8. "Pending" means ADDED AFTER SIGNING — a schedule that needs its own
   * portal acceptance because the Master signature did not cover it. It does NOT mean
   * "not yet accepted".
   *
   * Before the Master is signed nothing is accepted yet, so every attached schedule
   * looked pending: the portal offered Schedule A as "a service we added since then",
   * under copy asserting the Master was already signed, with an accept button that
   * acceptScheduleInPortal would then refuse as master_not_signed. A dead end built
   * out of a true-but-wrong query.
   *
   * Until the Master is signed, the packet panel owns that conversation entirely.
   */
  const pending = preview.alreadySigned ? preview.newSchedules : [];
  const rows = await app.db.query<{ schedule_code: string; title: string; body_en: string }>(
    `SELECT s.schedule_code, s.title, t.body_en
     FROM service_schedules s JOIN templates t ON t.key = s.template_key
     WHERE s.schedule_code = ANY($1) AND t.is_active AND NOT t.is_placeholder
     ORDER BY s.sort_order`,
    [pending]
  );
  return {
    masterSigned: preview.alreadySigned,
    accepted: preview.alreadyAccepted,
    pending: rows.rows,
  };
}
