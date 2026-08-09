// Milestone-triggered Google review asks (M27, v4.4).
//
// Spec: "milestone-triggered (return accepted, onboarding complete) Google review
// link supporting the GBP strategy — throttled per client, opt-out respected,
// never after a notice/dispute engagement."
//
// That last clause is the one that matters most and is easiest to get wrong. A
// review ask landing on someone who just got an IRS notice, or who is arguing
// about an invoice, is worse than no ask at all: it reads as tone-deaf and it
// invites the review you least want. So the suppression checks run in order of
// how badly they'd embarrass us, and every suppressed attempt is RECORDED — the
// rule is only provable if the near-misses are visible.
//
// Client-acting, so it is gated by `isAutomationEnabled('review_requests')` and
// ships OFF. While disarmed, the suppression is counted like every other gated
// automation, so Brian can see what would have gone out.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { isAutomationEnabled } from '../../automations.ts';
import { sendTemplatedEmail } from '../templates/service.ts';

export type ReviewTrigger = 'return_accepted' | 'onboarding_complete';

/** One ask per client per this many days, whatever the trigger. */
const THROTTLE_DAYS = 180;

/**
 * A notice or dispute anywhere in this window poisons the ask. Deliberately
 * generous: 90 days is long enough that "we resolved your CP2000 last month" is
 * still fresh in the client's mind.
 */
const GRIEVANCE_LOOKBACK_DAYS = 90;

export interface ReviewDecision {
  send: boolean;
  reason: string | null;
}

/**
 * Should we ask this client for a review right now? Read-only, so the UI and the
 * job agree, and so the decision is testable without sending anything.
 */
export async function reviewAskDecision(
  app: FastifyInstance,
  contactId: string
): Promise<ReviewDecision> {
  const { rows } = await app.db.query<{
    archived: boolean; opted_out: boolean; email: string | null;
    recent_ask: number; open_notices: number; recent_notices: number;
    disputed_invoices: number; work_paused: number; stalled_onboarding: number;
  }>(
    `SELECT c.is_archived AS archived,
            c.broadcast_opt_out_at IS NOT NULL AS opted_out,
            c.email,
            (SELECT count(*)::int FROM review_requests rr
             WHERE rr.contact_id = c.id AND rr.status = 'sent'
               AND rr.created_at > now() - make_interval(days => $2)) AS recent_ask,
            (SELECT count(*)::int FROM irs_notices n
             WHERE n.contact_id = c.id AND n.status <> 'resolved') AS open_notices,
            (SELECT count(*)::int FROM irs_notices n
             WHERE n.contact_id = c.id
               AND n.created_at > now() - make_interval(days => $3)) AS recent_notices,
            (SELECT count(*)::int FROM invoices i
             WHERE i.contact_id = c.id AND i.status = 'overdue') AS disputed_invoices,
            (SELECT count(*)::int FROM engagements e
             WHERE e.contact_id = c.id AND e.work_paused_at IS NOT NULL) AS work_paused,
            (SELECT count(*)::int FROM portal_onboarding po
             WHERE po.contact_id = c.id AND po.completed_at IS NULL
               AND po.stalled_flagged_at IS NOT NULL) AS stalled_onboarding
     FROM contacts c WHERE c.id = $1`,
    [contactId, THROTTLE_DAYS, GRIEVANCE_LOOKBACK_DAYS]
  );
  const r = rows[0];
  if (!r) return { send: false, reason: 'contact not found' };

  // Ordered by how badly getting this wrong would land.
  if (r.open_notices > 0) return { send: false, reason: 'open IRS notice' };
  if (r.recent_notices > 0) return { send: false, reason: `notice within ${GRIEVANCE_LOOKBACK_DAYS} days` };
  if (r.disputed_invoices > 0) return { send: false, reason: 'overdue invoice' };
  if (r.work_paused > 0) return { send: false, reason: 'work paused for non-payment' };
  if (r.stalled_onboarding > 0) return { send: false, reason: 'onboarding stalled' };
  if (r.opted_out) return { send: false, reason: 'opted out of announcements' };
  if (r.archived) return { send: false, reason: 'archived contact' };
  if (!r.email) return { send: false, reason: 'no email address' };
  if (r.recent_ask > 0) return { send: false, reason: `already asked within ${THROTTLE_DAYS} days` };
  return { send: true, reason: null };
}

/**
 * Ask for a review off a milestone. Always records a row — sent or suppressed —
 * because the throttle and the never-after-a-notice rule are only auditable if
 * the refusals are written down.
 */
export async function requestReview(
  app: FastifyInstance,
  input: { contactId: string; trigger: ReviewTrigger; sourceType?: string; sourceId?: string }
): Promise<{ sent: boolean; reason: string | null; automationDisabled: boolean }> {
  const decision = await reviewAskDecision(app, input.contactId);

  const record = async (status: 'sent' | 'suppressed', reason: string | null) => {
    await app.db.query(
      `INSERT INTO review_requests (contact_id, trigger, source_type, source_id, status, suppressed_reason, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $5 = 'sent' THEN now() ELSE NULL END)`,
      [input.contactId, input.trigger, input.sourceType ?? null, input.sourceId ?? null, status, reason]
    );
  };

  if (!decision.send) {
    await record('suppressed', decision.reason);
    return { sent: false, reason: decision.reason, automationDisabled: false };
  }

  // The kill switch gates the SEND only. The decision above still ran, and the
  // suppression is counted, so Brian can see what arming this would do.
  if (!(await isAutomationEnabled(app, 'review_requests'))) {
    await record('suppressed', 'automation disabled');
    return { sent: false, reason: 'automation disabled', automationDisabled: true };
  }

  const contact = await app.db.query<{ first_name: string; email: string; language: 'en' | 'es' }>(
    `SELECT first_name, email, language FROM contacts WHERE id = $1`,
    [input.contactId]
  );
  const c = contact.rows[0]!;
  await sendTemplatedEmail(app, {
    to: c.email,
    templateKey: 'review_request',
    language: c.language,
    contactId: input.contactId,
    vars: { first_name: c.first_name, review_link: app.config.GOOGLE_REVIEW_URL },
  });
  await record('sent', null);
  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'review-requests',
    action: 'review_request.sent', objectType: 'contact', objectId: input.contactId,
    contactId: input.contactId,
    details: { trigger: input.trigger, source_type: input.sourceType ?? null },
  });
  return { sent: true, reason: null, automationDisabled: false };
}

/**
 * Daily, date-guarded: ask off milestones reached yesterday-or-later that have
 * not been asked about. Accepted returns only — a FILED return is not a finished
 * one, and asking for a review before acceptance risks asking right before a
 * reject.
 */
export async function runReviewRequestJob(
  app: FastifyInstance,
  today: string
): Promise<{ skipped: boolean; considered: number; sent: number; suppressed: number }> {
  const ACTION = 'job.review_requests';
  const already = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = $1 AND details->>'run_date' = $2 LIMIT 1`,
    [ACTION, today]
  );
  if (already.rows.length > 0) return { skipped: true, considered: 0, sent: 0, suppressed: 0 };

  const { rows } = await app.db.query<{ contact_id: string; source_id: string; trigger: ReviewTrigger }>(
    `SELECT e.contact_id, te.id::text AS source_id, 'return_accepted'::text AS trigger
     FROM tax_engagements te
     JOIN engagements e ON e.id = te.engagement_id
     WHERE te.efile_accepted_at IS NOT NULL
       AND te.efile_accepted_at > now() - interval '14 days'
       AND NOT EXISTS (
         SELECT 1 FROM review_requests rr
         WHERE rr.source_type = 'tax_engagement' AND rr.source_id = te.id::text
       )
     UNION ALL
     -- portal_onboarding is keyed by contact_id (one onboarding per client), so
     -- that is also its dedupe key.
     SELECT po.contact_id, po.contact_id::text, 'onboarding_complete'::text
     FROM portal_onboarding po
     WHERE po.completed_at IS NOT NULL
       AND po.completed_at > now() - interval '14 days'
       AND NOT EXISTS (
         SELECT 1 FROM review_requests rr
         WHERE rr.source_type = 'portal_onboarding' AND rr.source_id = po.contact_id::text
       )`
  );

  let sent = 0;
  let suppressed = 0;
  for (const row of rows) {
    const res = await requestReview(app, {
      contactId: row.contact_id,
      trigger: row.trigger,
      sourceType: row.trigger === 'return_accepted' ? 'tax_engagement' : 'portal_onboarding',
      sourceId: row.source_id,
    });
    if (res.sent) sent += 1;
    else suppressed += 1;
  }

  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'daily-jobs',
    action: ACTION,
    details: { run_date: today, considered: rows.length, sent, suppressed },
  });
  return { skipped: false, considered: rows.length, sent, suppressed };
}
