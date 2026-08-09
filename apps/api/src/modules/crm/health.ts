// Client health score (MP Unified Contact Record): five components × 20 pts.
//   portal logins 20 | document timeliness 20 | payment history 20 |
//   response time 20 | tenure/depth 20
// Green ≥ 70 / Yellow 40–69 / Red < 40 (thresholds live in app_settings).
//
// Red → alert assigned staff. Green + tenure → upsell flag, which is
// §7216-GATED: without a signed consent the flag never fires (MP §7216).
//
// Component measures are v1 heuristics over the data the system captures
// today; they tighten as billing (M13) and document flows (M10) go live.

import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db.ts';
import { has7216Consent } from '../compliance/consent.ts';
import { writeAudit } from '../../audit.ts';
import { createTask } from '../tasks/service.ts';

export interface HealthComponents {
  portal_logins: number;
  document_timeliness: number;
  payment_history: number;
  response_time: number;
  tenure_depth: number;
}

const UPSELL_TENURE_YEARS = 2;

export async function computeHealth(
  db: Db,
  contactId: string
): Promise<{ score: number; components: HealthComponents }> {
  // Portal engagement: logins in the last 90 days (from the audit trail).
  const logins = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log
     WHERE action = 'portal.login' AND contact_id = $1 AND occurred_at > now() - interval '90 days'`,
    [contactId]
  );
  const loginCount = logins.rows[0]!.n;
  const portalLogins = loginCount >= 4 ? 20 : loginCount >= 2 ? 14 : loginCount === 1 ? 8 : 0;

  // Document timeliness: completed share of document requests (none → 20).
  const docs = await db.query<{ total: number; complete: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'complete')::int AS complete
     FROM document_requests WHERE contact_id = $1`,
    [contactId]
  );
  const d = docs.rows[0]!;
  const documentTimeliness = d.total === 0 ? 20 : Math.round((20 * d.complete) / d.total);

  // Payment history: any overdue kills it; open invoices dent it.
  const pay = await db.query<{ overdue: number; open: number }>(
    `SELECT count(*) FILTER (WHERE te.payment_status = 'overdue')::int AS overdue,
            count(*) FILTER (WHERE te.payment_status IN ('invoiced', 'partial'))::int AS open
     FROM tax_engagements te
     JOIN engagements e ON e.id = te.engagement_id
     WHERE e.contact_id = $1`,
    [contactId]
  );
  const p = pay.rows[0]!;
  const paymentHistory = p.overdue > 0 ? 0 : p.open > 0 ? 12 : 20;

  // Response time: average docs-requested → docs-received turnaround.
  const resp = await db.query<{ avg_days: number | null }>(
    `SELECT avg(EXTRACT(EPOCH FROM (te.docs_received_at - te.docs_requested_at)) / 86400)::float AS avg_days
     FROM tax_engagements te
     JOIN engagements e ON e.id = te.engagement_id
     WHERE e.contact_id = $1 AND te.docs_requested_at IS NOT NULL AND te.docs_received_at IS NOT NULL`,
    [contactId]
  );
  const avgDays = resp.rows[0]!.avg_days;
  const responseTime = avgDays === null ? 20 : avgDays < 3 ? 20 : avgDays < 7 ? 15 : avgDays < 14 ? 10 : 5;

  // Tenure/depth: years as a client (cap 12) + engagement count (cap 8).
  const tenure = await db.query<{ years: number | null; engagements: number }>(
    `SELECT EXTRACT(EPOCH FROM (now() - c.client_since::timestamptz)) / 31557600 AS years,
            (SELECT count(*)::int FROM engagements e WHERE e.contact_id = c.id) AS engagements
     FROM contacts c WHERE c.id = $1`,
    [contactId]
  );
  const t = tenure.rows[0]!;
  const tenureDepth = Math.min(12, Math.floor((t.years ?? 0) * 4)) + Math.min(8, t.engagements * 2);

  const components: HealthComponents = {
    portal_logins: portalLogins,
    document_timeliness: documentTimeliness,
    payment_history: paymentHistory,
    response_time: responseTime,
    tenure_depth: tenureDepth,
  };
  const score = Object.values(components).reduce((a, b) => a + b, 0);
  return { score, components };
}

export type HealthBand = 'gray' | 'red' | 'yellow' | 'green';

export interface HealthSignals {
  overdue_docs: boolean;
  failed_payment: boolean;
  stalled_ladder: boolean;
  red_clock: boolean;
}

/**
 * Baseline (decided 2026-08-09): a migrated contact with NO interaction
 * data is NEUTRAL, not at-risk. "Engaged" = any portal login, engagement,
 * document request, or inbound message.
 */
async function isEngaged(db: Db, contactId: string): Promise<boolean> {
  const { rows } = await db.query<{ engaged: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM audit_log WHERE action = 'portal.login' AND contact_id = $1)
        OR EXISTS (SELECT 1 FROM engagements WHERE contact_id = $1)
        OR EXISTS (SELECT 1 FROM document_requests WHERE contact_id = $1)
        OR EXISTS (SELECT 1 FROM messages m JOIN message_threads t ON t.id = m.thread_id
                   WHERE t.contact_id = $1 AND m.direction = 'inbound') AS engaged`,
    [contactId]
  );
  return rows[0]!.engaged;
}

/** The ACTUAL warning signals — yellow is reserved for these. */
export async function healthSignals(db: Db, contactId: string): Promise<HealthSignals> {
  const { rows } = await db.query<HealthSignals>(
    `SELECT
       EXISTS (SELECT 1 FROM document_requests
               WHERE contact_id = $1 AND status IN ('open', 'partially_received')
                 AND due_date IS NOT NULL AND due_date < CURRENT_DATE) AS overdue_docs,
       (EXISTS (SELECT 1 FROM invoices WHERE contact_id = $1 AND status = 'overdue')
        OR EXISTS (SELECT 1 FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id
                   WHERE e.contact_id = $1 AND te.payment_status = 'overdue')) AS failed_payment,
       EXISTS (SELECT 1 FROM tasks
               WHERE contact_id = $1
                 AND status IN ('not_started', 'in_progress', 'waiting_for_input', 'deferred')
                 AND (ladder_rung >= 3 OR source_type = 'stalled_flag')) AS stalled_ladder,
       EXISTS (SELECT 1 FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id
               WHERE e.contact_id = $1
                 AND te.stage NOT IN ('filed', 'completed', 'withdrawn', 'on_hold')
                 AND te.docs_received_at IS NULL
                 AND COALESCE(te.extended_deadline, te.original_deadline) IS NOT NULL
                 AND COALESCE(te.extended_deadline, te.original_deadline) < CURRENT_DATE + 14) AS red_clock`,
    [contactId]
  );
  return rows[0]!;
}

/**
 * Band assignment: gray = never engaged (neutral) · red = severe compound
 * score · yellow = an actual signal · green = active and clean. The score
 * still informs red; it no longer defaults anyone into yellow.
 */
async function assignBand(
  db: Db,
  contactId: string,
  score: number
): Promise<{ band: HealthBand; signals: HealthSignals | null }> {
  if (!(await isEngaged(db, contactId))) return { band: 'gray', signals: null };
  const { rows } = await db.query<{ value: number }>(
    `SELECT (value)::text::int AS value FROM app_settings WHERE key = 'health.red_below'`
  );
  const redBelow = rows[0]?.value ?? 40;
  const signals = await healthSignals(db, contactId);
  if (score < redBelow) return { band: 'red', signals };
  const any = signals.overdue_docs || signals.failed_payment || signals.stalled_ladder || signals.red_clock;
  return { band: any ? 'yellow' : 'green', signals };
}

/**
 * Refresh health for all active Soto clients. Notifications fire on band
 * TRANSITIONS (into red / into green+tenure), not on every run.
 */
export async function runHealthRefresh(app: FastifyInstance): Promise<{ scored: number; redAlerts: number; upsellFlags: number }> {
  const contacts = await app.db.query<{
    id: string;
    first_name: string;
    last_name: string;
    health_score: number | null;
    health_band: HealthBand | null;
    assigned_manager_id: string | null;
    client_since: Date | null;
  }>(
    `SELECT id, first_name, last_name, health_score, health_band, assigned_manager_id, client_since
     FROM contacts WHERE soto_status = 'active' AND NOT is_archived`
  );

  let redAlerts = 0;
  let upsellFlags = 0;

  for (const c of contacts.rows) {
    const { score, components } = await computeHealth(app.db, c.id);
    const { band: newBand, signals } = await assignBand(app.db, c.id, score);
    await app.db.query(
      `UPDATE contacts SET health_score = $2, health_band = $3, health_components = $4::jsonb, health_computed_at = now() WHERE id = $1`,
      [c.id, score, newBand, JSON.stringify({ ...components, signals })]
    );

    const oldBand = c.health_band;
    const name = `${c.first_name} ${c.last_name}`;

    if (newBand === 'red' && oldBand !== 'red') {
      if (c.assigned_manager_id) {
        await app.db.query(
          `INSERT INTO notifications (staff_id, type, severity, title, contact_id)
           VALUES ($1, 'health_red', 'warning', $2, $3)`,
          [c.assigned_manager_id, `Client health RED: ${name} (${score}/100)`, c.id]
        );
        // M25: the alert stays the alert; the CHECK-IN is a work item.
        await createTask(app, {
          title: `Check in with ${name} — health dropped to RED (${score}/100)`,
          assignedStaffId: c.assigned_manager_id,
          contactId: c.id,
          priority: 1,
          source: 'automation',
          sourceType: 'health_red',
          sourceId: c.id,
        });
      }
      redAlerts++;
    }

    const tenured =
      c.client_since !== null &&
      Date.now() - new Date(c.client_since).getTime() > UPSELL_TENURE_YEARS * 365.25 * 24 * 3600 * 1000;
    if (newBand === 'green' && tenured && oldBand !== 'green') {
      // §7216 GATE: upsell flagging uses tax return information — blocked
      // without signed consent (MP §7216 Enforcement).
      if (await has7216Consent(app.db, c.id)) {
        if (c.assigned_manager_id) {
          await app.db.query(
            `INSERT INTO notifications (staff_id, type, severity, title, contact_id)
             VALUES ($1, 'upsell_candidate', 'info', $2, $3)`,
            [c.assigned_manager_id, `Upsell candidate: ${name} (green health, ${UPSELL_TENURE_YEARS}+ yr tenure)`, c.id]
          );
        }
        upsellFlags++;
      }
    }
  }

  await writeAudit(app.db, {
    actorType: 'system',
    action: 'health.refresh_completed',
    details: { scored: contacts.rows.length, redAlerts, upsellFlags },
  });
  return { scored: contacts.rows.length, redAlerts, upsellFlags };
}
