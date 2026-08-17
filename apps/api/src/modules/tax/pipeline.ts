// Tax pipeline state machine (MP Tax Operations → Pipeline).
//
// GATES ENFORCED IN CODE (MP automations 7–8 — never convention):
//   1. Engagement letter signed  → required to advance PAST 'scheduled'
//   2. Estimated fee locked      → required to enter 'in_preparation'
//   3. Form 8879 signed          → required to enter 'filed'
// on_hold / withdrawn are always reachable; resuming from on_hold re-applies
// every gate. The parallel "Extended" state lives on extension_filed (M8),
// not in this stage enum.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { firstActiveByRole, notifyOnce } from '../../staffing.ts';
import { closeTasksForSource, createTask } from '../tasks/service.ts';
import { addDays, daysBetween, todayChicago } from './deadlines.ts';
import { invoiceForFiledEngagement } from '../billing/service.ts';

export const TAX_STAGES = [
  'intake_started', 'scheduled', 'documents_requested', 'pending_client_response',
  'in_preparation', 'internal_review', 'client_review', 'ready_to_file',
  'filed', 'rejected', 'completed', 'on_hold', 'withdrawn',
] as const;
export type TaxStage = (typeof TAX_STAGES)[number];

const ORDER: Partial<Record<TaxStage, number>> = {
  intake_started: 0, scheduled: 1, documents_requested: 2, pending_client_response: 3,
  in_preparation: 4, internal_review: 5, client_review: 6, ready_to_file: 7,
  filed: 8, rejected: 8, completed: 9,
};

const RESUMABLE: TaxStage[] = [
  'scheduled', 'documents_requested', 'pending_client_response', 'in_preparation',
  'internal_review', 'client_review', 'ready_to_file',
];

/** Forward/backward moves allowed from each stage (before gates). */
const TRANSITIONS: Record<TaxStage, TaxStage[]> = {
  intake_started: ['scheduled'],
  scheduled: ['documents_requested'],
  documents_requested: ['pending_client_response', 'in_preparation'],
  pending_client_response: ['documents_requested', 'in_preparation'],
  in_preparation: ['documents_requested', 'pending_client_response', 'internal_review'],
  internal_review: ['in_preparation', 'client_review'],
  client_review: ['in_preparation', 'ready_to_file'],
  ready_to_file: ['client_review', 'filed'],
  // v4.3 flow 1: Filed is NOT terminal — acceptance completes it, a reject
  // re-queues it. From rejected the fix path is re-file (ready_to_file) or
  // back into preparation for a substantive fix.
  filed: ['completed', 'rejected'],
  rejected: ['ready_to_file', 'in_preparation'],
  completed: [],
  on_hold: RESUMABLE,
  withdrawn: [],
};

/** Stages where the ball is in the client's court (delay attribution). */
const CLIENT_COURT: TaxStage[] = ['pending_client_response', 'client_review'];

interface GateRow {
  id: string;
  stage: TaxStage;
  engagement_letter_signed_at: Date | null;
  f8879_signed_at: Date | null;
  estimate_locked_at: Date | null;
  filed_date: string | null;
  contact_id: string;
}

export async function transitionStage(
  app: FastifyInstance,
  actor: { staffId: string | null; label: string },
  taxEngagementId: string,
  toStage: TaxStage,
  opts: { note?: string | undefined; ip?: string | null; userAgent?: string | null } = {}
): Promise<{ from: TaxStage; to: TaxStage }> {
  const { rows } = await app.db.query<GateRow>(
    `SELECT te.id, te.stage, te.engagement_letter_signed_at, te.f8879_signed_at,
            te.estimate_locked_at, te.filed_date, e.contact_id
     FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id
     WHERE te.id = $1`,
    [taxEngagementId]
  );
  const row = rows[0];
  if (!row) throw new AppError(404, 'not_found', 'Tax engagement not found.');
  const from = row.stage;

  const allowed =
    toStage === 'on_hold' || toStage === 'withdrawn'
      ? from !== 'completed' && from !== 'withdrawn' && from !== toStage
      : TRANSITIONS[from]?.includes(toStage) ?? false;
  if (!allowed) {
    throw new AppError(409, 'invalid_transition', `Cannot move from '${from}' to '${toStage}'.`);
  }

  // Gate 1 — engagement letter blocks everything past 'scheduled'.
  const targetOrder = ORDER[toStage];
  if (targetOrder !== undefined && targetOrder > ORDER.scheduled! && !row.engagement_letter_signed_at) {
    throw new AppError(
      409,
      'engagement_letter_required',
      'Blocked: the engagement letter is not signed. Work cannot advance past Scheduled until it is (MP compliance gate).'
    );
  }
  // Gate 2 — estimate locked unlocks preparation (automation 8).
  if (toStage === 'in_preparation' && !row.estimate_locked_at) {
    throw new AppError(
      409,
      'estimate_lock_required',
      'Blocked: the estimated fee range is not locked. Lock the estimate to unlock preparation (automation 8).'
    );
  }
  // Gate 3 — no return files without a signed 8879.
  if (toStage === 'filed' && !row.f8879_signed_at) {
    throw new AppError(
      409,
      'f8879_required',
      'Blocked: Form 8879 e-file authorization is not signed. No return is filed without it (MP compliance gate).'
    );
  }

  await app.db.query(
    `UPDATE tax_engagements
     SET stage = $2::tax_stage,
         filed_date = CASE WHEN $2 = 'filed' THEN COALESCE(filed_date, CURRENT_DATE) ELSE filed_date END
     WHERE id = $1`,
    [taxEngagementId, toStage]
  );
  await app.db.query(
    `INSERT INTO engagement_stage_history (tax_engagement_id, stage, changed_by_staff_id, waiting_on, note)
     VALUES ($1, $2::tax_stage, $3, $4::waiting_on, $5)`,
    [
      taxEngagementId,
      toStage,
      actor.staffId,
      CLIENT_COURT.includes(toStage) ? 'client' : 'staff',
      opts.note ?? null,
    ]
  );
  await writeAudit(app.db, {
    actorType: actor.staffId ? 'staff' : 'system',
    actorId: actor.staffId,
    actorLabel: actor.label,
    action: 'tax_engagement.stage_changed',
    objectType: 'tax_engagement',
    objectId: taxEngagementId,
    contactId: row.contact_id,
    ip: opts.ip,
    userAgent: opts.userAgent,
    details: { from, to: toStage },
  });

  // Automation 12: Filed → invoice generated (or an exception to Rene when
  // the final fee is missing — never a silent skip). Re-files after a reject
  // don't re-invoice (COALESCE(filed_date) keeps the original date; the
  // invoice hook is idempotent per engagement via its own dedupe).
  if (toStage === 'filed') {
    await invoiceForFiledEngagement(app, actor, taxEngagementId);
    // Re-queue resolved: reaching 'filed' with a perfection clock running
    // means the reject was fixed (path is rejected → ready_to_file → filed,
    // so check the clock, not the immediate `from`). Task closes with it.
    const cleared = await app.db.query(
      `UPDATE tax_engagements SET perfection_deadline = NULL WHERE id = $1 AND perfection_deadline IS NOT NULL`,
      [taxEngagementId]
    );
    if ((cleared.rowCount ?? 0) > 0) {
      await closeTasksForSource(app, 'efile_reject', taxEngagementId, 're-filed within the perfection window');
    }
  }

  return { from, to: toStage };
}

// ── v4.3 flow 1: e-file acceptance / rejection ──────────────────────────────

/** Individual returns get 5 perfection days; business returns get 10. */
export function perfectionDays(returnType: string): number {
  return returnType === '1040' || returnType === '1040_expat' ? 5 : 10;
}

export async function recordEfileResult(
  app: FastifyInstance,
  actor: { staffId: string | null; label: string },
  taxEngagementId: string,
  input: { result: 'accepted' | 'rejected'; rejectCode?: string | undefined; rejectReason?: string | undefined; today?: string | undefined }
): Promise<{ stage: TaxStage; perfectionDeadline: string | null }> {
  const { rows } = await app.db.query<{
    id: string; stage: TaxStage; return_type: string; tax_year: number;
    preparer_id: string | null; contact_id: string; first_name: string; last_name: string;
  }>(
    `SELECT te.id, te.stage, te.return_type, te.tax_year, te.preparer_id,
            c.id AS contact_id, c.first_name, c.last_name
     FROM tax_engagements te
     JOIN engagements e ON e.id = te.engagement_id
     JOIN contacts c ON c.id = e.contact_id
     WHERE te.id = $1`,
    [taxEngagementId]
  );
  const te = rows[0];
  if (!te) throw new AppError(404, 'not_found', 'Tax engagement not found.');
  if (te.stage !== 'filed') {
    throw new AppError(409, 'not_filed', `E-file results apply to filed returns — this one is '${te.stage}'.`);
  }

  if (input.result === 'accepted') {
    await app.db.query(`UPDATE tax_engagements SET efile_accepted_at = now() WHERE id = $1`, [taxEngagementId]);
    await transitionStage(app, actor, taxEngagementId, 'completed', { note: 'e-file ACCEPTED' });

    /*
     * #44 §4 — the return is finished, so the engagement holding it might be too.
     *
     * `completed` was terminal here from the start and nothing above this line propagated
     * it: the return ended, the engagement stayed active forever, and the client kept
     * reading as active because an "open" engagement existed. That is the same untruth as
     * #42's "lead", one level down, and it was waiting for the first IRS acceptance.
     *
     * Only closes when EVERY return on the engagement is terminal. In today's schema that
     * is always exactly one — `tax_engagements.engagement_id` is UNIQUE, so two tax years
     * are two engagements — and the check is a formality. It stays because reporting an
     * engagement finished with a return still open is the one failure mode worse than
     * never closing at all, and it costs a subquery to be right if that constraint moves.
     */
    const { closeEngagementIfAllReturnsDone } = await import('../engagements/close.ts');
    await closeEngagementIfAllReturnsDone(app, taxEngagementId, {
      type: 'staff', id: actor.staffId, label: actor.label,
    });
    return { stage: 'completed', perfectionDeadline: null };
  }

  const today = input.today ?? todayChicago();
  const deadline = addDays(today, perfectionDays(te.return_type));
  await app.db.query(
    `UPDATE tax_engagements
     SET rejected_at = now(), reject_code = $2, reject_reason = $3, perfection_deadline = $4
     WHERE id = $1`,
    [taxEngagementId, input.rejectCode ?? null, input.rejectReason ?? null, deadline]
  );
  await transitionStage(app, actor, taxEngagementId, 'rejected', {
    note: `e-file REJECTED${input.rejectCode ? ` (${input.rejectCode})` : ''}`,
  });

  // Owned work item — never a dead end. Urgent, clocked to the perfection window.
  const owner = te.preparer_id ?? (await firstActiveByRole(app.db, 'tax_preparer'));
  await createTask(app, {
    title: `E-file REJECTED: ${te.first_name} ${te.last_name} ${te.tax_year} ${te.return_type.toUpperCase()} — fix & re-file by ${deadline}`,
    description:
      `Reject code: ${input.rejectCode ?? 'n/a'}. ${input.rejectReason ?? ''}\n` +
      `Perfection window: re-file by ${deadline} (${perfectionDays(te.return_type)} days) to keep the original filing date.`,
    assignedStaffId: owner,
    contactId: te.contact_id,
    dueDate: deadline,
    priority: 2,
    source: 'automation',
    sourceType: 'efile_reject',
    sourceId: taxEngagementId,
  });
  if (owner) {
    await notifyOnce(app.db, {
      staffId: owner,
      type: 'efile_rejected',
      severity: 'critical',
      title: `E-file rejected — ${te.first_name} ${te.last_name} ${te.tax_year} ${te.return_type.toUpperCase()}, perfection ends ${deadline}`,
      contactId: te.contact_id,
      relatedObjectType: 'efile_reject',
      relatedObjectId: taxEngagementId,
    });
  }
  return { stage: 'rejected', perfectionDeadline: deadline };
}

/**
 * Daily perfection-clock sweep: T-2 warning to the owner, past-deadline
 * critical to Brian (the original filing date is now at risk). notifyOnce
 * keys keep each alert to exactly one firing per engagement.
 */
export async function runPerfectionClockJob(
  app: FastifyInstance,
  today: string
): Promise<{ skipped: boolean; warnings: number; overdue: number }> {
  const ACTION = 'job.perfection_clock';
  const already = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = $1 AND details->>'run_date' = $2 LIMIT 1`,
    [ACTION, today]
  );
  if (already.rows.length > 0) return { skipped: true, warnings: 0, overdue: 0 };

  const { rows } = await app.db.query<{
    id: string; perfection_deadline: string; preparer_id: string | null;
    contact_id: string; first_name: string; last_name: string; tax_year: number; return_type: string;
  }>(
    `SELECT te.id, te.perfection_deadline::text AS perfection_deadline, te.preparer_id,
            c.id AS contact_id, c.first_name, c.last_name, te.tax_year, te.return_type
     FROM tax_engagements te
     JOIN engagements e ON e.id = te.engagement_id
     JOIN contacts c ON c.id = e.contact_id
     WHERE te.stage = 'rejected' AND te.perfection_deadline IS NOT NULL`
  );

  let warnings = 0;
  let overdue = 0;
  const brian = await firstActiveByRole(app.db, 'ceo');
  for (const te of rows) {
    const label = `${te.first_name} ${te.last_name} ${te.tax_year} ${te.return_type.toUpperCase()}`;
    if (te.perfection_deadline < today) {
      if (brian) {
        const fired = await notifyOnce(app.db, {
          staffId: brian,
          type: 'perfection_overdue',
          severity: 'critical',
          title: `PERFECTION WINDOW MISSED: ${label} (was ${te.perfection_deadline}) — original filing date at risk`,
          contactId: te.contact_id,
          relatedObjectType: 'perfection_overdue',
          relatedObjectId: te.id,
        });
        if (fired) overdue++;
      }
    } else if (daysBetween(today, te.perfection_deadline) <= 2 && te.preparer_id) {
      const fired = await notifyOnce(app.db, {
        staffId: te.preparer_id,
        type: 'perfection_closing',
        severity: 'warning',
        title: `Perfection window closes ${te.perfection_deadline}: ${label} — re-file now`,
        contactId: te.contact_id,
        relatedObjectType: 'perfection_closing',
        relatedObjectId: te.id,
      });
      if (fired) warnings++;
    }
  }

  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'daily-jobs',
    action: ACTION,
    details: { run_date: today, warnings, overdue },
  });
  return { skipped: false, warnings, overdue };
}

/**
 * Automation 4 (pipeline half): a document request flips the engagement to
 * pending_client_response and stamps docs_requested_at. The request/reminder
 * machinery itself lands in M10 — this is the stage side-effect.
 */
export async function markDocumentsRequested(
  app: FastifyInstance,
  actor: { staffId: string | null; label: string },
  taxEngagementId: string
): Promise<void> {
  await app.db.query(
    `UPDATE tax_engagements SET docs_requested_at = COALESCE(docs_requested_at, now()) WHERE id = $1`,
    [taxEngagementId]
  );
  const { rows } = await app.db.query<{ stage: TaxStage }>(
    `SELECT stage FROM tax_engagements WHERE id = $1`,
    [taxEngagementId]
  );
  const stage = rows[0]?.stage;
  if (stage === 'documents_requested' || stage === 'in_preparation') {
    await transitionStage(app, actor, taxEngagementId, 'pending_client_response', {
      note: 'auto: document request sent',
    });
  } else if (stage === 'scheduled') {
    // scheduled → documents_requested → pending_client_response (gates apply).
    await transitionStage(app, actor, taxEngagementId, 'documents_requested', { note: 'auto: document request sent' });
    await transitionStage(app, actor, taxEngagementId, 'pending_client_response', {
      note: 'auto: document request sent',
    });
  }
}
