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
 * Next annual-report due date strictly after `from`, per state rule.
 *  - IL: due the first day of the entity's anniversary (formation) month.
 *  - default: the formation anniversary date itself.
 * Admin can always override the stored date; this is the auto-calculation.
 */
export function nextAnnualReportDueDate(state: string, formationDate: string, from: string): string {
  const fMonth = Number(formationDate.slice(5, 7));
  const fDay = formationDate.slice(8, 10);
  const fromYear = Number(from.slice(0, 4));
  const candidate = (year: number): string =>
    state === 'IL'
      ? `${year}-${String(fMonth).padStart(2, '0')}-01`
      : `${year}-${String(fMonth).padStart(2, '0')}-${fDay}`;
  let due = candidate(fromYear);
  if (due <= from) due = candidate(fromYear + 1);
  return due;
}

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
    contact_id: string | null;
    first_name: string | null;
    email: string | null;
    language: 'en' | 'es' | null;
  }
  const loadDue = async (dueOn: string): Promise<DueRow[]> => {
    const { rows } = await app.db.query<DueRow>(
      `SELECT ec.id, ec.business_id, b.name AS business_name, ec.state,
              ec.annual_report_due_date::text AS due, ec.assigned_staff_id,
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

  // T-60: remind assigned staff (default: Laura's role) + create a task.
  let staffReminders = 0;
  for (const r of await loadDue(addDays(today, staffDays))) {
    const staffId = r.assigned_staff_id ?? (await ownerForRole(app.db, 'va_entity'));
    if (!staffId) continue;
    await notifyOnce(app.db, {
      staffId,
      type: 'annual_report_t60',
      severity: 'warning',
      title: `Annual report due ${r.due}: ${r.business_name} (${r.state})`,
      contactId: r.contact_id,
      relatedObjectType: 'entity_compliance',
      relatedObjectId: r.id,
    });
    await createTask(app, {
      title: `File annual report — ${r.business_name} (due ${r.due})`,
      assignedStaffId: staffId,
      contactId: r.contact_id,
      dueDate: r.due,
      priority: 1,
      source: 'automation',
      sourceType: 'annual_report',
      sourceId: r.id,
    });
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
  const defaultChecklist = [
    'Verify professional license (IDFPR)',
    'Confirm current entity is improperly formed for a licensed professional',
    'Advisory session scheduled with client',
    'Articles of amendment / conversion prepared',
    'Filed with IL Secretary of State',
    'EIN, bank, and insurance records updated',
  ].map((item) => ({ item, done: false }));

  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO pllc_conversions
       (contact_id, business_id, detected_via, license_type, current_entity_type, assigned_staff_id, checklist)
     VALUES ($1, $2, $3, $4, $5::business_entity_type, $6, $7::jsonb)
     RETURNING id`,
    [
      input.contactId, input.businessId ?? null, input.detectedVia ?? 'manual',
      input.licenseType, input.currentEntityType ?? null, laura, JSON.stringify(defaultChecklist),
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
    checklist: defaultChecklist.map((c) => c.item),
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
