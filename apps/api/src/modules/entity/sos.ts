/*
 * IL SECRETARY OF STATE GOOD-STANDING MONITOR — human lookup, system cadence.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * THERE IS NO AUTOMATED ILSOS LOOKUP IN THIS FILE, AND THERE MUST NOT BE ONE.
 *
 * The Illinois Secretary of State has told us IN WRITING that automated querying of their
 * search endpoints violates their Terms of Use, and that they do not whitelist. That is not a
 * technical obstacle to route around; it is the operator of the data saying no. The full
 * exchange — the block, our request, their refusal — is recorded in
 * docs/ENTITY_ILSOS_AUTOMATION.md so that nobody rebuilds this in two years having forgotten
 * why it went away.
 *
 * `scripts/check-no-sos-scraping.mjs` fails the build if any code in this repo fetches a
 * Secretary of State host. The rule is encoded rather than remembered, because the previous
 * version of this file looked entirely reasonable and ran for a month without anyone noticing
 * it had never once succeeded.
 *
 * If ILSOS's commercial bulk-data programme is contracted, THAT becomes the automated route —
 * purchased, licensed, and nothing like a scraper. Until then the lookup is a person in a
 * browser, which is both compliant and, for a book this size, entirely sufficient.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * So the shape is: the SYSTEM keeps the cadence and the SYSTEM records the answer, and a person
 * does the reading in between. `runSosRecheckJob` raises a task instead of making a request;
 * `recordSosResult` takes what the person read and does everything the old post-fetch code did.
 * Adverse results still create the restoration task, alert Laura, and (once armed) email the
 * client their fix steps.
 */

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { isAutomationEnabled } from '../../automations.ts';
import { notifyOnce, ownerForRole } from '../../staffing.ts';
import { createTask } from '../tasks/service.ts';
import { sendTemplatedEmail } from '../templates/service.ts';

/**
 * What a person can report after looking at the state's record.
 *
 * `not_found` means somebody searched and the entity genuinely is not on the register — a real,
 * serious finding about a client. It used to double as the scraper's error return, so a WAF
 * block, a timeout and a dissolved-and-struck company all wrote the same value. Nothing can
 * write it from a failure any more, because nothing fails: a human either read the record or
 * did not finish the task.
 */
export type SosStatus = 'good_standing' | 'not_good_standing' | 'not_found';

/**
 * THE VERIFICATION STEPS, on the task, so the doing happens in the queue.
 *
 * `laura-sos-verify` has one section per item explaining it, and
 * scripts/check-sop-task-alignment.mjs fails the build if the two drift apart.
 */
export const SOS_VERIFY_STEPS = [
  'Search the business on the ILSOS website',
  'Read the standing and the formation date off the record',
  'Record what you read in SAOS',
  'If it is not in good standing, stop and bring it to Brian',
];

/** The restoration steps — unchanged; `laura-sos-restore` explains each one. */
const SOS_RESTORE_STEPS = [
  'Confirm the adverse result on the ILSOS site',
  'Find out why standing was lost',
  'Total what is owed and tell the client before filing',
  'File back reports oldest-first, then reinstatement',
  'Re-check standing and record the confirmation',
  'Correct the annual-report due date so the next one is caught',
];

/**
 * Raise the "go and look" task for one business.
 *
 * Deduped by `createTask` on (source_type, source_id), so a business already carrying an open
 * verification task does not collect a second one each time the job runs.
 */
export async function requestSosVerification(
  app: FastifyInstance,
  businessId: string,
  reason: 'recheck' | 'intake' | 'enrolment'
): Promise<{ created: boolean } | null> {
  const { rows } = await app.db.query<{
    name: string; contact_id: string | null; formation_date: string | null;
  }>(
    `SELECT b.name, b.formation_date::text AS formation_date, c.id AS contact_id
       FROM businesses b
       LEFT JOIN business_members m ON m.business_id = b.id AND m.is_primary
       LEFT JOIN contacts c ON c.id = m.contact_id
      WHERE b.id = $1`,
    [businessId]
  );
  const biz = rows[0];
  if (!biz) return null;

  /*
   * ONE TRIP TO THE STATE'S WEBSITE, NOT TWO (Brian's ruling 3, 2026-09-06).
   *
   * The formation-date backfill was going to be a parse; it is the same manual lookup instead.
   * Whoever opens the ILSOS record to read the standing is looking at the formation date on the
   * same screen, so asking for it in a second task later would be sending someone back to a page
   * they already had open.
   */
  const alsoNeedsFormationDate = biz.formation_date === null;

  const result = await createTask(app, {
    title: `Verify good standing on ILSOS — ${biz.name}`,
    description:
      `Look ${biz.name} up on the Illinois Secretary of State's business search and record what ` +
      `the state says. This is a manual browser lookup on purpose: ILSOS has told us in writing ` +
      `that automated querying violates their Terms of Use, so nobody may script it.` +
      (alsoNeedsFormationDate
        ? `\n\nWHILE YOU ARE THERE: this business has no formation date on record, and Illinois ` +
          `derives the annual-report deadline from it. The date is on the same page as the ` +
          `standing — record both, so nobody has to open this record twice.`
        : ''),
    assignedStaffId: await ownerForRole(app.db, 'va_entity'),
    contactId: biz.contact_id,
    businessId,
    priority: 2,
    source: 'automation',
    sourceType: 'sos_verify',
    sourceId: businessId,
    checklist: SOS_VERIFY_STEPS,
  });
  return { created: result.created };
}

/**
 * Record what a person read off the state's record.
 *
 * This is everything the old `runSosCheck` did AFTER its fetch returned — the stamping, the
 * audit row, the adverse handling. Only the fetch is gone, and with it the only part that was
 * ever capable of being wrong about a client's entity without anyone knowing.
 */
export async function recordSosResult(
  app: FastifyInstance,
  businessId: string,
  input: { status: SosStatus; formationDate?: string | null },
  actor: { type: 'staff' | 'system'; id?: string | null; label?: string | null }
): Promise<SosStatus | null> {
  const { rows } = await app.db.query<{
    id: string; name: string; contact_id: string | null; formation_date: string | null;
    first_name: string | null; email: string | null; language: 'en' | 'es' | null;
  }>(
    `SELECT b.id, b.name, b.formation_date::text AS formation_date,
            c.id AS contact_id, c.first_name, c.email, c.language
     FROM businesses b
     LEFT JOIN business_members m ON m.business_id = b.id AND m.is_primary
     LEFT JOIN contacts c ON c.id = m.contact_id
     WHERE b.id = $1`,
    [businessId]
  );
  const biz = rows[0];
  if (!biz) return null;

  await app.db.query(
    `UPDATE businesses SET il_sos_status = $2::il_sos_state, il_sos_checked_at = now() WHERE id = $1`,
    [businessId, input.status]
  );

  /*
   * STAFF_VERIFIED, NOT SOS_REGISTER (Brian's ruling 2, 2026-09-06).
   *
   * The date was read off the state's register, so `sos_register` is tempting — and wrong. That
   * value means the system read the register itself; this is a person transcribing from a screen,
   * which can be mistyped in ways a machine read cannot. The provenance describes HOW WE CAME TO
   * HOLD the value, not how authoritative the underlying source is, and the difference is exactly
   * what someone re-reading a derived deadline later needs to know.
   *
   * An existing date is not overwritten. Whatever is there was recorded with its own provenance,
   * and this call has no way to know it is worse.
   */
  let formationDateRecorded = false;
  if (input.formationDate && !biz.formation_date) {
    await app.db.query(
      `UPDATE businesses
          SET formation_date = $2::date,
              formation_date_source = 'staff_verified',
              formation_date_recorded_at = now()
        WHERE id = $1`,
      [businessId, input.formationDate]
    );
    formationDateRecorded = true;
  }

  await writeAudit(app.db, {
    actorType: actor.type,
    actorId: actor.id ?? null,
    actorLabel: actor.label ?? null,
    action: 'sos.checked',
    objectType: 'business',
    objectId: businessId,
    contactId: biz.contact_id,
    details: {
      status: input.status,
      method: 'manual_lookup',
      formation_date_recorded: formationDateRecorded,
    },
  });

  // The "go and look" task is done the moment its answer is recorded.
  await app.db.query(
    `UPDATE tasks SET status = 'completed', completed_at = now(), updated_at = now()
      WHERE source_type = 'sos_verify' AND source_id = $1
        AND status IN ('not_started', 'in_progress', 'waiting_for_input', 'deferred')`,
    [businessId]
  );

  if (input.status === 'not_good_standing') {
    const laura = await ownerForRole(app.db, 'va_entity');
    /*
     * THE TASK IS UNCONDITIONAL; only the ALERT and the CLIENT EMAIL are gated (Brian's rule).
     * An entity that has lost its charter and a task nobody was given are the same outcome from
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
      checklist: SOS_RESTORE_STEPS,
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
    /*
     * GATED, and it was not before (found 2026-09-06).
     *
     * This is a client-facing send and it shipped with no `isAutomationEnabled()` check and no
     * row in the automations table — a build failure by CLAUDE.md's own words. It never reached
     * anyone only because the lookup that triggers it never once succeeded, which is luck rather
     * than design. Brian arms `sos_adverse_client_notice` in Admin → Automations when he wants
     * clients told automatically; until then the task and the alert carry it, and the suppression
     * is counted rather than silent.
     */
    if (biz.email && biz.first_name) {
      if (await isAutomationEnabled(app, 'sos_adverse_client_notice')) {
        await sendTemplatedEmail(app, {
          to: biz.email,
          templateKey: 'sos_fix_steps',
          language: biz.language ?? 'en',
          contactId: biz.contact_id,
          vars: { first_name: biz.first_name, business_name: biz.name },
        });
      } else {
        app.log.info(
          { businessId, automation: 'sos_adverse_client_notice' },
          'sos adverse: client notice suppressed (automation disarmed) — Laura has the task'
        );
      }
    }
  }
  return input.status;
}

/**
 * Scheduled re-check (daily, date-guarded): active IL clients whose standing is stale.
 *
 * The cadence is unchanged. What changed is the output: this used to make up to fifty HTTP
 * requests to the Secretary of State and now makes none, raising a task per business instead.
 */
export async function runSosRecheckJob(
  app: FastifyInstance,
  today: string
): Promise<{ skipped: boolean; candidates: number; tasksCreated: number; alreadyOpen: number }> {
  const ACTION = 'job.sos_recheck';
  const already = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = $1 AND details->>'run_date' = $2 LIMIT 1`,
    [ACTION, today]
  );
  if (already.rows.length > 0) {
    return { skipped: true, candidates: 0, tasksCreated: 0, alreadyOpen: 0 };
  }

  const setting = await app.db.query<{ value: number }>(
    `SELECT (value)::text::int AS value FROM app_settings WHERE key = 'sos.recheck_days'`
  );
  const staleDays = setting.rows[0]?.value ?? 90;

  const { rows } = await app.db.query<{ id: string }>(
    /*
     * The LIFECYCLE field, not the legacy `soto_status` mirror (Brian, 2026-08-17). The scope is
     * deliberately NARROWER than the annual-report one — `active` only, not `active` + `dormant`.
     * Standing is checked to catch a problem while we are acting for someone; a dormant client's
     * charter is not ours to watch weekly.
     */
    `SELECT DISTINCT b.id
     FROM businesses b
     JOIN business_members m ON m.business_id = b.id
     JOIN contacts c ON c.id = m.contact_id
     WHERE c.contact_status = 'active' AND b.state = 'IL'
       AND (b.il_sos_checked_at IS NULL OR b.il_sos_checked_at < now() - make_interval(days => $1))
     LIMIT 50`,
    [staleDays]
  );

  let tasksCreated = 0;
  let alreadyOpen = 0;
  for (const b of rows) {
    const r = await requestSosVerification(app, b.id, 'recheck');
    if (r?.created) tasksCreated++;
    else alreadyOpen++;
  }

  /*
   * The run record carries the DENOMINATOR, not just the successes. `candidates: 0` is the only
   * number that could ever have exposed the filter matching nothing, which is the state
   * production was in for a month while the record looked identical to a clean day.
   */
  await writeAudit(app.db, {
    actorType: 'system',
    action: ACTION,
    details: { run_date: today, candidates: rows.length, tasks_created: tasksCreated, already_open: alreadyOpen },
  });
  if (rows.length === 0) {
    app.log.info({ job: ACTION }, 'sos recheck: no business matched the candidate filter — no tasks raised');
  }
  return { skipped: false, candidates: rows.length, tasksCreated, alreadyOpen };
}
