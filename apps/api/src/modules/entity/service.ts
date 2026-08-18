// Entity compliance (Laura's module, MP Bookkeeping & Advisory → Entity):
// annual-report due dates per state rules, T-60 staff / T-30 client
// reminders, and the PLLC-conversion pipeline (v4.2 new service line —
// Illinois requires licensed professionals to organize as PLLC; an existing
// LLC is improperly formed).

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { isAutomationEnabled } from '../../automations.ts';
import { firstActiveByRole, notifyOnce, ownerForRole } from '../../staffing.ts';
import { createTask } from '../tasks/service.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { addDays } from '../tax/deadlines.ts';

/**
 * A state's annual-report rule, as a SHAPE rather than a date.
 *
 * States differ structurally, not just in which day they picked, and collapsing that into "one
 * date function" is how a rule gets mis-modelled:
 *
 *   · ANNIVERSARY-BASED (Illinois) — every entity has its own date, derived from formation.
 *   · UNIFORM-DEADLINE (Florida) — one day a year for everyone, and formation date is irrelevant
 *     to it. Florida's formation date matters only for WHICH YEAR the first report is due.
 *
 * `firstDueYear` exists for that second half. It is optional because it must only be set where
 * the rule has actually been read: asserting "the first report is due the year after formation"
 * for a state nobody has checked would be inventing law, which is the thing
 * RESEARCHED_ANNUAL_REPORT_STATES exists to prevent.
 */
interface AnnualReportRule {
  /** The due date falling in a given calendar year. */
  candidate: (year: number, formationDate: string) => string;
  /** First calendar year in which a report is due at all. Omit unless researched. */
  firstDueYear?: (formationDate: string) => number;
}

const month = (d: string) => d.slice(5, 7);
const day = (d: string) => d.slice(8, 10);
const yearOf = (d: string) => Number(d.slice(0, 4));

const STATE_RULES: Record<string, AnnualReportRule> = {
  /**
   * ILLINOIS — anniversary-based: due the first day of the entity's anniversary month.
   * Pre-existing behaviour, unchanged. No `firstDueYear`: that half was never researched, and
   * adding an assumption here would change every existing Illinois record silently.
   */
  IL: { candidate: (y, f) => `${y}-${month(f)}-01` },

  /**
   * FLORIDA — UNIFORM DEADLINE. Every entity, every year, May 1. Formation date does not move
   * it; a company formed on 19 July is still due 1 May, like everyone else.
   *
   * Fla. Stat. § 605.0212 (LLCs) and § 607.1622 (corporations), both:
   *   "The first annual report must be delivered to the department between January 1 and May 1
   *    of the year FOLLOWING the calendar year in which the [articles] became effective …
   *    Subsequent annual reports must be delivered … between January 1 and May 1 of each
   *    calendar year thereafter."
   *
   * So formation date is load-bearing exactly once — the first report is skipped in the
   * formation year — and irrelevant every year after. That is the whole shape, and it is why
   * this could not be expressed by tweaking the anniversary calculation.
   */
  FL: {
    candidate: (y) => `${y}-05-01`,
    firstDueYear: (f) => yearOf(f) + 1,
  },
};

/**
 * Next annual-report due date strictly after `from`, per state rule.
 *
 * States with no entry fall back to the formation anniversary. That fallback is a reasonable
 * default and NOT a researched rule — which is why a state absent from
 * RESEARCHED_ANNUAL_REPORT_STATES escalates its T-60 task to Brian instead of going to Laura to
 * file against it. Both come out looking like a confident date; only the set says which is real.
 *
 * Admin can always override the stored date; this is the auto-calculation.
 */
export function nextAnnualReportDueDate(state: string, formationDate: string, from: string): string {
  const rule = STATE_RULES[state];
  const candidate = rule
    ? (y: number) => rule.candidate(y, formationDate)
    : (y: number) => `${y}-${month(formationDate)}-${day(formationDate)}`;

  const fromYear = yearOf(from);
  let dueYear = fromYear;
  if (candidate(dueYear) <= from) dueYear += 1;

  // A state that does not require a report until some later year (Florida: the year after
  // formation) cannot have one due before it.
  const first = rule?.firstDueYear?.(formationDate);
  if (first !== undefined && dueYear < first) dueYear = first;

  return candidate(dueYear);
}

/*
 * STATES WHOSE ANNUAL-REPORT RULE WE HAVE ACTUALLY RESEARCHED (Brian's ruling 2026-08-17).
 *
 * `nextAnnualReportDueDate` derives Illinois from the real rule — first day of the anniversary
 * month — and everything else from a plain formation-anniversary fallback. That fallback is a
 * reasonable default, not a researched one, and the difference is invisible in the output: both
 * return a confident-looking date.
 *
 * So a non-researched state does NOT go to Laura to file against a guess. The T-60 task routes
 * to Brian to confirm the state's rule first. Adding a state here after researching it is the
 * one-line change that makes those tasks routine again.
 *
 * The book today: IL 603, FL 8, CO 3, and one each in WI, IN, AZ, TX, AR — seven states to
 * research, not fifty. FL was done first because it is the only non-IL state with real volume.
 *
 * A state belongs here when its rule has been read from a PRIMARY source and encoded in
 * STATE_RULES — the statute or the Secretary of State's own published requirement, never a
 * summary of one. The cites are in each state's rule and in Laura's SOP.
 */
export const RESEARCHED_ANNUAL_REPORT_STATES = new Set(['IL', 'FL']);

/** Daily reminder job (date-guarded like the extension jobs). */
export async function runEntityComplianceJob(
  app: FastifyInstance,
  today: string
): Promise<{ skipped: boolean; staffReminders: number; clientReminders: number }> {
  const ACTION = 'job.entity_compliance';
  const already = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = $1 AND details->>'run_date' = $2 LIMIT 1`,
    [ACTION, today]
  );
  if (already.rows.length > 0) return { skipped: true, staffReminders: 0, clientReminders: 0 };

  const settings = await app.db.query<{ key: string; value: number }>(
    `SELECT key, (value)::text::int AS value FROM app_settings
     WHERE key IN ('annual_report.staff_reminder_days_before', 'annual_report.client_reminder_days_before')`
  );
  const staffDays = settings.rows.find((r) => r.key === 'annual_report.staff_reminder_days_before')?.value ?? 60;
  const clientDays = settings.rows.find((r) => r.key === 'annual_report.client_reminder_days_before')?.value ?? 30;

  // Status upkeep: due_soon within the staff window, overdue past due.
  await app.db.query(
    `UPDATE entity_compliance SET status = CASE
       WHEN annual_report_due_date < $1::date THEN 'overdue'::compliance_status
       WHEN annual_report_due_date <= $1::date + $2::int THEN 'due_soon'::compliance_status
       ELSE 'good'::compliance_status END
     WHERE annual_report_due_date IS NOT NULL AND status <> 'filed'`,
    [today, staffDays]
  );

  interface DueRow {
    id: string;
    business_id: string;
    business_name: string;
    state: string;
    due: string;
    assigned_staff_id: string | null;
    formation_date: string | null;
    due_date_override_reason: string | null;
    contact_id: string | null;
    first_name: string | null;
    email: string | null;
    language: 'en' | 'es' | null;
  }
  const loadDue = async (dueOn: string): Promise<DueRow[]> => {
    const { rows } = await app.db.query<DueRow>(
      `SELECT ec.id, ec.business_id, b.name AS business_name, ec.state,
              ec.annual_report_due_date::text AS due, ec.assigned_staff_id,
              ec.formation_date::text AS formation_date,
              ec.due_date_override_reason,
              c.id AS contact_id, c.first_name, c.email, c.language
       FROM entity_compliance ec
       JOIN businesses b ON b.id = ec.business_id
       LEFT JOIN business_members m ON m.business_id = b.id AND m.is_primary
       LEFT JOIN contacts c ON c.id = m.contact_id
       WHERE ec.annual_report_due_date = $1::date`,
      [dueOn]
    );
    return rows;
  };

  /*
   * The annual-report steps, in order — on the TASK, so the doing happens in the queue.
   * `laura-annual-report` has one section per item explaining it, and
   * scripts/check-sop-task-alignment.mjs fails the build if the two drift apart.
   */
  const annualReportSteps = [
    'Confirm the state and the actual due date',
    'Check IL SOS good standing before filing',
    'File the report and pay the fee',
    'Record the filing in SAOS so the next due date rolls',
    'Store the stamped confirmation on the business record',
  ];

  // T-60: remind assigned staff (default: Laura's role) + create a task.
  let staffReminders = 0;
  for (const r of await loadDue(addDays(today, staffDays))) {
    /*
     * TWO THINGS THE SYSTEM DECIDES BEFORE HANDING THIS OVER (Brian's rulings 2026-08-17).
     * Both were drafted as "Laura notices and stops", and the system can notice for her — which
     * is strictly better, because a stop-point only works if the person spots the condition.
     *
     * 1. A state whose rule we have not researched. Illinois is derived from the real rule;
     *    everything else falls back to the formation anniversary, and the two look identical
     *    coming out. So it goes to Brian to confirm the state's rule, not to Laura to file.
     * 2. A stored due date that disagrees with the derivation, with no recorded override. An
     *    admin override and a wrong date are indistinguishable in advance, so Laura never picks
     *    between them — Brian gets BOTH dates. If a reason IS recorded, the disagreement is
     *    already explained and this is routine, which is exactly what recording it was for.
     */
    const stateResearched = RESEARCHED_ANNUAL_REPORT_STATES.has(r.state);
    /*
     * The derived date FOR THE STORED DATE'S OWN PERIOD.
     *
     * `nextAnnualReportDueDate` returns the next due date strictly AFTER `from`, so `from` has to
     * sit before that period's candidate or the comparison comes back a year out and every row
     * looks like a mismatch. The last day of the previous year is before any candidate in the
     * stored date's year and after every candidate in the one before it.
     */
    const periodStart = `${Number(r.due.slice(0, 4)) - 1}-12-31`;
    const derived =
      r.formation_date ? nextAnnualReportDueDate(r.state, r.formation_date, periodStart) : null;
    const unexplainedMismatch =
      derived !== null && derived !== r.due && !r.due_date_override_reason;

    const escalate = !stateResearched || unexplainedMismatch;
    const laura = r.assigned_staff_id ?? (await ownerForRole(app.db, 'va_entity'));
    const owner = escalate ? await ownerForRole(app.db, 'ceo') : laura;

    const why = [
      !stateResearched
        ? `${r.state} annual-report rules are NOT researched — the stored date comes from a ` +
          `formation-anniversary fallback, not that state's rule. Confirm the rule before anything ` +
          `is filed, then add '${r.state}' to RESEARCHED_ANNUAL_REPORT_STATES so future ones are routine.`
        : null,
      unexplainedMismatch
        ? `The stored due date (${r.due}) disagrees with the derived date (${derived}) and no ` +
          `override reason is recorded. Verify against the state's own record, then rule — and ` +
          `record the reason on the compliance row so the next disagreement is already answered.`
        : null,
    ].filter(Boolean);

    await createTask(app, {
      title: escalate
        ? `Annual report NEEDS A RULING — ${r.business_name} (${r.state}, due ${r.due})`
        : `File annual report — ${r.business_name} (due ${r.due})`,
      description: why.length > 0 ? why.join('\n\n') : null,
      assignedStaffId: owner,
      contactId: r.contact_id,
      dueDate: r.due,
      priority: 1,
      source: 'automation',
      sourceType: 'annual_report',
      sourceId: r.id,
      checklist: annualReportSteps,
    });
    // Alerts need a real person; the task above is the durable record either way.
    if (owner) {
      await notifyOnce(app.db, {
        staffId: owner,
        type: 'annual_report_t60',
        severity: 'warning',
        title: escalate
          ? `Annual report needs a ruling: ${r.business_name} (${r.state}) due ${r.due}`
          : `Annual report due ${r.due}: ${r.business_name} (${r.state})`,
        contactId: r.contact_id,
        relatedObjectType: 'entity_compliance',
        relatedObjectId: r.id,
      });
    }
    staffReminders++;
  }

  // T-30: remind the client in their language (kill-switch gated; the T-60
  // staff reminder + compliance task above are internal and always run).
  let clientReminders = 0;
  let suppressed = 0;
  const clientRemindersArmed = await isAutomationEnabled(app, 'annual_report_client_reminders');
  for (const r of await loadDue(addDays(today, clientDays))) {
    if (!r.email || !r.first_name) continue;
    if (!clientRemindersArmed) { suppressed++; continue; }
    await sendTemplatedEmail(app, {
      to: r.email,
      templateKey: 'annual_report_reminder',
      language: r.language ?? 'en',
      contactId: r.contact_id,
      vars: { first_name: r.first_name, business_name: r.business_name, due_date: r.due, state: r.state },
    });
    clientReminders++;
  }

  await writeAudit(app.db, {
    actorType: 'system',
    action: ACTION,
    details: { run_date: today, staff_reminders: staffReminders, client_reminders: clientReminders, suppressed, automation_disabled: !clientRemindersArmed },
  });
  return { skipped: false, staffReminders, clientReminders };
}

/** PLLC conversion flag — called manually AND by Module I firing (M14). */
export async function createPllcConversion(
  app: FastifyInstance,
  actor: { type: 'staff' | 'system'; id?: string | null; label?: string | null },
  input: {
    contactId: string;
    businessId?: string | undefined;
    licenseType: string;
    currentEntityType?: string | undefined;
    detectedVia?: string | undefined;
  }
): Promise<{ id: string }> {
  const laura = await ownerForRole(app.db, 'va_entity');
  // The conversion steps, in order. They go on the TASK; nothing stores them on the row.
  const conversionSteps = [
    'Verify professional license (IDFPR)',
    'Confirm current entity is improperly formed for a licensed professional',
    'Advisory session scheduled with client',
    'Articles of amendment / conversion prepared',
    'Filed with IL Secretary of State',
    'EIN, bank, and insurance records updated',
  ];

  /*
   * No `checklist` column any more (2026-08-17). The six steps go onto the TASK below, which is
   * the one source: assigned, visible in My Tasks, tickable through the endpoints that already
   * exist. Writing both would be two lists that can disagree about the same work.
   */
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO pllc_conversions
       (contact_id, business_id, detected_via, license_type, current_entity_type, assigned_staff_id)
     VALUES ($1, $2, $3, $4, $5::business_entity_type, $6)
     RETURNING id`,
    [
      input.contactId, input.businessId ?? null, input.detectedVia ?? 'manual',
      input.licenseType, input.currentEntityType ?? null, laura,
    ]
  );
  const id = rows[0]!.id;

  /*
   * THE CONVERSION IS WORK, SO IT IS A TASK (Brian's ruling 2026-08-17).
   *
   * This row had an `assigned_staff_id`, a six-item `checklist`, and two notifications — and
   * NO task. So Laura's name on the row was the only thing pointing at action, which is
   * precisely "a module-row staff_id standing in for a task". The row stays as domain
   * attribution: it records who owns the conversion and how far it has got. The TASK is what
   * assigns the work, and it carries the same six steps so the queue is where the doing
   * happens.
   *
   * `sourceId` is the conversion id: flagging the same one twice — Module I firing plus a
   * manual flag — is one piece of work, and `createTask()` dedupes on it.
   */
  await createTask(app, {
    title: `PLLC conversion — ${input.licenseType} (improperly formed entity)`,
    description:
      'Illinois requires licensed professionals to organize as a PLLC; this client is not. ' +
      'Work the checklist below with the client, then record the outcome on the conversion record.',
    assignedStaffId: laura,
    contactId: input.contactId,
    ...(input.businessId ? { businessId: input.businessId } : {}),
    priority: 1,
    source: 'automation',
    sourceType: 'pllc_conversion',
    sourceId: id,
    checklist: conversionSteps,
  });
  if (laura) {
    await notifyOnce(app.db, {
      staffId: laura,
      type: 'pllc_conversion_flagged',
      severity: 'warning',
      title: `PLLC conversion opportunity flagged (${input.licenseType})`,
      contactId: input.contactId,
      relatedObjectType: 'pllc_conversion',
      relatedObjectId: id,
    });
  }
  // Advisory flag → Brian (this IS the new service pipeline, OF Module I).
  const brian = await firstActiveByRole(app.db, 'ceo');
  if (brian) {
    await notifyOnce(app.db, {
      staffId: brian,
      type: 'pllc_advisory_flag',
      severity: 'info',
      title: `Advisory opportunity: PLLC conversion (${input.licenseType})`,
      contactId: input.contactId,
      relatedObjectType: 'pllc_conversion',
      relatedObjectId: id,
    });
  }
  await writeAudit(app.db, {
    actorType: actor.type,
    actorId: actor.id ?? null,
    actorLabel: actor.label ?? null,
    action: 'pllc_conversion.flagged',
    objectType: 'pllc_conversion',
    objectId: id,
    contactId: input.contactId,
    details: { license_type: input.licenseType, detected_via: input.detectedVia ?? 'manual' },
  });
  return { id };
}
