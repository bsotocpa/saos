/*
 * ENROLMENT IN ANNUAL-REPORT TRACKING — one door (Brian's ruling (3b), 2026-08-17).
 *
 * "Enrollment as an automatic consequence of entity work going forward — a formation engagement
 * completing, or an annual-report service line activating, enrolls the entity; one door, same as
 * tasks."
 *
 * Same shape as `createTask()`, and for the same reason. Enrolment used to happen only through a
 * staff POST that no UI called, which is why `entity_compliance` held nothing at all while 619
 * businesses sat in the book. A second, third and fourth enrolment path bolted onto whichever
 * module noticed first would rebuild that problem in a new shape: the scope rule would be
 * enforced in three places and eventually in two.
 *
 * SO EVERY AUTOMATIC ENROLMENT COMES THROUGH HERE, and the scope ruling lives here once:
 *
 *   · the client is ACTIVE or DORMANT — on `contact_status`, the lifecycle field, never the
 *     legacy `soto_status` mirror;
 *   · the entity type OWES a report — `owesAnnualReport() === true`, so an unclassified or
 *     ambiguous type enrols nothing;
 *   · it is not enrolled already.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: create work when it declines. A business that is out of scope
 * is not a problem to be chased — it is a sole proprietor, or a lead, or a company nobody has
 * classified yet. The unclassified ones are already surfaced by
 * `GET /entity-compliance/unclassified`, which is the pass Brian ruled as the first task; raising
 * a task from here would be a second queue for the same fact.
 */

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { todayChicago } from '../tax/deadlines.ts';
import {
  ANNUAL_REPORT_CLIENT_STATUSES,
  nextAnnualReportDueDate,
  owesAnnualReport,
} from './service.ts';

/** Price-book items that mean "this entity is now ours to track". */
export const FORMATION_ITEM_CODES = ['ENTITY_FORMATION_EIN'];
export const ANNUAL_REPORT_ITEM_CODES = ['ENTITY_ANNUAL_REPORT'];

export type EnrolTrigger = 'formation_completed' | 'annual_report_engaged';

/**
 * Why an enrolment did not happen — returned rather than thrown, because "not in scope" is the
 * ordinary case and an exception would make the caller treat it as a failure.
 */
export type EnrolResult =
  | { enrolled: true; complianceId: string; dueDate: string | null }
  | { enrolled: false; reason: 'already_enrolled' | 'no_business' | 'client_out_of_scope' | 'type_owes_nothing' | 'type_unknown' };

export async function enrolEntityIfInScope(
  app: FastifyInstance,
  businessId: string,
  trigger: EnrolTrigger
): Promise<EnrolResult> {
  const { rows } = await app.db.query<{
    id: string;
    name: string;
    state: string | null;
    entity_type: string | null;
    formation_date: string | null;
    contact_status: string | null;
    already: string | null;
  }>(
    `SELECT b.id, b.name, b.state, b.entity_type::text AS entity_type,
            b.formation_date::text AS formation_date,
            c.contact_status::text AS contact_status,
            (SELECT ec.id FROM entity_compliance ec WHERE ec.business_id = b.id LIMIT 1) AS already
       FROM businesses b
       LEFT JOIN business_members m ON m.business_id = b.id AND m.is_primary
       LEFT JOIN contacts c ON c.id = m.contact_id
      WHERE b.id = $1`,
    [businessId]
  );
  const biz = rows[0];
  if (!biz) return { enrolled: false, reason: 'no_business' };
  if (biz.already) return { enrolled: false, reason: 'already_enrolled' };

  if (!biz.contact_status || !ANNUAL_REPORT_CLIENT_STATUSES.includes(biz.contact_status)) {
    return { enrolled: false, reason: 'client_out_of_scope' };
  }

  const owes = owesAnnualReport(biz.entity_type);
  // Three answers, and they are not interchangeable: `false` is a decision, `null` is a question.
  if (owes === false) return { enrolled: false, reason: 'type_owes_nothing' };
  if (owes === null) return { enrolled: false, reason: 'type_unknown' };

  const state = biz.state ?? 'IL';
  const dueDate = nextAnnualReportDueDate(state, biz.formation_date, todayChicago());

  const ins = await app.db.query<{ id: string }>(
    `INSERT INTO entity_compliance (business_id, state, annual_report_due_date, status)
     VALUES ($1, $2, $3, 'unknown') RETURNING id`,
    [businessId, state, dueDate]
  );
  const complianceId = ins.rows[0]!.id;

  await writeAudit(app.db, {
    actorType: 'system',
    action: 'entity_compliance.enrolled',
    objectType: 'entity_compliance',
    objectId: complianceId,
    details: { business_id: businessId, trigger, state, due_date: dueDate, entity_type: biz.entity_type },
  });

  /*
   * A null due date is the "invisible, not pending" case: the status sweep skips it and both
   * reminder loops load by exact due date. The staff route raises a "Find the formation date"
   * task for exactly this, and an automatic enrolment must not be quieter than a manual one —
   * it is MORE likely to go unnoticed, because nobody was watching when it happened.
   */
  if (dueDate === null && state === 'IL') {
    /*
     * ILLINOIS RIDES THE ILSOS VERIFICATION TASK (Brian's ruling 3, 2026-09-06) — the same trip
     * that reads the standing reads the formation date. Same choice as the staff enrolment route,
     * made in both places because both create compliance rows.
     */
    const { requestSosVerification } = await import('./sos.ts');
    await requestSosVerification(app, businessId, 'enrolment');
  } else if (dueDate === null) {
    const { createTask } = await import('../tasks/service.ts');
    const { ownerForRole } = await import('../../staffing.ts');
    await createTask(app, {
      title: `Find the formation date — ${biz.name} (${state})`,
      description:
        `${biz.name} was enrolled in annual-report tracking automatically (${trigger}), but ` +
        `${state}'s rule derives the deadline from the formation date and we do not have one. ` +
        `Until it is recorded, NO reminder will fire for this business — not T-60 to staff, not ` +
        `T-30 to the client. Get the date from the Secretary of State's record and save it on ` +
        `the business, with its source.`,
      assignedStaffId: await ownerForRole(app.db, 'va_entity'),
      businessId,
      priority: 1,
      source: 'automation',
      sourceType: 'annual_report_setup',
      sourceId: complianceId,
    });
  }

  return { enrolled: true, complianceId, dueDate };
}

/**
 * Enrol from an engagement, if its scope says this is entity work.
 *
 * The trigger is the SCOPE ITEM, not the service line. `entity` covers amendments, DBAs, BOI
 * reports and S-corp conversions as well — none of which mean we now track an annual report —
 * so keying on the service line would enrol a client who asked us to file one BOI report. The
 * scope items are the snapshot of what was actually agreed (#47), which is the honest source.
 */
export async function enrolFromEngagement(
  app: FastifyInstance,
  engagementId: string,
  trigger: EnrolTrigger
): Promise<EnrolResult | null> {
  const codes = trigger === 'formation_completed' ? FORMATION_ITEM_CODES : ANNUAL_REPORT_ITEM_CODES;
  const { rows } = await app.db.query<{ business_id: string | null }>(
    `SELECT e.business_id
       FROM engagements e
      WHERE e.id = $1
        AND EXISTS (SELECT 1 FROM engagement_scope_items s
                     WHERE s.engagement_id = e.id AND s.item_code = ANY($2::text[]))`,
    [engagementId, codes]
  );
  const businessId = rows[0]?.business_id;
  // No matching scope item, or an engagement with no business: not entity work, nothing to do.
  if (!businessId) return null;
  return enrolEntityIfInScope(app, businessId, trigger);
}
