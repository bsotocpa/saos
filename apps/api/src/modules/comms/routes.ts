// Comms webhooks (launch gate, 2026-07-06): Twilio inbound SMS/voice on the
// firm's texting number + the SES bounce/complaint feed via SNS. See
// twilio.ts / ses-sns.ts for the authentication mechanics.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { firstActiveByRole, notifyOnce } from '../../staffing.ts';
import { handleMailBounce } from '../portal-auth/service.ts';
import { escapeXml, isStopMessage, parseFormBody, validateTwilioSignature } from './twilio.ts';
import { isAmazonSnsUrl, parseSesFeedback, snsHttp, verifySnsSignature, type SnsMessage } from './ses-sns.ts';

const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

/** Contact whose phone (either slot) ends with the same 10 digits. */
async function contactByPhone(app: FastifyInstance, raw: string) {
  const digits = raw.replace(/\D/g, '');
  const last10 = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (last10.length < 7) return null;
  const { rows } = await app.db.query<{ id: string; first_name: string; last_name: string }>(
    `SELECT id, first_name, last_name FROM contacts
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
    }

    // Audit carries identifiers only — the message BODY lives in messages.
    await writeAudit(app.db, {
      actorType: 'system', actorLabel: 'twilio-webhook',
      action: 'sms.received',
      details: { message_sid: messageSid, matched: contact !== null, stop },
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
        relatedObjectId: params['CallSid'] ?? `unknown-${Date.now()}`,
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
}
