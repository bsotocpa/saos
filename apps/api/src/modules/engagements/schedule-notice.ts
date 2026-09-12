/*
 * THE ADDED-SCHEDULE NOTICE (2026-09-12, Brian's build ruling).
 *
 * A client who has signed the Master accepts a later service by its schedule alone, in the
 * portal (Master §1). Until today nothing told them a schedule was waiting: the proof run on the
 * rehearsal client put Schedule C in the portal and no email left. This is that email, "One more
 * thing to agree to", EN/ES, with a deep link to portal Sign.
 *
 * It is a client-facing send, so it is an outbox effect behind the `schedule_added_notice`
 * automation, which ships OFF. Queued when an engagement is created for a client whose Master is
 * signed and whose new service needs a schedule they have not accepted; sent by the drain only
 * when Brian has armed it; counted and audited as suppressed when he has not. One pending row per
 * client (the outbox's own idempotency), and the email lists whatever is pending at send time.
 */
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types.ts';
import { writeAudit } from '../../audit.ts';
import { enqueueEffect } from '../../outbox.ts';
import { isAutomationEnabled } from '../../automations.ts';
import { pendingSchedules } from './packet.ts';

async function pendingFor(app: FastifyInstance, contactId: string): Promise<{ code: string; title: string }[]> {
  try {
    const p = await pendingSchedules(app, contactId);
    return p.masterSigned ? p.pending.map((s) => ({ code: s.schedule_code, title: s.title })) : [];
  } catch (err) {
    /*
     * A packet REFUSAL (an unscheduled line, a placeholder schedule, no final Master, an attest
     * engagement without its addendum) means nothing can be pending for this client yet: the
     * packet path will say so itself when someone tries to paper it. It must never break the
     * engagement creation that asked. A real error (the database) still propagates.
     */
    if (err instanceof AppError) return [];
    throw err;
  }
}

/**
 * After an engagement is created: if the client has a signed Master and the new service's
 * schedule is not yet accepted, record the intent to tell them. Nothing is sent here.
 */
export async function queueAddedScheduleNotice(app: FastifyInstance, contactId: string): Promise<{ queued: boolean; schedules: string[] }> {
  const pending = await pendingFor(app, contactId);
  if (pending.length === 0) return { queued: false, schedules: [] };
  const codes = pending.map((p) => p.code);
  const row = await enqueueEffect(app, {
    effect: 'schedule.added_notice',
    payload: { contactId, scheduleCodes: codes },
    contactId,
    objectType: 'contact',
    objectId: contactId,
  });
  return { queued: row !== null, schedules: codes };
}

/** The outbox handler. Recomputes what is pending, then the gate, then the send. */
export async function sendAddedScheduleNotice(
  app: FastifyInstance,
  contactId: string
): Promise<{ sent: boolean; reason?: 'nothing_pending' | 'suppressed' | 'no_email' }> {
  const pending = await pendingFor(app, contactId);
  if (pending.length === 0) return { sent: false, reason: 'nothing_pending' };
  const codes = pending.map((p) => p.code);

  if (!(await isAutomationEnabled(app, 'schedule_added_notice'))) {
    await writeAudit(app.db, {
      actorType: 'system', actorLabel: 'outbox', action: 'schedule.notice_suppressed',
      objectType: 'contact', objectId: contactId, contactId,
      details: { schedules: codes, reason: 'schedule_added_notice automation is off' },
    });
    return { sent: false, reason: 'suppressed' };
  }

  const c = await app.db.query<{ first_name: string; email: string | null; language: 'en' | 'es' }>(
    `SELECT first_name, email, language FROM contacts WHERE id = $1`, [contactId]
  );
  const contact = c.rows[0];
  if (!contact?.email) return { sent: false, reason: 'no_email' };

  const { sendTemplatedEmail } = await import('../templates/service.ts');
  await sendTemplatedEmail(app, {
    to: contact.email,
    templateKey: 'schedule_added',
    language: contact.language,
    vars: {
      first_name: contact.first_name,
      schedules: pending.map((p) => p.title).join(', '),
      sign_link: `${app.config.PORTAL_BASE_URL}/sign`,
    },
    contactId,
  });
  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'outbox', action: 'schedule.notice_sent',
    objectType: 'contact', objectId: contactId, contactId,
    details: { schedules: codes },
  });
  return { sent: true };
}
