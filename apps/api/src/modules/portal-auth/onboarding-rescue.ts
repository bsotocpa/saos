// M26 flow 7 (v4.3): stalled-onboarding rescue.
//
// Staff-visible pipeline: Deposit paid → Questionnaire → Docs → Complete.
// Each incomplete stage becomes a CLIENT-VISIBLE task, which is what arms the
// existing D3/D7/D14/D30 ladder (createTask stamps waiting_since for
// client-visible items) — one ladder, not a second copy of it.
//
// DEPOSITS ARE NEVER AUTO-REFUNDED. At Day 60 a stalled onboarding surfaces to
// Brian as a decision with the deposit held as a credit; the system takes no
// money action on its own.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { firstActiveByRole, ownerForRole } from '../../staffing.ts';
import { createTask } from '../tasks/service.ts';
import { daysBetween } from '../tax/deadlines.ts';

export type OnboardingStage = 'deposit' | 'questionnaire' | 'docs' | 'complete';

const STALL_DAYS = 60;

interface OnboardingRow {
  contact_id: string; first_name: string; last_name: string;
  variant: string; created_at: Date;
  deposit_paid_at: Date | null; deposit_amount_cents: number | null;
  step_confirm_info_at: Date | null; step_sign_docs_at: Date | null;
  step_upload_documents_at: Date | null; completed_at: Date | null;
  stalled_flagged_at: Date | null;
}

/** Where this onboarding actually stands (staff-visible pipeline stage). */
export function stageOf(row: OnboardingRow): OnboardingStage {
  if (row.completed_at) return 'complete';
  if (row.step_upload_documents_at) return 'docs';
  if (row.step_confirm_info_at || row.step_sign_docs_at) return 'questionnaire';
  return 'deposit';
}

/** The client-visible to-do for the stage they're stuck on. */
function stageTodo(stage: OnboardingStage): { title: string; description: string } | null {
  switch (stage) {
    case 'deposit':
      return {
        title: 'Finish setting up your account',
        description: 'Your portal is ready — confirm your details to get started. It takes about two minutes.',
      };
    case 'questionnaire':
      return {
        title: 'Confirm your information and sign your documents',
        description: 'Two short steps in your portal and we can start work.',
      };
    case 'docs':
      return {
        title: 'Upload your documents',
        description: 'Your portal lists exactly what we need — photos of paper documents work fine.',
      };
    case 'complete':
      return null;
  }
}

/**
 * Daily, date-guarded. For every incomplete onboarding: keep ONE client-visible
 * to-do alive for the current stage (the ladder chases it), and at Day 60 hand
 * Brian a decision — deposit held as credit, never auto-refunded.
 */
export async function runOnboardingRescueJob(
  app: FastifyInstance,
  today: string
): Promise<{ skipped: boolean; nudged: number; stalled: number; byStage: Record<string, number> }> {
  const ACTION = 'job.onboarding_rescue';
  const already = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = $1 AND details->>'run_date' = $2 LIMIT 1`,
    [ACTION, today]
  );
  if (already.rows.length > 0) return { skipped: true, nudged: 0, stalled: 0, byStage: {} };

  const { rows } = await app.db.query<OnboardingRow>(
    `SELECT o.contact_id, c.first_name, c.last_name, o.variant, o.created_at,
            o.deposit_paid_at, o.deposit_amount_cents,
            o.step_confirm_info_at, o.step_sign_docs_at, o.step_upload_documents_at,
            o.completed_at, o.stalled_flagged_at
     FROM portal_onboarding o
     JOIN contacts c ON c.id = o.contact_id
     WHERE o.completed_at IS NULL AND NOT c.is_archived`
  );

  const brian = await firstActiveByRole(app.db, 'ceo');
  const rene = await ownerForRole(app.db, 'comms_billing');
  const byStage: Record<string, number> = {};
  let nudged = 0;
  let stalled = 0;

  for (const row of rows) {
    const stage = stageOf(row);
    byStage[stage] = (byStage[stage] ?? 0) + 1;
    const todo = stageTodo(stage);
    if (todo) {
      // Client-visible → waiting_since is stamped → the ladder owns the chase.
      // Deduped on (source_type, source_id), so one live to-do per stage.
      const created = await createTask(app, {
        title: todo.title,
        description: todo.description,
        contactId: row.contact_id,
        clientVisible: true,
        assignedStaffId: rene,
        source: 'automation',
        sourceType: `onboarding_${stage}`,
        sourceId: row.contact_id,
      });
      if (created.created) nudged++;
    }

    // Day 60: Brian decides. The deposit is a held credit, full stop.
    const ageDays = daysBetween(row.created_at.toISOString().slice(0, 10), today);
    if (ageDays >= STALL_DAYS && !row.stalled_flagged_at && brian) {
      const deposit = row.deposit_amount_cents ?? 0;
      await createTask(app, {
        title: `STALLED onboarding (${ageDays}d): ${row.first_name} ${row.last_name} — decide the path`,
        description:
          `Stuck at the ${stage} stage for ${ageDays} days.` +
          (deposit > 0
            ? `\n\nDeposit of $${(deposit / 100).toFixed(2)} is HELD AS CREDIT on their account — the system never ` +
              'auto-refunds. Options: keep chasing, apply the credit to a smaller scope, pause formally, or refund ' +
              'deliberately.'
            : '\n\nNo deposit was collected. Options: keep chasing, pause formally, or close the lead.'),
        assignedStaffId: brian,
        contactId: row.contact_id,
        priority: 2,
        source: 'automation',
        sourceType: 'onboarding_stalled',
        sourceId: row.contact_id,
      });
      await app.db.query(
        `UPDATE portal_onboarding SET stalled_flagged_at = now() WHERE contact_id = $1`,
        [row.contact_id]
      );
      await writeAudit(app.db, {
        actorType: 'system', actorLabel: 'onboarding-rescue',
        action: 'onboarding.stalled_flagged', objectType: 'contact', objectId: row.contact_id,
        contactId: row.contact_id,
        details: { stage, age_days: ageDays, deposit_cents: deposit, deposit_action: 'held_as_credit' },
      });
      stalled++;
    }
  }

  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'daily-jobs',
    action: ACTION,
    details: { run_date: today, nudged, stalled, by_stage: byStage },
  });
  return { skipped: false, nudged, stalled, byStage };
}

/** Staff-visible onboarding pipeline board. */
export async function onboardingPipeline(app: FastifyInstance) {
  const { rows } = await app.db.query<OnboardingRow & { email: string | null }>(
    `SELECT o.contact_id, c.first_name, c.last_name, c.email, o.variant, o.created_at,
            o.deposit_paid_at, o.deposit_amount_cents,
            o.step_confirm_info_at, o.step_sign_docs_at, o.step_upload_documents_at,
            o.completed_at, o.stalled_flagged_at
     FROM portal_onboarding o
     JOIN contacts c ON c.id = o.contact_id
     WHERE o.completed_at IS NULL AND NOT c.is_archived
     ORDER BY o.created_at`
  );
  return rows.map((r) => ({
    contactId: r.contact_id,
    client: `${r.first_name} ${r.last_name}`,
    email: r.email,
    variant: r.variant,
    stage: stageOf(r),
    startedAt: r.created_at,
    depositCents: r.deposit_amount_cents,
    depositPaidAt: r.deposit_paid_at,
    stalledFlaggedAt: r.stalled_flagged_at,
  }));
}
