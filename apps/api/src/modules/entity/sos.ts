// IL Secretary of State good-standing monitor (MP v4.2 module 3) — replaces
// Brian's manual lookup on every discovery call. Adapter pattern:
//   stub — dev/test: deterministic by name ('dissolved' → not in good
//          standing, 'unknown' → not found, else good standing)
//   live — self-hosted scraper against the ILSOS corporate/LLC search
//          (no third-party service — vendor rule)
// Adverse results create a Laura task + bilingual fix-steps email.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { notifyOnce, ownerForRole } from '../../staffing.ts';
import { createTask } from '../tasks/service.ts';
import { sendTemplatedEmail } from '../templates/service.ts';

export type SosStatus = 'good_standing' | 'not_good_standing' | 'not_found';

export interface SosChecker {
  readonly mode: 'stub' | 'live';
  check(businessName: string): Promise<{ status: SosStatus }>;
}

function stubChecker(): SosChecker {
  return {
    mode: 'stub',
    async check(businessName) {
      const n = businessName.toLowerCase();
      if (n.includes('dissolved') || n.includes('revoked')) return { status: 'not_good_standing' };
      if (n.includes('unknown')) return { status: 'not_found' };
      return { status: 'good_standing' };
    },
  };
}

function liveChecker(): SosChecker {
  return {
    mode: 'live',
    async check(businessName) {
      // ILSOS corporate/LLC name search (HTML endpoint — no API exists).
      // Parsing is best-effort: any scrape failure returns not_found and the
      // record stays reviewable by staff rather than wrongly adverse.
      const res = await fetch(
        `https://apps.ilsos.gov/corporatellc/CorporateLlcController?command=doSearch&type=startsWith&searchValue=${encodeURIComponent(businessName)}`,
        { headers: { accept: 'text/html' } }
      );
      if (!res.ok) return { status: 'not_found' };
      const html = (await res.text()).toLowerCase();
      if (!html.includes(businessName.toLowerCase().slice(0, 20))) return { status: 'not_found' };
      if (html.includes('dissolved') || html.includes('revoked') || html.includes('not in good standing')) {
        return { status: 'not_good_standing' };
      }
      return { status: 'good_standing' };
    },
  };
}

export function makeSosChecker(app: FastifyInstance): SosChecker {
  return app.config.SOS_MODE === 'live' ? liveChecker() : stubChecker();
}

/** Check + stamp a business; adverse → Laura task + client fix-steps email. */
export async function runSosCheck(app: FastifyInstance, businessId: string): Promise<SosStatus | null> {
  const { rows } = await app.db.query<{
    id: string; name: string; contact_id: string | null;
    first_name: string | null; email: string | null; language: 'en' | 'es' | null;
  }>(
    `SELECT b.id, b.name, c.id AS contact_id, c.first_name, c.email, c.language
     FROM businesses b
     LEFT JOIN business_members m ON m.business_id = b.id AND m.is_primary
     LEFT JOIN contacts c ON c.id = m.contact_id
     WHERE b.id = $1`,
    [businessId]
  );
  const biz = rows[0];
  if (!biz) return null;

  const checker = makeSosChecker(app);
  let status: SosStatus;
  try {
    status = (await checker.check(biz.name)).status;
  } catch (err) {
    app.log.warn({ err, businessId }, 'sos check failed — status stays unknown');
    return null;
  }

  await app.db.query(
    `UPDATE businesses SET il_sos_status = $2::il_sos_state, il_sos_checked_at = now() WHERE id = $1`,
    [businessId, status]
  );
  await writeAudit(app.db, {
    actorType: 'system',
    action: 'sos.checked',
    objectType: 'business',
    objectId: businessId,
    contactId: biz.contact_id,
    details: { status, mode: checker.mode },
  });

  if (status === 'not_good_standing') {
    const laura = await ownerForRole(app.db, 'va_entity');
    /*
     * The restoration steps, in order — on the TASK, so the doing happens in the queue.
     * `laura-sos-restore` has one section per item explaining it, and
     * scripts/check-sop-task-alignment.mjs fails the build if the two drift apart.
     */
    const restoreSteps = [
      'Confirm the adverse result on the ILSOS site',
      'Find out why standing was lost',
      'Total what is owed and tell the client before filing',
      'File back reports oldest-first, then reinstatement',
      'Re-check standing and record the confirmation',
      'Correct the annual-report due date so the next one is caught',
    ];
    /*
     * THE TASK IS UNCONDITIONAL; only the ALERT is gated (Brian's rule).
     *
     * This one was invisible until the raw INSERT became a `createTask()` call — the guard
     * watches the function, so routing it through the one door is what exposed the gate. An
     * entity that has lost its charter and a task nobody was given are the same outcome from
     * the client's side.
     */
    await createTask(app, {
      title: `Restore good standing: ${biz.name} (IL SOS adverse result)`,
      assignedStaffId: laura,
      contactId: biz.contact_id,
      businessId,
      priority: 1,
      source: 'automation',
      sourceType: 'sos_check',
      sourceId: businessId,
      checklist: restoreSteps,
    });
    if (laura) {
      await notifyOnce(app.db, {
        staffId: laura,
        type: 'sos_not_good_standing',
        severity: 'warning',
        title: `IL SOS: ${biz.name} is NOT in good standing`,
        contactId: biz.contact_id,
        relatedObjectType: 'business',
        relatedObjectId: businessId,
      });
    }
    if (biz.email && biz.first_name) {
      await sendTemplatedEmail(app, {
        to: biz.email,
        templateKey: 'sos_fix_steps',
        language: biz.language ?? 'en',
        contactId: biz.contact_id,
        vars: { first_name: biz.first_name, business_name: biz.name },
      });
    }
  }
  return status;
}

/** Scheduled re-check (daily, date-guarded): active clients, stale checks. */
export async function runSosRecheckJob(
  app: FastifyInstance,
  today: string
): Promise<{ skipped: boolean; checked: number }> {
  const ACTION = 'job.sos_recheck';
  const already = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = $1 AND details->>'run_date' = $2 LIMIT 1`,
    [ACTION, today]
  );
  if (already.rows.length > 0) return { skipped: true, checked: 0 };

  const setting = await app.db.query<{ value: number }>(
    `SELECT (value)::text::int AS value FROM app_settings WHERE key = 'sos.recheck_days'`
  );
  const staleDays = setting.rows[0]?.value ?? 90;

  const { rows } = await app.db.query<{ id: string }>(
    `SELECT DISTINCT b.id
     FROM businesses b
     JOIN business_members m ON m.business_id = b.id
     JOIN contacts c ON c.id = m.contact_id
     WHERE c.soto_status = 'active' AND b.state = 'IL'
       AND (b.il_sos_checked_at IS NULL OR b.il_sos_checked_at < now() - make_interval(days => $1))
     LIMIT 50`,
    [staleDays]
  );
  let checked = 0;
  for (const b of rows) {
    if ((await runSosCheck(app, b.id)) !== null) checked++;
  }
  await writeAudit(app.db, {
    actorType: 'system',
    action: ACTION,
    details: { run_date: today, checked },
  });
  return { skipped: false, checked };
}
