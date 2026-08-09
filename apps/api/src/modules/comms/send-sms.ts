// Outbound SMS (approved vendor: Twilio). Consent-gated at send time — a
// contact without sms_consent NEVER receives a message, whatever the caller
// intended. Copy comes from the templates table (admin-editable, EN/ES).
// Documents never travel this channel (CLAUDE.md) — nudges and links only.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';

function render(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '');
}

export async function sendSms(
  app: FastifyInstance,
  input: {
    contactId: string;
    templateKey: string;
    language: 'en' | 'es';
    vars: Record<string, string>;
    /**
     * Broadcast announcements ONLY (M27). Their copy is authored per-send in the
     * broadcast record rather than in a reusable template, so there is no
     * template row to read — but the copy is still admin-authored without a
     * deploy, which is what the templates rule is protecting.
     *
     * This replaces the template LOOKUP and nothing else: the TCPA consent gate,
     * the phone check, the Twilio config check, the thread logging and the audit
     * row all still run. It must never be used to route around the consent gate,
     * which is why `transactionalReply` is not settable alongside it.
     */
    bodyOverride?: string;
    /**
     * ONLY for direct replies to a message the contact just sent us (e.g. the
     * MMS-attachment ack): a consumer-initiated exchange is TCPA-permissible
     * without the standing consent flag. Broadcast/reminder/nudge paths must
     * never set this — the consent gate stays absolute for outreach.
     */
    transactionalReply?: boolean;
  }
): Promise<{ sent: boolean; reason: string | null }> {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = app.config;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    return { sent: false, reason: 'twilio_not_configured' };
  }

  const contact = await app.db.query<{ phone: string | null; sms_consent: boolean }>(
    `SELECT phone, sms_consent FROM contacts WHERE id = $1 AND NOT is_archived`,
    [input.contactId]
  );
  const c = contact.rows[0];
  if (!c) return { sent: false, reason: 'contact_not_found' };
  if (!c.sms_consent && !input.transactionalReply) return { sent: false, reason: 'no_sms_consent' }; // TCPA gate — absolute for outreach
  if (!c.phone) return { sent: false, reason: 'no_phone' };

  let body: string;
  if (input.bodyOverride !== undefined) {
    if (input.transactionalReply) {
      // A caller supplying its own copy AND claiming consumer-initiated exemption
      // is the exact shape of an accidental consent bypass. Refuse the combination.
      return { sent: false, reason: 'override_with_transactional_reply' };
    }
    body = render(input.bodyOverride, input.vars);
  } else {
    const tpl = await app.db.query<{ body_en: string; body_es: string | null; is_placeholder: boolean }>(
      `SELECT body_en, body_es, is_placeholder FROM templates WHERE key = $1 AND channel = 'sms'`,
      [input.templateKey]
    );
    const t = tpl.rows[0];
    if (!t) return { sent: false, reason: 'template_missing' };
    if (t.is_placeholder) return { sent: false, reason: 'template_placeholder_blocked' }; // same gate as email
    body = render(input.language === 'es' && t.body_es ? t.body_es : t.body_en, input.vars);
  }

  const digits = c.phone.replace(/\D/g, '');
  const to = digits.length === 10 ? `+1${digits}` : `+${digits}`;
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: TWILIO_PHONE_NUMBER, To: to, Body: body }).toString(),
    }
  );
  if (!res.ok) {
    app.log.warn({ status: res.status, template: input.templateKey }, 'twilio send failed');
    return { sent: false, reason: `twilio_${res.status}` };
  }
  const message = (await res.json()) as { sid?: string };

  // The outbound lands in the client's single conversation history.
  const thread = await app.db.query<{ id: string }>(
    `SELECT id FROM message_threads WHERE contact_id = $1 AND status = 'open' ORDER BY created_at LIMIT 1`,
    [input.contactId]
  );
  const threadId =
    thread.rows[0]?.id ??
    (await app.db.query<{ id: string }>(
      `INSERT INTO message_threads (contact_id, subject, last_message_at) VALUES ($1, 'Text messages', now()) RETURNING id`,
      [input.contactId]
    )).rows[0]!.id;
  await app.db.query(
    `INSERT INTO messages (thread_id, direction, channel, sender_type, body, template_key, language, delivery_status, external_ref)
     VALUES ($1, 'outbound', 'sms', 'system', $2, $3, $4, 'sent', $5)`,
    [threadId, body, input.templateKey, input.language, message.sid ?? null]
  );
  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'sms-sender',
    action: 'sms.sent', contactId: input.contactId,
    details: { template: input.templateKey, sid: message.sid ?? null },
  });
  return { sent: true, reason: null };
}
