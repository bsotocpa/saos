// M26 flow 5 (v4.3): the bookkeeping close cycle — Marian's workbench.
//
// Per-client checklist by prep cadence: transactions categorized →
// reconciliations done → statements generated → close marked complete.
//
// ON CLOSE, two things happen, both spec-mandated:
//   1. STATEMENTS AUTO-POST to the client portal. No owner review gate — the
//      session discusses what the client has already seen.
//   2. CALENDAR CROSS-CHECK (CLAUDE.md hard rule): the system looks for an
//      existing upcoming session with that client FIRST. Found → statements
//      attach to it and NO task is created. None → and only then → a
//      scheduling task with the booking link. Never double-book; never assume.

import type { FastifyInstance } from 'fastify';
import type { Client as MinioClient } from 'minio';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { ownerForRole } from '../../staffing.ts';
import { createTask } from '../tasks/service.ts';
import { uploadDocument } from '../documents/service.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { addDays } from '../tax/deadlines.ts';

export type Cadence = 'weekly' | 'monthly' | 'quarterly' | 'semi_annual';

/** The four steps, in order — a later step cannot precede an earlier one. */
export const CLOSE_STEPS = ['categorized', 'reconciled', 'statements_ready'] as const;
export type CloseStep = (typeof CLOSE_STEPS)[number];

const STEP_COLUMN: Record<CloseStep, string> = {
  categorized: 'categorized_at',
  reconciled: 'reconciled_at',
  statements_ready: 'statements_ready_at',
};

export interface CloseCycleRow {
  id: string; contact_id: string; business_id: string | null; engagement_id: string | null;
  cadence: Cadence; period_start: string; period_end: string;
  assigned_staff_id: string | null;
  categorized_at: Date | null; reconciled_at: Date | null;
  statements_ready_at: Date | null; closed_at: Date | null;
  statement_document_id: string | null; attached_session_id: string | null;
}

export async function createCloseCycle(
  app: FastifyInstance,
  input: {
    contactId: string; businessId?: string | null; engagementId?: string | null;
    cadence: Cadence; periodStart: string; periodEnd: string; assignedStaffId?: string | null;
  },
  actor: { id: string; email: string }
): Promise<{ id: string; created: boolean }> {
  const marian = input.assignedStaffId ?? (await ownerForRole(app.db, 'bookkeeper'));
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO close_cycles (contact_id, business_id, engagement_id, cadence, period_start, period_end, assigned_staff_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (contact_id, cadence, period_start) DO NOTHING
     RETURNING id`,
    [
      input.contactId, input.businessId ?? null, input.engagementId ?? null,
      input.cadence, input.periodStart, input.periodEnd, marian,
    ]
  );
  if (!rows[0]) {
    const existing = await app.db.query<{ id: string }>(
      `SELECT id FROM close_cycles WHERE contact_id = $1 AND cadence = $2 AND period_start = $3`,
      [input.contactId, input.cadence, input.periodStart]
    );
    return { id: existing.rows[0]!.id, created: false };
  }
  const id = rows[0].id;
  // Every work item is a task (CLAUDE.md) — the close itself is Marian's work.
  await createTask(app, {
    title: `Close the books: ${input.periodStart} → ${input.periodEnd} (${input.cadence.replace('_', '-')})`,
    description: 'Categorize → reconcile → generate statements → mark closed. Statements post to the client portal automatically on close.',
    assignedStaffId: marian,
    contactId: input.contactId,
    businessId: input.businessId ?? null,
    dueDate: addDays(input.periodEnd, 10),
    source: 'system',
    sourceType: 'close_cycle',
    sourceId: id,
  });
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'close_cycle.created', objectType: 'close_cycle', objectId: id,
    contactId: input.contactId,
    details: { cadence: input.cadence, period_start: input.periodStart, period_end: input.periodEnd },
  });
  return { id, created: true };
}

async function loadCycle(app: FastifyInstance, id: string): Promise<CloseCycleRow> {
  const { rows } = await app.db.query<CloseCycleRow>(
    `SELECT id, contact_id, business_id, engagement_id, cadence,
            period_start::text AS period_start, period_end::text AS period_end,
            assigned_staff_id, categorized_at, reconciled_at, statements_ready_at, closed_at,
            statement_document_id, attached_session_id
     FROM close_cycles WHERE id = $1`,
    [id]
  );
  if (!rows[0]) throw new AppError(404, 'not_found', 'Close cycle not found.');
  return rows[0];
}

/** Tick a checklist step. Steps are ordered — no skipping ahead. */
export async function markCloseStep(
  app: FastifyInstance,
  id: string,
  step: CloseStep,
  actor: { id: string; email: string }
): Promise<void> {
  const cycle = await loadCycle(app, id);
  if (cycle.closed_at) throw new AppError(409, 'already_closed', 'This period is already closed.');
  const order = CLOSE_STEPS.indexOf(step);
  const priors: Array<Date | null> = [cycle.categorized_at, cycle.reconciled_at, cycle.statements_ready_at];
  for (let i = 0; i < order; i++) {
    if (priors[i] === null) {
      throw new AppError(409, 'step_out_of_order', `Complete '${CLOSE_STEPS[i]}' before '${step}'.`);
    }
  }
  await app.db.query(
    `UPDATE close_cycles SET ${STEP_COLUMN[step]} = COALESCE(${STEP_COLUMN[step]}, now()) WHERE id = $1`,
    [id]
  );
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'close_cycle.step_completed', objectType: 'close_cycle', objectId: id,
    contactId: cycle.contact_id, details: { step },
  });
}

/** An upcoming scheduled session for this client, if one exists. */
export async function upcomingSession(
  app: FastifyInstance,
  contactId: string,
  from: string
): Promise<{ id: string; starts_at: Date; is_recurring: boolean } | null> {
  const { rows } = await app.db.query<{ id: string; starts_at: Date; is_recurring: boolean }>(
    `SELECT id, starts_at, is_recurring FROM client_sessions
     WHERE contact_id = $1 AND status = 'scheduled' AND starts_at >= $2::date
     ORDER BY starts_at LIMIT 1`,
    [contactId, from]
  );
  return rows[0] ?? null;
}

/**
 * Complete the close: statements post to the portal, then the CROSS-CHECK
 * decides whether a scheduling task is needed at all.
 */
export async function completeClose(
  app: FastifyInstance,
  minio: MinioClient,
  id: string,
  input: { filename: string; mimeType: string; buffer: Buffer; today: string },
  actor: { id: string; email: string; ip?: string | null }
): Promise<{ documentId: string; attachedSessionId: string | null; schedulingTaskCreated: boolean }> {
  const cycle = await loadCycle(app, id);
  if (cycle.closed_at) throw new AppError(409, 'already_closed', 'This period is already closed.');
  if (!cycle.statements_ready_at) {
    throw new AppError(409, 'checklist_incomplete', 'Complete the checklist (categorized → reconciled → statements) before closing.');
  }

  // 1. Statements AUTO-POST to the portal — no review gate.
  const doc = await uploadDocument(
    app, minio,
    { type: 'staff', id: actor.id, label: actor.email, ip: actor.ip ?? null },
    {
      contactId: cycle.contact_id,
      category: 'financial_statements',
      filename: input.filename,
      mimeType: input.mimeType,
      buffer: input.buffer,
      ...(cycle.business_id ? { businessId: cycle.business_id } : {}),
    }
  );

  // 2. THE CROSS-CHECK, before any scheduling task is considered.
  const session = await upcomingSession(app, cycle.contact_id, input.today);
  let schedulingTaskCreated = false;
  if (!session) {
    // No session on the calendar — THIS is when a task is warranted.
    const marian = cycle.assigned_staff_id ?? (await ownerForRole(app.db, 'bookkeeper'));
    await createTask(app, {
      title: `Schedule a books review with this client (${cycle.period_start} → ${cycle.period_end})`,
      description:
        'No upcoming session was on the calendar when the books closed — first review or one-time/cleanup client. ' +
        'Send the booking link; statements are already in their portal.',
      assignedStaffId: marian,
      contactId: cycle.contact_id,
      priority: 1,
      source: 'automation',
      sourceType: 'close_session_scheduling',
      sourceId: id,
    });
    schedulingTaskCreated = true;
  }

  await app.db.query(
    `UPDATE close_cycles
     SET closed_at = now(), statement_document_id = $2, attached_session_id = $3
     WHERE id = $1`,
    [id, doc.id, session?.id ?? null]
  );
  // The close work item is done.
  const { closeTasksForSource } = await import('../tasks/service.ts');
  await closeTasksForSource(app, 'close_cycle', id, 'books closed');

  // Client notice (the statements are already visible in the portal).
  const contact = await app.db.query<{ first_name: string; email: string | null; language: 'en' | 'es' }>(
    `SELECT first_name, email, language FROM contacts WHERE id = $1`,
    [cycle.contact_id]
  );
  const c = contact.rows[0];
  if (c?.email) {
    await sendTemplatedEmail(app, {
      to: c.email,
      templateKey: 'statements_posted',
      language: c.language,
      contactId: cycle.contact_id,
      vars: {
        first_name: c.first_name,
        period: `${cycle.period_start} – ${cycle.period_end}`,
        portal_link: app.config.PORTAL_BASE_URL,
      },
    }).catch((err) => app.log.warn({ err }, 'statement notice failed'));
  }

  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'close_cycle.closed', objectType: 'close_cycle', objectId: id,
    contactId: cycle.contact_id, ip: actor.ip ?? null,
    details: {
      statement_document_id: doc.id,
      attached_session_id: session?.id ?? null,
      session_was_recurring: session?.is_recurring ?? null,
      scheduling_task_created: schedulingTaskCreated,
    },
  });
  return { documentId: doc.id, attachedSessionId: session?.id ?? null, schedulingTaskCreated };
}

/** Marian's workbench: every open cycle with its checklist state. */
export async function closeWorkbench(app: FastifyInstance, staffId?: string) {
  const params: unknown[] = [];
  let clause = 'cc.closed_at IS NULL';
  if (staffId) { params.push(staffId); clause += ` AND cc.assigned_staff_id = $${params.length}`; }
  const { rows } = await app.db.query(
    `SELECT cc.id, cc.cadence, cc.period_start::text AS period_start, cc.period_end::text AS period_end,
            cc.categorized_at, cc.reconciled_at, cc.statements_ready_at,
            c.first_name || ' ' || c.last_name AS client_name, c.id AS contact_id,
            b.name AS business_name, st.full_name AS assignee,
            (SELECT min(s.starts_at) FROM client_sessions s
             WHERE s.contact_id = cc.contact_id AND s.status = 'scheduled' AND s.starts_at >= now()) AS next_session_at
     FROM close_cycles cc
     JOIN contacts c ON c.id = cc.contact_id
     LEFT JOIN businesses b ON b.id = cc.business_id
     LEFT JOIN staff st ON st.id = cc.assigned_staff_id
     WHERE ${clause}
     ORDER BY cc.period_end, c.last_name`,
    params
  );
  return rows;
}
