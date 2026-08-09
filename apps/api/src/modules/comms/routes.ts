// Comms webhooks (launch gate, 2026-07-06): Twilio inbound SMS/voice on the
// firm's texting number + the SES bounce/complaint feed via SNS. See
// twilio.ts / ses-sns.ts for the authentication mechanics.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../audit.ts';
import { isAutomationEnabled } from '../../automations.ts';
import { AppError } from '../../types.ts';
import { requirePermission } from '../../plugins/auth.ts';
import { firstActiveByRole, notifyOnce } from '../../staffing.ts';
import { createTask } from '../tasks/service.ts';
import { handleMailBounce } from '../portal-auth/service.ts';
import { makeMinioClient } from '../documents/storage.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { discardAttachment, fileAttachment, ingestInboundAttachment, reassignAttachment } from './attachments.ts';
import { escapeXml, isStopMessage, parseFormBody, validateTwilioSignature } from './twilio.ts';
import { sendSms } from './send-sms.ts';
import { isAmazonSnsUrl, parseSesFeedback, snsHttp, verifySnsSignature, type SnsMessage } from './ses-sns.ts';

const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

/** Contact whose phone (either slot) ends with the same 10 digits. */
async function contactByPhone(app: FastifyInstance, raw: string) {
  const digits = raw.replace(/\D/g, '');
  const last10 = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (last10.length < 7) return null;
  const { rows } = await app.db.query<{ id: string; first_name: string; last_name: string; language: 'en' | 'es' }>(
    `SELECT id, first_name, last_name, language FROM contacts
     WHERE right(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = $1
        OR right(regexp_replace(COALESCE(secondary_phone, ''), '\\D', '', 'g'), 10) = $1
     ORDER BY updated_at DESC LIMIT 1`,
    [last10]
  );
  return rows[0] ?? null;
}

function twilioGuard(app: FastifyInstance, path: string) {
  return (request: FastifyRequest, reply: FastifyReply): Record<string, string> | null => {
    const token = app.config.TWILIO_AUTH_TOKEN;
    if (!token) {
      void reply.code(503).send({ error: 'twilio_not_configured' });
      return null;
    }
    const raw = typeof request.body === 'string' ? request.body : '';
    const params = parseFormBody(raw);
    const url = `${app.config.API_PUBLIC_URL}${path}`;
    const signature = request.headers['x-twilio-signature'];
    if (!validateTwilioSignature(token, url, params, typeof signature === 'string' ? signature : undefined)) {
      void reply.code(401).send({ error: 'unauthorized' });
      return null;
    }
    return params;
  };
}

export function registerCommsRoutes(app: FastifyInstance): void {
  // ── Twilio: inbound SMS ────────────────────────────────────────────────────
  const smsGuard = twilioGuard(app, '/webhooks/twilio/sms');
  app.post('/webhooks/twilio/sms', async (request, reply) => {
    const params = smsGuard(request, reply);
    if (!params) return reply;

    const from = params['From'] ?? '';
    const body = params['Body'] ?? '';
    const messageSid = params['MessageSid'] ?? `unknown-${Date.now()}`;
    const contact = await contactByPhone(app, from);
    const stop = isStopMessage(params);

    if (contact) {
      // One conversation history per client (MP): the text lands in their thread.
      const thread = await app.db.query<{ id: string }>(
        `INSERT INTO message_threads (contact_id, subject, last_message_at)
         SELECT $1, 'Text messages', now()
         WHERE NOT EXISTS (SELECT 1 FROM message_threads WHERE contact_id = $1 AND status = 'open')
         RETURNING id`,
        [contact.id]
      );
      const threadId =
        thread.rows[0]?.id ??
        (await app.db.query<{ id: string }>(
          `SELECT id FROM message_threads WHERE contact_id = $1 AND status = 'open' ORDER BY created_at LIMIT 1`,
          [contact.id]
        )).rows[0]!.id;
      await app.db.query(
        `INSERT INTO messages (thread_id, direction, channel, sender_type, body, external_ref)
         VALUES ($1, 'inbound', 'sms', 'client', $2, $3)`,
        [threadId, body, messageSid]
      );
      await app.db.query(`UPDATE message_threads SET last_message_at = now() WHERE id = $1`, [threadId]);
    }

    if (stop && contact) {
      // TCPA: revoke on our side too — Twilio's keyword handling only stops
      // the carrier route; this stops every SAOS send path.
      await app.db.query(`UPDATE contacts SET sms_consent = false WHERE id = $1`, [contact.id]);
      await app.db.query(
        `INSERT INTO consents (contact_id, type, status, policy_version, revoked_at)
         VALUES ($1, 'sms', 'revoked', 'sms-stop-keyword', now())`,
        [contact.id]
      );
      await writeAudit(app.db, {
        actorType: 'client', actorId: contact.id, actorLabel: `${contact.first_name} ${contact.last_name}`,
        action: 'sms.consent_revoked', objectType: 'contact', objectId: contact.id, contactId: contact.id,
        details: { via: 'stop_keyword', message_sid: messageSid },
      });
    }

    const rene = await firstActiveByRole(app.db, 'comms_billing');
    if (rene) {
      await notifyOnce(app.db, {
        staffId: rene,
        type: stop ? 'sms_opt_out' : 'sms_received',
        severity: 'info',
        title: contact
          ? `${stop ? 'SMS opt-out' : 'Text message'} from ${contact.first_name} ${contact.last_name}`
          : `Text message from an unrecognized number (${from})`,
        body: contact ? null : 'Number matched no contact — check the message log and follow up manually.',
        contactId: contact?.id ?? null,
        relatedObjectType: 'sms',
        relatedObjectId: messageSid,
      });
      // M25: an UNMATCHED text is a phone ticket — nobody owns the thread,
      // so someone must own the follow-up (v4.4 "Rene's phone tickets").
      if (!contact && !stop) {
        await createTask(app, {
          title: `Phone ticket: text from unrecognized number ${from}`,
          description: 'Match the number to a contact (or create one), then reply. Message body is in the SMS log.',
          assignedStaffId: rene,
          priority: 1,
          source: 'automation',
          sourceType: 'sms_unmatched',
          sourceId: messageSid,
        });
      }
    }

    // MMS attachments: ACCEPT, NEVER REJECT (decided 2026-08-09). Each media
    // item is scanned + quarantined on the thread; the sender gets a warm ack
    // pointing at the secure upload link for next time (block-and-nudge —
    // documents still never travel by SMS into client folders directly).
    const numMedia = Number(params['NumMedia'] ?? '0');
    if (numMedia > 0) {
      const threadRow = contact
        ? await app.db.query<{ id: string }>(
            `SELECT id FROM message_threads WHERE contact_id = $1 AND status = 'open' ORDER BY created_at LIMIT 1`,
            [contact.id]
          )
        : null;
      for (let i = 0; i < Math.min(numMedia, 10); i++) {
        const url = params[`MediaUrl${i}`];
        const mime = params[`MediaContentType${i}`] ?? 'application/octet-stream';
        if (!url) continue;
        try {
          const auth =
            app.config.TWILIO_ACCOUNT_SID && app.config.TWILIO_AUTH_TOKEN
              ? { Authorization: `Basic ${Buffer.from(`${app.config.TWILIO_ACCOUNT_SID}:${app.config.TWILIO_AUTH_TOKEN}`).toString('base64')}` }
              : undefined;
          const media = await fetch(url, auth ? { headers: auth } : undefined);
          if (!media.ok) throw new Error(`media fetch ${media.status}`);
          const buffer = Buffer.from(await media.arrayBuffer());
          const ext = mime.split('/')[1]?.split('+')[0] ?? 'bin';
          await ingestInboundAttachment(app, {
            channel: 'mms',
            originRef: `${messageSid}-${i}`,
            sender: from,
            contactId: contact?.id ?? null,
            threadId: threadRow?.rows[0]?.id ?? null,
            filename: `mms-${messageSid.slice(-8)}-${i}.${ext}`,
            mimeType: mime,
            buffer,
          });
        } catch (err) {
          app.log.warn({ err, sid: messageSid, i }, 'mms media ingest failed');
        }
      }
      // Ack is client-acting → kill-switch gated (the FILE is still
      // accepted, scanned, and quarantined regardless).
      if (contact && (await isAutomationEnabled(app, 'attachment_acks'))) {
        // Responsive ack in the sender's own exchange (transactionalReply —
        // consumer-initiated, not outreach).
        await sendSms(app, {
          contactId: contact.id,
          templateKey: 'attachment_received_sms',
          language: (contact as { language?: 'en' | 'es' }).language ?? 'en',
          vars: { first_name: contact.first_name, portal_link: app.config.PORTAL_BASE_URL },
          transactionalReply: true,
        });
      }
    }

    // Audit carries identifiers only — the message BODY lives in messages.
    await writeAudit(app.db, {
      actorType: 'system', actorLabel: 'twilio-webhook',
      action: 'sms.received',
      details: { message_sid: messageSid, matched: contact !== null, stop, media: numMedia },
      contactId: contact?.id ?? null,
    });

    return reply.type('text/xml').send(TWIML_EMPTY);
  });

  // ── Twilio: inbound voice — greeting script is an admin-editable template ──
  const voiceGuard = twilioGuard(app, '/webhooks/twilio/voice');
  app.post('/webhooks/twilio/voice', async (request, reply) => {
    const params = voiceGuard(request, reply);
    if (!params) return reply;

    const { rows } = await app.db.query<{ body_en: string; body_es: string | null }>(
      `SELECT body_en, body_es FROM templates WHERE key = 'twilio_voice_greeting'`
    );
    const script = rows[0]
      ? `${rows[0].body_en}${rows[0].body_es ? ` ${rows[0].body_es}` : ''}`
      : 'Thank you for calling Soto Accounting. Please send us a text message at this number and our team will respond within one business day.';

    const contact = await contactByPhone(app, params['From'] ?? '');
    const rene = await firstActiveByRole(app.db, 'comms_billing');
    const callSid = params['CallSid'] ?? `unknown-${Date.now()}`;
    if (rene) {
      await notifyOnce(app.db, {
        staffId: rene,
        type: 'call_received',
        severity: 'info',
        title: contact
          ? `Missed call from ${contact.first_name} ${contact.last_name}`
          : `Missed call from ${params['From'] ?? 'unknown number'}`,
        contactId: contact?.id ?? null,
        relatedObjectType: 'call',
        relatedObjectId: callSid,
      });
      // M25: every missed call is a phone ticket on Rene's list.
      await createTask(app, {
        title: contact
          ? `Return call: ${contact.first_name} ${contact.last_name}`
          : `Return call: ${params['From'] ?? 'unknown number'}`,
        assignedStaffId: rene,
        contactId: contact?.id ?? null,
        priority: 1,
        source: 'automation',
        sourceType: 'call_ticket',
        sourceId: callSid,
      });
    }
    await writeAudit(app.db, {
      actorType: 'system', actorLabel: 'twilio-webhook',
      action: 'call.received',
      details: { call_sid: params['CallSid'] ?? null, matched: contact !== null },
      contactId: contact?.id ?? null,
    });

    return reply
      .type('text/xml')
      .send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(script)}</Say></Response>`);
  });

  // ── SES bounces/complaints via SNS ─────────────────────────────────────────
  app.post('/webhooks/ses-notifications', async (request, reply) => {
    let msg: SnsMessage;
    try {
      msg = JSON.parse(typeof request.body === 'string' ? request.body : JSON.stringify(request.body)) as SnsMessage;
    } catch {
      return reply.code(400).send({ error: 'invalid_payload' });
    }
    if (!(await verifySnsSignature(msg))) {
      request.log.warn({ messageId: msg.MessageId, type: msg.Type }, 'SNS signature verification failed');
      return reply.code(401).send({ error: 'unauthorized' });
    }

    if (msg.Type === 'SubscriptionConfirmation') {
      if (!msg.SubscribeURL || !isAmazonSnsUrl(msg.SubscribeURL)) {
        return reply.code(400).send({ error: 'invalid_subscribe_url' });
      }
      await snsHttp.fetchText(msg.SubscribeURL);
      await writeAudit(app.db, {
        actorType: 'system', actorLabel: 'sns-webhook',
        action: 'ses.subscription_confirmed',
        details: { topic_arn: msg.TopicArn },
      });
      return { status: 'confirmed' };
    }

    if (msg.Type === 'Notification') {
      const feedback = parseSesFeedback(msg.Message);
      let matched = 0;
      for (const recipient of feedback.recipients) {
        const result = await handleMailBounce(app, recipient);
        if (result.matched) matched++;
        await writeAudit(app.db, {
          actorType: 'system', actorLabel: 'sns-webhook',
          action: feedback.kind === 'complaint' ? 'mail.complained' : 'mail.bounced',
          details: { recipient, matched: result.matched, detail: feedback.detail },
        });
      }
      return { status: 'ok', kind: feedback.kind, recipients: feedback.recipients.length, matched };
    }

    return { status: 'ignored' };
  });

  // ── Inbound email attachments — same pipeline as MMS ──────────────────────
  // Staff-auth'd ingest for the inbound-email receiver (Postal/SES receiving
  // lands in Phase 2; this is the channel-ready seam). Same rules: accept,
  // scan, quarantine on the thread, warm ack with the portal link.
  app.post('/inbound-email/ingest', { preHandler: [app.authenticate, requirePermission('inbox.manage')] }, async (request, reply) => {
    const b = z.object({
      messageId: z.string().min(1),
      sender: z.string().email(),
      filename: z.string().min(1),
      mimeType: z.string().optional(),
      contentBase64: z.string().min(1),
    }).parse(request.body);
    const contact = await app.db.query<{ id: string; first_name: string; email: string; language: 'en' | 'es' }>(
      `SELECT id, first_name, email, language FROM contacts WHERE lower(email) = lower($1) AND NOT is_archived LIMIT 1`,
      [b.sender]
    );
    const c = contact.rows[0] ?? null;
    const result = await ingestInboundAttachment(app, {
      channel: 'email',
      originRef: b.messageId,
      sender: b.sender,
      contactId: c?.id ?? null,
      filename: b.filename,
      mimeType: b.mimeType ?? null,
      buffer: Buffer.from(b.contentBase64, 'base64'),
    });
    // Block-and-nudge holds for email exactly as for SMS: the file is
    // accepted into quarantine, the reply teaches the portal habit.
    if (c?.email && (await isAutomationEnabled(app, 'attachment_acks'))) {
      await sendTemplatedEmail(app, {
        to: c.email, templateKey: 'attachment_received_email', language: c.language,
        contactId: c.id,
        vars: { first_name: c.first_name, portal_link: app.config.PORTAL_BASE_URL },
      }).catch((err) => app.log.warn({ err }, 'attachment ack email failed'));
    }
    return reply.code(201).send(result);
  });

  // ── Quarantine review (unified inbox) ─────────────────────────────────────
  const inbox = { preHandler: [app.authenticate, requirePermission('inbox.manage')] };

  app.get('/inbound-attachments', inbox, async (request) => {
    const q = z.object({ status: z.enum(['quarantined', 'filed', 'discarded']).default('quarantined') }).parse(request.query);
    const { rows } = await app.db.query(
      `SELECT a.id, a.channel, a.sender, a.filename, a.mime_type, a.size_bytes::int AS size_bytes,
              a.scan_status, a.scan_detail, a.suggested_category, a.status, a.created_at,
              a.contact_id, c.first_name || ' ' || c.last_name AS contact_name
       FROM inbound_attachments a
       LEFT JOIN contacts c ON c.id = a.contact_id
       WHERE a.status = $1::inbound_attachment_status
       ORDER BY a.created_at DESC LIMIT 200`,
      [q.status]
    );
    return { attachments: rows };
  });

  // Staff preview/download for review — audit-logged like every doc access.
  app.get<{ Params: { id: string } }>('/inbound-attachments/:id/download', inbox, async (request, reply) => {
    const id = z.uuid().parse(request.params.id);
    const { rows } = await app.db.query<{ minio_bucket: string; minio_key: string; filename: string; mime_type: string | null; contact_id: string | null }>(
      `SELECT minio_bucket, minio_key, filename, mime_type, contact_id FROM inbound_attachments WHERE id = $1 AND status = 'quarantined'`,
      [id]
    );
    if (!rows[0]) throw new AppError(404, 'not_found', 'Attachment not found.');
    await writeAudit(app.db, {
      actorType: 'staff', actorId: request.staff!.id, actorLabel: request.staff!.email,
      action: 'attachment.reviewed', objectType: 'inbound_attachment', objectId: id,
      contactId: rows[0].contact_id, ip: request.ip,
    });
    const minio = makeMinioClient(app.config);
    const stream = await minio.getObject(rows[0].minio_bucket, rows[0].minio_key);
    void reply.header('content-type', rows[0].mime_type ?? 'application/octet-stream');
    void reply.header('content-disposition', `inline; filename="${rows[0].filename}"`);
    return reply.send(stream);
  });

  app.post<{ Params: { id: string } }>('/inbound-attachments/:id/file', inbox, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = z.object({ category: z.string().min(1), contactId: z.uuid().optional() }).parse(request.body);
    return fileAttachment(app, id, {
      category: b.category, contactId: b.contactId ?? null,
      actor: request.staff!, ip: request.ip,
    });
  });

  app.post<{ Params: { id: string } }>('/inbound-attachments/:id/reassign', inbox, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = z.object({ contactId: z.uuid() }).parse(request.body);
    await reassignAttachment(app, id, b.contactId, request.staff!);
    return { status: 'ok' };
  });

  app.post<{ Params: { id: string } }>('/inbound-attachments/:id/discard', inbox, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = z.object({ reason: z.string().max(300).optional() }).parse(request.body ?? {});
    await discardAttachment(app, id, request.staff!, b.reason);
    return { status: 'ok' };
  });
}
