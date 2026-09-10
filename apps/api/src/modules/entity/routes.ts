import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { ownerForRole } from '../../staffing.ts';
import { createTask } from '../tasks/service.ts';
import { todayChicago } from '../tax/deadlines.ts';
import { recordSosResult, requestSosVerification } from './sos.ts';
import {
  ANNUAL_REPORT_CLIENT_STATUSES,
  RESEARCHED_ANNUAL_REPORT_STATES,
  createPllcConversion,
  nextAnnualReportDueDate,
  runEntityComplianceJob,
} from './service.ts';

const CreateComplianceBody = z.object({
  businessId: z.uuid(),
  state: z.string().length(2).optional(),
  formationDate: z.iso.date().optional(),
  annualReportDueDate: z.iso.date().optional(), // manual override; otherwise derived per state rule
  assignedStaffId: z.uuid().optional(),
});

const FiledBody = z.object({ filedDate: z.iso.date() });

/*
 * What a person can report from the ILSOS record. No 'blocked' and no error state: a human
 * either read the register or did not finish the task, and an unfinished task is not a fact about
 * the client's entity. That distinction is the whole reason the scraper had to go — it wrote
 * 'not_found' when it was refused, which reads as "the state has no record of this company".
 */
const SosResultBody = z.object({
  status: z.enum(['good_standing', 'not_good_standing', 'not_found']),
  formationDate: z.iso.date().optional(),
});

const CreatePllcBody = z.object({
  contactId: z.uuid(),
  businessId: z.uuid().optional(),
  licenseType: z.string().min(1),
  currentEntityType: z.enum(['sole_prop', 'llc', 'pllc', 's_corp', 'c_corp', 'partnership', 'nonprofit', 'coop', 'not_sure', 'other']).optional(),
  detectedVia: z.string().optional(),
});

const UpdatePllcBody = z.object({
  status: z.enum(['flagged', 'client_notified', 'advisory_scheduled', 'in_progress', 'filed', 'completed', 'dismissed']).optional(),
  licenseVerified: z.boolean().optional(),
  checklist: z.array(z.object({ item: z.string(), done: z.boolean() })).optional(),
  notes: z.string().optional(),
});

export function registerEntityRoutes(app: FastifyInstance): void {
  const manage = { preHandler: [app.authenticate, requirePermission('entity.manage')] };

  app.post('/entity-compliance', manage, async (request, reply) => {
    const b = CreateComplianceBody.parse(request.body);
    const biz = await app.db.query<{
      id: string; name: string; state: string; formation_date: string | null;
    }>(
      `SELECT id, name, state, formation_date::text AS formation_date FROM businesses WHERE id = $1`,
      [b.businessId]
    );
    const business = biz.rows[0];
    if (!business) throw new AppError(404, 'not_found', 'Business not found.');
    const state = b.state ?? business.state ?? 'IL';

    /*
     * The formation date lives on the BUSINESS (0078), so a date supplied at enrolment is
     * recorded there with its provenance rather than copied onto the compliance row. A date
     * already on the business wins nothing and loses nothing — it is the same fact — but it is
     * NOT overwritten by this route: whatever is there was recorded with a source, and an
     * enrolment form has no way to know it is better.
     */
    const formationDate = business.formation_date ?? b.formationDate ?? null;
    if (b.formationDate && !business.formation_date) {
      await app.db.query(
        `UPDATE businesses
            SET formation_date = $2::date,
                formation_date_source = $3,
                formation_date_recorded_at = now()
          WHERE id = $1`,
        // `staff_verified` and not `sos_register`: a person typed this into a form. Claiming the
        // state's register as the source for a hand-entered date is exactly the provenance lie
        // the source stamp exists to prevent.
        [b.businessId, b.formationDate, 'staff_verified']
      );
    }

    // No `formationDate ?` guard: the derivation decides whether it can work without one. A
    // uniform-deadline state can, so a Florida business enrols with a real 1 May date even
    // though nobody recorded when it was formed.
    const due = b.annualReportDueDate ?? nextAnnualReportDueDate(state, formationDate, todayChicago());

    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO entity_compliance (business_id, assigned_staff_id, state, annual_report_due_date, status)
       VALUES ($1, $2, $3, $4, 'unknown') RETURNING id`,
      [b.businessId, b.assignedStaffId ?? null, state, due]
    );
    const complianceId = rows[0]!.id;

    /*
     * A COMPLIANCE ROW WITH NO DUE DATE IS INVISIBLE, NOT PENDING.
     *
     * The daily status sweep skips it (`WHERE annual_report_due_date IS NOT NULL`) and the T-60
     * and T-30 loops load by exact due date, so nothing will ever fire for it. It sits in the
     * compliance list looking enrolled, with a blank date, and no reminder is coming — absence
     * with no record of absence, the same family as the role that did not exist.
     *
     * So the missing date is work, and work is a task. `annual_report_setup` rather than
     * `annual_report` on purpose: createTask dedupes on (source_type, source_id), and this row
     * IS the T-60's source_id — sharing the type would make this task swallow the filing task
     * later, the moment the date is finally known.
     */
    if (due === null) {
      /*
       * ILLINOIS GOES TO THE ILSOS TASK, NOT A SECOND ONE (Brian's ruling 3, 2026-09-06).
       *
       * "Illinois formation-date backfill becomes part of the same manual task at enrolment, not
       * a parse." Whoever verifies standing has the formation date on the same screen, so an IL
       * business with no date raises the verification task — which says explicitly that both are
       * wanted — instead of a separate errand to the same website.
       *
       * Every other state still gets its own task: there is no ILSOS trip to piggyback on, and
       * the date has to come from that state's register or the client's own paperwork.
       */
      if (state === 'IL') {
        await requestSosVerification(app, b.businessId, 'enrolment');
      } else {
        const owner = b.assignedStaffId ?? (await ownerForRole(app.db, 'va_entity'));
        await createTask(app, {
          title: `Find the formation date — ${business.name} (${state})`,
          description:
            `${business.name} is enrolled in annual-report tracking with no due date, because ` +
            `${state}'s rule derives the deadline from the formation date and we do not have one. ` +
            `Until it is recorded, NO reminder will fire for this business — not T-60 to staff, not ` +
            `T-30 to the client. Get the formation date from ${state}'s Secretary of State record ` +
            `and save it on the business with its source; the due date derives itself from there.`,
          assignedStaffId: owner,
          ...(b.businessId ? { businessId: b.businessId } : {}),
          priority: 1,
          source: 'automation',
          sourceType: 'annual_report_setup',
          sourceId: complianceId,
        });
      }
    }
    return reply.code(201).send({ id: complianceId, annualReportDueDate: due });
  });

  app.get('/entity-compliance', manage, async () => {
    const { rows } = await app.db.query(
      `SELECT ec.id, ec.state, b.formation_date, b.formation_date_source,
              ec.annual_report_due_date, ec.status,
              ec.last_filed_date, ec.assigned_staff_id, b.id AS business_id, b.name AS business_name
       FROM entity_compliance ec JOIN businesses b ON b.id = ec.business_id
       ORDER BY ec.annual_report_due_date NULLS LAST`
    );
    return { records: rows };
  });

  /*
   * THE CLASSIFY-ENTITY-TYPE PASS (Brian's ruling, 2026-08-17: "the entity_type gap is the real
   * first task … rather than a new mechanism — that's what the enrichment view exists for").
   *
   * A view over the existing gap, not a new queue: it reads `businesses.entity_type IS NULL`,
   * which is the same fact `business:entity_type` in the enrichment queue reports.
   *
   * IT LIVES HERE, NOT IN THE REPORTS MODULE. It was written there first and the spec stopped
   * it — v4.6 line 624 enumerates the Reports & KPIs module as exactly seven owner-facing
   * analytics, and an operational worklist is not one of them. It belongs beside the enrolment
   * it unblocks, behind the same `entity.manage` permission that does the enrolling.
   *
   * Ordered by what the answer is worth: a researched state on an in-scope client enrols the
   * moment someone types its type; an out-of-scope one will not enrol whatever the answer is,
   * and should not compete with it for attention.
   */
  app.get('/entity-compliance/unclassified', manage, async () => {
    const { rows } = await app.db.query(
      `SELECT b.id AS business_id, b.name AS business_name, b.state,
              COALESCE(c.contact_status::text, 'no client') AS client_status,
              (b.state = ANY($1::text[])) AS state_researched,
              CASE
                WHEN COALESCE(c.contact_status::text, '') <> ALL($2::text[])
                  THEN 'nothing yet — client is not active or dormant'
                WHEN b.state = ANY($1::text[])
                  THEN 'enrolment in annual-report tracking'
                ELSE 'enrolment, then a rule ruling from Brian'
              END AS unblocks
       FROM businesses b
       LEFT JOIN business_members m ON m.business_id = b.id AND m.is_primary
       LEFT JOIN contacts c ON c.id = m.contact_id
       WHERE b.entity_type IS NULL
       ORDER BY (COALESCE(c.contact_status::text, '') = ANY($2::text[])) DESC,
                (b.state = ANY($1::text[])) DESC,
                b.state, b.name`,
      [[...RESEARCHED_ANNUAL_REPORT_STATES], ANNUAL_REPORT_CLIENT_STATUSES]
    );
    return {
      businesses: rows,
      /*
       * Stated with the data rather than left for the reader to assume. An unknown entity type is
       * "we have not asked", never "owes nothing" — and `partnership` stays unresolved because
       * the enum cannot tell a general partnership (registers nothing) from an LP or LLP.
       */
      caveat:
        'An unknown entity type is not "owes nothing" — it is "we have not asked". Nothing enrols ' +
        'on an unknown, and nothing is assumed in either direction: manufacturing an obligation is ' +
        'worse than missing one. Client scope is active or inactive ("dormant"); leads and former ' +
        'clients are listed but marked, because they are not ours to file for.',
    };
  });

  /*
   * RECORDING WHAT A PERSON READ ON THE ILSOS SITE (Brian's ruling 2, 2026-09-06).
   *
   * This is the other half of the manual lookup: the system raised the task, a human did the
   * reading, and this is where the answer comes back in. It does everything the old scraper's
   * post-fetch code did — stamps the business, audits, closes the verification task, and raises
   * the restoration task on an adverse result.
   *
   * The formation date rides along because the person is already looking at it (ruling 3): the
   * Illinois backfill is this task, not a parse.
   */
  app.post<{ Params: { id: string } }>('/businesses/:id/sos-result', manage, async (request) => {
    const businessId = z.uuid().parse(request.params.id);
    const b = SosResultBody.parse(request.body);
    const actor = request.staff!;

    const status = await recordSosResult(
      app,
      businessId,
      { status: b.status, formationDate: b.formationDate ?? null },
      { type: 'staff', id: actor.id, label: actor.fullName }
    );
    if (status === null) throw new AppError(404, 'not_found', 'Business not found.');
    return { status: 'ok', sosStatus: status };
  });

  // Filed → history row + roll the due date to the next period.
  app.post<{ Params: { id: string } }>('/entity-compliance/:id/filed', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = FiledBody.parse(request.body);
    const { rows } = await app.db.query<{
      id: string; state: string; formation_date: string | null; annual_report_due_date: string | null;
    }>(
      `SELECT ec.id, ec.state, b.formation_date::text AS formation_date,
              ec.annual_report_due_date::text AS annual_report_due_date
       FROM entity_compliance ec JOIN businesses b ON b.id = ec.business_id
       WHERE ec.id = $1`,
      [id]
    );
    const rec = rows[0];
    if (!rec) throw new AppError(404, 'not_found', 'Compliance record not found.');
    if (!rec.annual_report_due_date) throw new AppError(400, 'no_due_date', 'No annual report due date on record.');

    const periodYear = Number(rec.annual_report_due_date.slice(0, 4));
    await app.db.query(
      `INSERT INTO annual_report_filings (entity_compliance_id, period_year, due_date, filed_date, status)
       VALUES ($1, $2, $3, $4, 'filed')
       ON CONFLICT (entity_compliance_id, period_year)
       DO UPDATE SET filed_date = EXCLUDED.filed_date, status = 'filed'`,
      [id, periodYear, rec.annual_report_due_date, b.filedDate]
    );
    /*
     * Roll to the next period. The formation date goes in as itself — it used to be faked from
     * the due date when missing, which happened to give the right answer for Florida and would
     * quietly stop doing so for the next state with a first-year rule: `firstDueYear` would be
     * reading a filing deadline as a formation date.
     *
     * When the rule cannot derive without one, the stored date rolls a year rather than being
     * wiped — a compliance row with no due date is invisible to every job that matters.
     */
    const nextDue =
      nextAnnualReportDueDate(rec.state, rec.formation_date, rec.annual_report_due_date) ??
      `${Number(rec.annual_report_due_date.slice(0, 4)) + 1}${rec.annual_report_due_date.slice(4)}`;
    await app.db.query(
      `UPDATE entity_compliance
       SET last_filed_date = $2, annual_report_due_date = $3, status = 'filed'
       WHERE id = $1`,
      [id, b.filedDate, nextDue]
    );
    await writeAudit(app.db, {
      actorType: 'staff', actorId: request.staff!.id, actorLabel: request.staff!.fullName,
      action: 'annual_report.filed', objectType: 'entity_compliance', objectId: id,
      details: { period_year: periodYear, next_due: nextDue },
    });
    return { status: 'ok', nextDueDate: nextDue };
  });

  // ── PLLC conversions (v4.2 new service line) ────────────────────────────
  app.post('/pllc-conversions', manage, async (request, reply) => {
    const b = CreatePllcBody.parse(request.body);
    const result = await createPllcConversion(
      app,
      { type: 'staff', id: request.staff!.id, label: request.staff!.fullName },
      b
    );
    return reply.code(201).send(result);
  });

  /*
   * THE CHECKLIST COMES FROM THE TASK (Brian's ruling 2026-08-17).
   *
   * `pllc_conversions.checklist` was a module-local to-do list — the thing CLAUDE.md forbids —
   * and once the conversion started spawning a real task, the same six steps existed in two
   * places that could disagree. The task is the one source: it is where the work is assigned,
   * where it shows in My Tasks, and where the existing `/tasks/:id/checklist` endpoints already
   * tick items off.
   *
   * `taskId` is returned so a UI has somewhere to POST a tick to. Nullable on purpose:
   * conversions created before the task existed have none, and inventing one on read would be
   * a write hiding in a GET.
   */
  app.get('/pllc-conversions', manage, async () => {
    const { rows } = await app.db.query(
      `SELECT p.id, p.status, p.license_type, p.current_entity_type, p.license_verified,
              p.detected_via, p.assigned_staff_id,
              c.id AS contact_id, c.first_name, c.last_name, b.name AS business_name,
              t.id AS task_id,
              COALESCE(
                (SELECT json_agg(json_build_object('id', i.id, 'item', i.label, 'done', i.done)
                                 ORDER BY i.position)
                   FROM task_checklist_items i WHERE i.task_id = t.id),
                '[]'::json
              ) AS checklist
       FROM pllc_conversions p
       JOIN contacts c ON c.id = p.contact_id
       LEFT JOIN businesses b ON b.id = p.business_id
       LEFT JOIN tasks t
         ON t.source_type = 'pllc_conversion' AND t.source_id = p.id::text
       ORDER BY p.created_at DESC`
    );
    return { conversions: rows };
  });

  app.patch<{ Params: { id: string } }>('/pllc-conversions/:id', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = UpdatePllcBody.parse(request.body);
    const sets: string[] = [];
    const params: unknown[] = [id];
    if (b.status !== undefined) { params.push(b.status); sets.push(`status = $${params.length}::pllc_status`); }
    if (b.licenseVerified !== undefined) { params.push(b.licenseVerified); sets.push(`license_verified = $${params.length}`); }
    /*
     * REFUSED, not silently dropped. Removing `checklist` from the schema would have zod strip
     * it and return 200, so a caller ticking an item would be told it worked and see nothing
     * change — the worst of the three options. The message names where to go instead.
     */
    if (b.checklist !== undefined) {
      throw new AppError(
        400,
        'checklist_moved',
        'The conversion checklist lives on the task now, not on this record — tick items through ' +
          'PATCH /tasks/:taskId/checklist/:itemId. GET /pllc-conversions returns the taskId.'
      );
    }
    if (b.notes !== undefined) { params.push(b.notes); sets.push(`notes = $${params.length}`); }
    if (sets.length === 0) throw new AppError(400, 'empty_update', 'No fields to update.');
    const res = await app.db.query(`UPDATE pllc_conversions SET ${sets.join(', ')} WHERE id = $1`, params);
    if (res.rowCount === 0) throw new AppError(404, 'not_found', 'PLLC conversion not found.');
    return { status: 'ok' };
  });

  app.post('/jobs/entity-compliance', { preHandler: [app.authenticate, requirePermission('jobs.run')] }, async (request) => {
    const q = z.object({ asOf: z.iso.date().optional() }).parse(request.query);
    return runEntityComplianceJob(app, q.asOf ?? todayChicago());
  });
}
