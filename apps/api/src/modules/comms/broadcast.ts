// Client announcements / broadcast (M27, v4.4).
//
// CLAUDE.md, non-negotiable: every announcement email carries CAN-SPAM
// unsubscribe; every broadcast SMS respects TCPA opt-out; suppression is
// enforced AT SEND TIME; every broadcast is approval-gated and nothing bulk
// sends itself.
//
// How each of those is made structural rather than intentional:
//
//  · APPROVAL — `sendBroadcast` refuses any status but 'approved', and the table
//    carries a CHECK that a row cannot reach 'sent' without a named approver.
//    Even a direct SQL update cannot produce an unapproved send.
//  · UNSUBSCRIBE — the footer is appended by THIS function, not by the template.
//    An admin editing announcement copy cannot delete the unsubscribe line,
//    because they never had it. A body arriving with its own {{unsubscribe}}
//    token is honoured; a body without one still gets the footer.
//  · SUPPRESSION AT SEND — the recipient list is resolved and each contact
//    re-checked at the moment of sending, not when the broadcast was drafted.
//    Someone who opts out during the approval wait is not sent to.
//  · MARKETING ≠ TRANSACTIONAL — opting out of firm news never stops "your
//    return is ready". That is a different gate, deliberately.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError, type AuthedStaff } from '../../types.ts';
import { sendSms } from './send-sms.ts';

export type BroadcastChannel = 'email' | 'sms' | 'both';

export interface Segment {
  /** 'all' | soto_status value */
  sotoStatus?: 'active' | 'lead' | 'former' | undefined;
  serviceLine?: string | undefined;
  language?: 'en' | 'es' | undefined;
  /** Only contacts with a portal account. */
  portalOnly?: boolean | undefined;
}

// ---------------------------------------------------------------- unsubscribe

/**
 * Stable per-contact unsubscribe token: HMAC of the id keyed by the app
 * encryption key. Stable for as long as the key is (CAN-SPAM wants the link
 * live for at least 30 days after a send), verifiable without a lookup, and
 * nothing extra stored.
 */
export function unsubToken(app: FastifyInstance, contactId: string): string {
  return createHmac('sha256', app.config.APP_ENCRYPTION_KEY)
    .update(`unsub:${contactId}`)
    .digest('base64url');
}

export function verifyUnsubToken(app: FastifyInstance, contactId: string, token: string): boolean {
  const expected = Buffer.from(unsubToken(app, contactId));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function unsubUrl(app: FastifyInstance, contactId: string): string {
  return `${app.config.PORTAL_BASE_URL}/unsubscribe/${contactId}/${unsubToken(app, contactId)}`;
}

const FOOTER_EN = (url: string) =>
  `\n\n—\nYou're receiving this because you work with Soto Accounting. ` +
  `To stop receiving firm announcements, unsubscribe here: ${url}\n` +
  `This won't affect messages about your own work — returns, invoices, and document requests still reach you.\n` +
  `Soto Accounting LLC · Chicago, IL`;

const FOOTER_ES = (url: string) =>
  `\n\n—\nRecibe esto porque trabaja con Soto Accounting. ` +
  `Para dejar de recibir anuncios de la firma, cancele su suscripción aquí: ${url}\n` +
  `Esto no afecta los mensajes sobre su propio trabajo — declaraciones, facturas y solicitudes de documentos seguirán llegando.\n` +
  `Soto Accounting LLC · Chicago, IL`;

/** TCPA: every broadcast SMS states how to stop. Appended here, not authored. */
const SMS_OPT_OUT_EN = ' Reply STOP to opt out.';
const SMS_OPT_OUT_ES = ' Responda STOP para no recibir más.';

// ------------------------------------------------------------------- segments

function segmentSql(segment: Segment): { where: string; params: unknown[] } {
  // NOT c.is_test is not negotiable and is not a segment option: a rehearsal or
  // test client must never be able to receive a real announcement, whatever
  // segment someone builds. This is the single place every broadcast audience is
  // resolved, which is why the rule lives here rather than in each caller.
  const clauses = ['NOT c.is_archived', 'NOT c.is_test'];
  const params: unknown[] = [];
  if (segment.sotoStatus) {
    params.push(segment.sotoStatus);
    clauses.push(`c.soto_status = $${params.length}::soto_status`);
  }
  if (segment.language) {
    params.push(segment.language);
    clauses.push(`c.language = $${params.length}`);
  }
  if (segment.serviceLine) {
    params.push(segment.serviceLine);
    clauses.push(
      `EXISTS (SELECT 1 FROM engagements e WHERE e.contact_id = c.id
               AND e.status = 'active' AND e.service_line = $${params.length}::service_line)`
    );
  }
  if (segment.portalOnly) {
    clauses.push(`EXISTS (SELECT 1 FROM portal_users pu WHERE pu.contact_id = c.id)`);
  }
  return { where: clauses.join(' AND '), params };
}

export interface AudiencePreview {
  intended: number;
  emailable: number;
  smsable: number;
  suppressed: Array<{ reason: string; count: number }>;
}

/**
 * Who would this reach, and who would be suppressed. Run before approval so the
 * suppression is visible to the person approving, not discovered afterwards.
 */
export async function previewAudience(
  app: FastifyInstance,
  segment: Segment,
  channel: BroadcastChannel
): Promise<AudiencePreview> {
  const { where, params } = segmentSql(segment);
  const { rows } = await app.db.query<{
    total: number; opted_out: number; no_email: number; emailable: number;
    no_sms_consent: number; no_phone: number; smsable: number;
  }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE c.broadcast_opt_out_at IS NOT NULL)::int AS opted_out,
            count(*) FILTER (WHERE c.broadcast_opt_out_at IS NULL AND c.email IS NULL)::int AS no_email,
            count(*) FILTER (WHERE c.broadcast_opt_out_at IS NULL AND c.email IS NOT NULL)::int AS emailable,
            count(*) FILTER (WHERE c.broadcast_opt_out_at IS NULL AND NOT c.sms_consent)::int AS no_sms_consent,
            count(*) FILTER (WHERE c.broadcast_opt_out_at IS NULL AND c.sms_consent AND c.phone IS NULL)::int AS no_phone,
            count(*) FILTER (WHERE c.broadcast_opt_out_at IS NULL AND c.sms_consent AND c.phone IS NOT NULL)::int AS smsable
     FROM contacts c WHERE ${where}`,
    params
  );
  const r = rows[0]!;
  const suppressed: AudiencePreview['suppressed'] = [];
  if (r.opted_out > 0) suppressed.push({ reason: 'opted out of announcements', count: r.opted_out });
  if (channel !== 'sms' && r.no_email > 0) suppressed.push({ reason: 'no email address', count: r.no_email });
  if (channel !== 'email') {
    if (r.no_sms_consent > 0) suppressed.push({ reason: 'no SMS consent (TCPA)', count: r.no_sms_consent });
    if (r.no_phone > 0) suppressed.push({ reason: 'no phone number', count: r.no_phone });
  }
  return {
    intended: r.total,
    emailable: channel === 'sms' ? 0 : r.emailable,
    smsable: channel === 'email' ? 0 : r.smsable,
    suppressed,
  };
}

// ------------------------------------------------------------------ lifecycle

export interface CreateBroadcastInput {
  name: string;
  channel: BroadcastChannel;
  segment: Segment;
  subjectEn?: string | undefined;
  subjectEs?: string | undefined;
  bodyEn: string;
  bodyEs: string;
  smsEn?: string | undefined;
  smsEs?: string | undefined;
}

export async function createBroadcast(
  app: FastifyInstance,
  input: CreateBroadcastInput,
  actor: AuthedStaff
): Promise<{ id: string; preview: AudiencePreview }> {
  if (input.channel !== 'sms' && (!input.subjectEn || !input.subjectEs)) {
    throw new AppError(400, 'subject_required', 'An email announcement needs a subject in both languages.');
  }
  if (input.channel !== 'email' && (!input.smsEn || !input.smsEs)) {
    throw new AppError(400, 'sms_body_required', 'An SMS announcement needs text in both languages.');
  }
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO broadcasts (name, channel, segment, subject_en, subject_es, body_en, body_es,
                             sms_en, sms_es, created_by_staff_id)
     VALUES ($1,$2::broadcast_channel,$3::jsonb,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      input.name, input.channel, JSON.stringify(input.segment),
      input.subjectEn ?? null, input.subjectEs ?? null, input.bodyEn, input.bodyEs,
      input.smsEn ?? null, input.smsEs ?? null, actor.id,
    ]
  );
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'broadcast.created', objectType: 'broadcast', objectId: rows[0]!.id,
    details: { name: input.name, channel: input.channel, segment: input.segment },
  });
  return { id: rows[0]!.id, preview: await previewAudience(app, input.segment, input.channel) };
}

export async function submitForApproval(
  app: FastifyInstance,
  broadcastId: string,
  actor: AuthedStaff
): Promise<void> {
  const { rowCount } = await app.db.query(
    `UPDATE broadcasts SET status = 'pending_approval' WHERE id = $1 AND status = 'draft'`,
    [broadcastId]
  );
  if (rowCount === 0) throw new AppError(409, 'not_draft', 'Only a draft can be submitted for approval.');
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'broadcast.submitted', objectType: 'broadcast', objectId: broadcastId,
  });
}

/**
 * Approve. Deliberately a SEPARATE ACT from sending, and deliberately not
 * something the author can do to their own broadcast — a bulk client send should
 * pass a second pair of eyes.
 */
export async function approveBroadcast(
  app: FastifyInstance,
  broadcastId: string,
  actor: AuthedStaff
): Promise<void> {
  const { rows } = await app.db.query<{ status: string; created_by_staff_id: string | null }>(
    `SELECT status::text, created_by_staff_id FROM broadcasts WHERE id = $1`,
    [broadcastId]
  );
  const b = rows[0];
  if (!b) throw new AppError(404, 'not_found', 'Broadcast not found.');
  if (b.status !== 'pending_approval') {
    throw new AppError(409, 'not_pending', `Broadcast is '${b.status}', not awaiting approval.`);
  }
  if (b.created_by_staff_id === actor.id) {
    throw new AppError(
      409,
      'self_approval',
      'A broadcast needs a second pair of eyes — someone other than its author must approve it.'
    );
  }
  await app.db.query(
    `UPDATE broadcasts SET status = 'approved', approved_by_staff_id = $2, approved_at = now() WHERE id = $1`,
    [broadcastId, actor.id]
  );
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'broadcast.approved', objectType: 'broadcast', objectId: broadcastId,
  });
}

export interface SendResult {
  sentEmail: number;
  sentSms: number;
  suppressed: number;
  suppressedByReason: Record<string, number>;
}

/**
 * Send. Suppression is evaluated HERE, per contact, at this moment — not when
 * the broadcast was drafted or approved.
 */
export async function sendBroadcast(
  app: FastifyInstance,
  broadcastId: string,
  actor: AuthedStaff
): Promise<SendResult> {
  const { rows } = await app.db.query<{
    status: string; channel: BroadcastChannel; segment: Segment;
    subject_en: string | null; subject_es: string | null;
    body_en: string; body_es: string; sms_en: string | null; sms_es: string | null;
  }>(
    `SELECT status::text, channel, segment, subject_en, subject_es, body_en, body_es, sms_en, sms_es
     FROM broadcasts WHERE id = $1`,
    [broadcastId]
  );
  const b = rows[0];
  if (!b) throw new AppError(404, 'not_found', 'Broadcast not found.');
  if (b.status !== 'approved') {
    throw new AppError(
      409,
      'not_approved',
      `A broadcast must be approved before it can send. This one is '${b.status}'.`
    );
  }

  const { where, params } = segmentSql(b.segment);
  const audience = await app.db.query<{
    id: string; first_name: string; email: string | null; phone: string | null;
    language: 'en' | 'es'; sms_consent: boolean; broadcast_opt_out_at: Date | null;
  }>(
    `SELECT c.id, c.first_name, c.email, c.phone, c.language, c.sms_consent, c.broadcast_opt_out_at
     FROM contacts c WHERE ${where}`,
    params
  );

  await app.db.query(`UPDATE broadcasts SET status = 'sending', intended_count = $2 WHERE id = $1`, [
    broadcastId, audience.rows.length,
  ]);

  const result: SendResult = { sentEmail: 0, sentSms: 0, suppressed: 0, suppressedByReason: {} };
  const suppress = async (contactId: string, channel: 'email' | 'sms', reason: string) => {
    await app.db.query(
      `INSERT INTO broadcast_recipients (broadcast_id, contact_id, channel, suppressed_reason)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [broadcastId, contactId, channel, reason]
    );
    result.suppressed += 1;
    result.suppressedByReason[reason] = (result.suppressedByReason[reason] ?? 0) + 1;
  };

  for (const c of audience.rows) {
    const optedOut = c.broadcast_opt_out_at !== null;
    const es = c.language === 'es';

    if (b.channel !== 'sms') {
      if (optedOut) {
        await suppress(c.id, 'email', 'opted out of announcements');
      } else if (!c.email) {
        await suppress(c.id, 'email', 'no email address');
      } else {
        // The unsubscribe footer is appended HERE. Admin-edited copy cannot
        // remove what it never contained.
        const url = unsubUrl(app, c.id);
        const body =
          (es ? b.body_es : b.body_en).replaceAll('{{first_name}}', c.first_name) +
          (es ? FOOTER_ES(url) : FOOTER_EN(url));
        await app.mailer.send({
          to: c.email,
          subject: (es ? b.subject_es : b.subject_en) ?? 'Soto Accounting',
          text: body,
        });
        await app.db.query(
          `INSERT INTO broadcast_recipients (broadcast_id, contact_id, channel, sent_at)
           VALUES ($1,$2,'email',now()) ON CONFLICT DO NOTHING`,
          [broadcastId, c.id]
        );
        result.sentEmail += 1;
      }
    }

    if (b.channel !== 'email') {
      if (optedOut) {
        await suppress(c.id, 'sms', 'opted out of announcements');
      } else {
        const text = (es ? b.sms_es : b.sms_en) ?? '';
        // sendSms is the absolute TCPA gate (consent + phone). Broadcast text
        // additionally carries the STOP line.
        const sent = await sendSms(app, {
          contactId: c.id,
          templateKey: `broadcast:${broadcastId}`, // labels the message row; copy comes from the override
          language: c.language,
          vars: { first_name: c.first_name },
          bodyOverride: text + (es ? SMS_OPT_OUT_ES : SMS_OPT_OUT_EN),
        });
        if (sent.sent) {
          await app.db.query(
            `INSERT INTO broadcast_recipients (broadcast_id, contact_id, channel, sent_at)
             VALUES ($1,$2,'sms',now()) ON CONFLICT DO NOTHING`,
            [broadcastId, c.id]
          );
          result.sentSms += 1;
        } else {
          await suppress(c.id, 'sms', sent.reason ?? 'sms unavailable');
        }
      }
    }
  }

  await app.db.query(
    `UPDATE broadcasts SET status = 'sent', sent_at = now(), sent_count = $2, suppressed_count = $3
     WHERE id = $1`,
    [broadcastId, result.sentEmail + result.sentSms, result.suppressed]
  );
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'broadcast.sent', objectType: 'broadcast', objectId: broadcastId,
    details: {
      intended: audience.rows.length,
      sent_email: result.sentEmail,
      sent_sms: result.sentSms,
      suppressed: result.suppressed,
      suppressed_by_reason: result.suppressedByReason,
    },
  });
  return result;
}

/** Client-side opt-out. No session — the HMAC in the link is the credential. */
export async function optOutOfBroadcasts(
  app: FastifyInstance,
  contactId: string,
  token: string,
  source: string
): Promise<{ optedOut: true }> {
  if (!verifyUnsubToken(app, contactId, token)) {
    throw new AppError(404, 'not_found', 'This unsubscribe link is not valid.');
  }
  await app.db.query(
    `UPDATE contacts
     SET broadcast_opt_out_at = COALESCE(broadcast_opt_out_at, now()), broadcast_opt_out_source = $2
     WHERE id = $1`,
    [contactId, source]
  );
  await writeAudit(app.db, {
    actorType: 'client', actorId: contactId, actorLabel: 'unsubscribe link',
    action: 'broadcast.opted_out', objectType: 'contact', objectId: contactId, contactId,
    details: { source },
  });
  return { optedOut: true };
}

/** Staff-side resubscribe, only ever at the client's request. */
export async function resubscribeToBroadcasts(
  app: FastifyInstance,
  contactId: string,
  actor: AuthedStaff,
  note: string
): Promise<void> {
  await app.db.query(
    `UPDATE contacts SET broadcast_opt_out_at = NULL, broadcast_opt_out_source = NULL WHERE id = $1`,
    [contactId]
  );
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'broadcast.resubscribed', objectType: 'contact', objectId: contactId, contactId,
    details: { note },
  });
}
