// IRS Notice module (MP): records, auto response-deadline, Ana-Maria default
// routing (by ROLE: tax_preparer), and the two escalations —
//   unactioned 48h            → Brian + Jackson
//   deadline within 14 days   → Brian
// Escalations run on every scheduler tick and are idempotent per notice via
// notification-existence checks (notifyOnce), so restarts never double-alert.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { allActiveByRoles, firstActiveByRole, notifyOnce } from '../../staffing.ts';
import { createTask } from '../tasks/service.ts';
import { addDays } from '../tax/deadlines.ts';

export interface CreateNoticeInput {
  contactId: string;
  businessId?: string | undefined;
  taxEngagementId?: string | undefined;
  noticeType: string;
  taxYear?: number | undefined;
  noticeDate?: string | undefined;
  responseDeadline?: string | undefined;
  serviceTier?: 'standard' | 'premium' | undefined;
  amountCents?: number | undefined;
  source?: 'portal_upload' | 'manual' | 'mail' | 'email' | undefined;
  documentId?: string | undefined;
}

async function settingNumber(app: FastifyInstance, key: string, fallback: number): Promise<number> {
  const { rows } = await app.db.query<{ value: number }>(`SELECT value FROM app_settings WHERE key = $1`, [key]);
  return typeof rows[0]?.value === 'number' ? rows[0].value : fallback;
}

/**
 * Create a notice record. Called by staff routes AND by the M10 document
 * service when a client uploads into the 'irs_notices' category — that hook
 * is what makes "portal upload → record + Ana-Maria alert within minutes" true.
 */
export async function createIrsNotice(
  app: FastifyInstance,
  actor: { type: 'staff' | 'client' | 'system'; id?: string | null; label?: string | null },
  input: CreateNoticeInput
): Promise<{ id: string; handlerStaffId: string | null; responseDeadline: string | null }> {
  const handlerStaffId = await firstActiveByRole(app.db, 'tax_preparer');
  const defaultDays = await settingNumber(app, 'irs_notice.default_response_days', 30);
  const responseDeadline =
    input.responseDeadline ?? (input.noticeDate ? addDays(input.noticeDate, defaultDays) : null);

  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO irs_notices
       (contact_id, business_id, tax_engagement_id, notice_type, tax_year, notice_date,
        response_deadline, handler_staff_id, service_tier, amount_cents, source, document_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::notice_tier,$10,$11::notice_source,$12)
     RETURNING id`,
    [
      input.contactId, input.businessId ?? null, input.taxEngagementId ?? null, input.noticeType,
      input.taxYear ?? null, input.noticeDate ?? null, responseDeadline, handlerStaffId,
      input.serviceTier ?? 'standard', input.amountCents ?? null, input.source ?? 'manual',
      input.documentId ?? null,
    ]
  );
  const id = rows[0]!.id;

  if (handlerStaffId) {
    await notifyOnce(app.db, {
      staffId: handlerStaffId,
      type: 'irs_notice_new',
      severity: 'warning',
      title: `New IRS notice (${input.noticeType})${responseDeadline ? ` — respond by ${responseDeadline}` : ''}`,
      contactId: input.contactId,
      relatedObjectType: 'irs_notice',
      relatedObjectId: id,
    });
  }
  // v4.3 flow 1 / M25: every notice is an OWNED TICKET — a task on the
  // handler's list that auto-closes when the notice resolves.
  await createTask(app, {
    title: `IRS notice ${input.noticeType} — respond${responseDeadline ? ` by ${responseDeadline}` : ''}`,
    description: 'Owned notice ticket. Work the notice playbook; the ticket closes itself when the notice is marked resolved.',
    assignedStaffId: handlerStaffId,
    contactId: input.contactId,
    dueDate: responseDeadline,
    priority: 1,
    source: 'automation',
    sourceType: 'irs_notice',
    sourceId: id,
  });
  await writeAudit(app.db, {
    actorType: actor.type,
    actorId: actor.id ?? null,
    actorLabel: actor.label ?? null,
    action: 'irs_notice.created',
    objectType: 'irs_notice',
    objectId: id,
    contactId: input.contactId,
    details: { notice_type: input.noticeType, source: input.source ?? 'manual', tier: input.serviceTier ?? 'standard' },
  });
  return { id, handlerStaffId, responseDeadline };
}

/** Escalations — safe to run every tick (per-notice idempotency). */
export async function runNoticeEscalations(
  app: FastifyInstance
): Promise<{ unactioned: number; deadline: number }> {
  const unactionedHours = await settingNumber(app, 'sla.irs_notice_unactioned_alert_hours', 48);
  const deadlineDays = await settingNumber(app, 'sla.irs_notice_escalation_deadline_days', 14);

  // Unactioned 48h → Brian + Jackson (MP automation 6 / Alert Center).
  const stale = await app.db.query<{ id: string; contact_id: string; notice_type: string }>(
    `SELECT id, contact_id, notice_type FROM irs_notices
     WHERE status = 'received' AND first_actioned_at IS NULL
       AND received_at < now() - make_interval(hours => $1)`,
    [unactionedHours]
  );
  let unactioned = 0;
  if (stale.rows.length > 0) {
    const leadership = await allActiveByRoles(app.db, ['ceo', 'ed_coo']);
    for (const n of stale.rows) {
      let fired = false;
      for (const staffId of leadership) {
        fired =
          (await notifyOnce(app.db, {
            staffId,
            type: 'irs_notice_unactioned',
            severity: 'critical',
            title: `IRS notice unactioned ${unactionedHours}h (${n.notice_type})`,
            contactId: n.contact_id,
            relatedObjectType: 'irs_notice',
            relatedObjectId: n.id,
          })) || fired;
      }
      if (fired) unactioned++;
    }
  }

  // Response deadline within 14 days → Brian, stamped once via escalated_at.
  const nearDeadline = await app.db.query<{ id: string; contact_id: string; notice_type: string; response_deadline: string }>(
    `SELECT id, contact_id, notice_type, response_deadline::text AS response_deadline
     FROM irs_notices
     WHERE escalated_at IS NULL
       AND status NOT IN ('resolved', 'response_sent')
       AND response_deadline IS NOT NULL
       AND response_deadline <= CURRENT_DATE + $1::int`,
    [deadlineDays]
  );
  let deadline = 0;
  if (nearDeadline.rows.length > 0) {
    const ceos = await allActiveByRoles(app.db, ['ceo']);
    for (const n of nearDeadline.rows) {
      for (const staffId of ceos) {
        await notifyOnce(app.db, {
          staffId,
          type: 'irs_notice_deadline_escalation',
          severity: 'critical',
          title: `IRS notice deadline ${n.response_deadline} (${n.notice_type}) — escalated`,
          contactId: n.contact_id,
          relatedObjectType: 'irs_notice',
          relatedObjectId: n.id,
        });
      }
      await app.db.query(`UPDATE irs_notices SET escalated_at = now(), status = 'escalated' WHERE id = $1`, [n.id]);
      await writeAudit(app.db, {
        actorType: 'system',
        action: 'irs_notice.escalated',
        objectType: 'irs_notice',
        objectId: n.id,
        contactId: n.contact_id,
        details: { response_deadline: n.response_deadline },
      });
      deadline++;
    }
  }
  return { unactioned, deadline };
}
