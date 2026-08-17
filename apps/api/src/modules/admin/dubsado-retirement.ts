// Dubsado retirement trigger (Brian's ruling, 2026-08-09).
//
// Dual-running two systems is the expensive, error-prone state — but retiring
// too early loses history nobody has verified yet. Brian accepted a QUERYABLE
// trigger instead of a gut call:
//
//   A. 25 MIGRATED clients have logged into the SAOS portal, AND
//   B. one full month-end close has run inside SAOS.
//
// Both conditions are measured, not estimated, and the alert fires ONCE when
// they are both true. Until then the same job reports progress so the distance
// is visible instead of guessed at.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { notifyOnce, ownerForRole } from '../../staffing.ts';
import { createTask } from '../tasks/service.ts';

export const MIGRATED_LOGIN_TARGET = 25;

export interface RetirementReadiness {
  migratedLoggedIn: number;
  migratedLoginTarget: number;
  closesCompleted: number;
  conditionA: boolean;
  conditionB: boolean;
  ready: boolean;
}

/**
 * Measure both conditions. "Migrated" means the contact came from Dubsado or
 * Zoho (source flag set at import) — a native SAOS signup logging in says
 * nothing about whether the old system can be switched off.
 */
export async function retirementReadiness(app: FastifyInstance): Promise<RetirementReadiness> {
  const { rows } = await app.db.query<{ migrated_logged_in: number; closes_completed: number }>(
    `SELECT
       (SELECT count(DISTINCT c.id)::int
        FROM contacts c
        JOIN audit_log a ON a.contact_id = c.id AND a.action = 'portal.login'
        -- NOT is_test: a rehearsal client logging into the portal must never
        -- count toward "25 migrated clients have logged in".
        WHERE c.source IN ('dubsado', 'zoho') AND NOT c.is_test) AS migrated_logged_in,
       (SELECT count(*)::int
        FROM close_cycles
        WHERE closed_at IS NOT NULL AND cadence = 'monthly') AS closes_completed`
  );
  const r = rows[0]!;
  const conditionA = r.migrated_logged_in >= MIGRATED_LOGIN_TARGET;
  const conditionB = r.closes_completed >= 1;
  return {
    migratedLoggedIn: r.migrated_logged_in,
    migratedLoginTarget: MIGRATED_LOGIN_TARGET,
    closesCompleted: r.closes_completed,
    conditionA,
    conditionB,
    ready: conditionA && conditionB,
  };
}

/**
 * Daily, date-guarded. Silent while the trigger is unmet (the readiness numbers
 * are on the Executive dashboard for that); fires exactly once when both
 * conditions land, with a task carrying the retirement checklist.
 */
export async function runDubsadoRetirementCheckJob(
  app: FastifyInstance,
  today: string
): Promise<{ skipped: boolean; ready: boolean; readiness: RetirementReadiness; alerted: boolean }> {
  const ACTION = 'job.dubsado_retirement_check';
  const already = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = $1 AND details->>'run_date' = $2 LIMIT 1`,
    [ACTION, today]
  );
  if (already.rows.length > 0) {
    return { skipped: true, ready: false, readiness: await retirementReadiness(app), alerted: false };
  }

  const readiness = await retirementReadiness(app);
  let alerted = false;

  if (readiness.ready) {
    const brian = await ownerForRole(app.db, 'ceo');
    /*
     * THE TASK IS UNCONDITIONAL; only the ALERT is gated (Brian's rule, 2026-08-17).
     *
     * Both sat inside `if (brian)`, so an unfilled role meant the work was never
     * recorded at all. An unassigned task in the queue is visible; a skipped one never
     * existed. A notification still needs a real person — that gate stays.
     */
    await createTask(app, {
      title: 'Retire Dubsado — the trigger you set has been met',
      description:
        `Your trigger (2026-08-09): ${MIGRATED_LOGIN_TARGET} migrated clients logged into the portal AND one ` +
        `full month-end close run in SAOS. Both are now true (${readiness.migratedLoggedIn} logins, ` +
        `${readiness.closesCompleted} closes).\n\n` +
        'Before cancelling: export anything you still want that SAOS does not hold (old proposals, ' +
        'canned-email history), confirm no active workflow still emails clients from Dubsado, then cancel ' +
        'the subscription and record the date here.',
      assignedStaffId: brian,
      priority: 1,
      source: 'automation',
      sourceType: 'dubsado_retirement',
      sourceId: 'trigger_met',
    });
    if (brian) {
      // relatedObjectId is a fixed key, so notifyOnce makes this a
      // once-ever alert rather than a daily nag after the trigger lands.
      alerted = await notifyOnce(app.db, {
        staffId: brian,
        type: 'dubsado_retirement_ready',
        severity: 'info',
        title:
          `Dubsado retirement trigger MET: ${readiness.migratedLoggedIn} migrated clients have logged in ` +
          `and ${readiness.closesCompleted} month-end close(s) have run in SAOS`,
        relatedObjectType: 'ops_milestone',
        relatedObjectId: 'dubsado_retirement',
      });
    }
  }

  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'daily-jobs',
    action: ACTION,
    details: {
      run_date: today,
      migrated_logged_in: readiness.migratedLoggedIn,
      closes_completed: readiness.closesCompleted,
      ready: readiness.ready,
      alerted,
    },
  });
  return { skipped: false, ready: readiness.ready, readiness, alerted };
}
