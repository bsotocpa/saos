// M26 flow 3: the auto-extension batch (v4.3 DECIDED).
//
// At the season cutoffs, engagements still missing documents are swept into a
// batch per lane, the client is notified that a protective extension is
// coming ("this is normal and protects you"), and BRIAN APPROVES THE BATCH
// before any preparer files. Filing without approval is refused in code, not
// convention. Approved-and-filed engagements re-enter the normal flow with
// their DERIVED extended deadline (markExtensionFiled → THE_TABLE).
//
// Lane derivation comes from the authoritative table, never a hardcoded date
// pair: a return whose ORIGINAL deadline falls in March sweeps at the March
// cutoff (Mar 25 — 1065/1120-S), April filers at the April cutoff (Apr 1 —
// 1040/1120/1041). Later filers (990 in May, fiscal-year filers) are out of
// scope for the season batch; their own deadlines are months away.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { isAutomationEnabled } from '../../automations.ts';
import { firstActiveByRole } from '../../staffing.ts';
import { createTask } from '../tasks/service.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { AUTOMATIC_EXTENSION_TYPES, originalDeadline, type DeadlineReturnType } from './deadlines.ts';
import { markExtensionFiled } from './extension.ts';

export type BatchLane = 'business' | 'individual';

/** Stages where documents are still outstanding (pre-preparation work). */
const PRE_INTERNAL_REVIEW = [
  'intake_started', 'scheduled', 'documents_requested', 'pending_client_response', 'in_preparation', 'on_hold',
];

/**
 * Which cutoff sweeps this return type — derived from its original deadline
 * month. Returns null when the type is out of season scope (May+ deadlines,
 * automatic-extension types like FBAR, or no standalone deadline).
 */
export function laneFor(returnType: DeadlineReturnType, taxYear: number): BatchLane | null {
  if (AUTOMATIC_EXTENSION_TYPES.includes(returnType)) return null; // extension needs no filing
  const original = originalDeadline(returnType, taxYear, 12);
  if (!original) return null;
  const month = original.slice(5, 7);
  if (month === '03') return 'business';
  if (month === '04') return 'individual';
  return null;
}

async function cutoffSetting(app: FastifyInstance): Promise<Record<BatchLane, string>> {
  const { rows } = await app.db.query<{ value: Record<BatchLane, string> }>(
    `SELECT value FROM app_settings WHERE key = 'extension.auto_batch_cutoffs'`
  );
  return rows[0]?.value ?? { business: '03-25', individual: '04-01' };
}

/**
 * Daily, date-guarded. On a cutoff date, sweep that lane's still-incomplete
 * engagements into the season batch (idempotent per engagement), notify the
 * clients (kill-switch gated), and open Brian's review task.
 */
export async function runAutoExtensionBatchJob(
  app: FastifyInstance,
  today: string
): Promise<{ skipped: boolean; lane?: BatchLane; added?: number; notified?: number; suppressed?: number }> {
  const ACTION = 'job.auto_extension_batch';
  const already = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = $1 AND details->>'run_date' = $2 LIMIT 1`,
    [ACTION, today]
  );
  if (already.rows.length > 0) return { skipped: true };

  const cutoffs = await cutoffSetting(app);
  const monthDay = today.slice(5);
  const lane = (Object.keys(cutoffs) as BatchLane[]).find((l) => cutoffs[l] === monthDay);
  if (!lane) return { skipped: true };

  // Season = the tax year whose deadlines fall in THIS calendar year.
  const taxYear = Number(today.slice(0, 4)) - 1;

  const { rows } = await app.db.query<{
    id: string; return_type: DeadlineReturnType; contact_id: string;
    first_name: string; email: string | null; language: 'en' | 'es'; preparer_id: string | null;
  }>(
    `SELECT te.id, te.return_type, c.id AS contact_id, c.first_name, c.email, c.language, te.preparer_id
     FROM tax_engagements te
     JOIN engagements e ON e.id = te.engagement_id
     JOIN contacts c ON c.id = e.contact_id
     WHERE te.tax_year = $1
       AND te.docs_received_at IS NULL
       AND NOT te.extension_filed
       AND te.stage = ANY($2::tax_stage[])`,
    [taxYear, PRE_INTERNAL_REVIEW]
  );
  const inLane = rows.filter((r) => laneFor(r.return_type, taxYear) === lane);

  let added = 0;
  let notified = 0;
  let suppressed = 0;
  if (inLane.length > 0) {
    const batch = await app.db.query<{ id: string }>(
      `INSERT INTO extension_batches (tax_year, lane, cutoff_date)
       VALUES ($1, $2, $3)
       ON CONFLICT (tax_year, lane) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [taxYear, lane, today]
    );
    const batchId = batch.rows[0]!.id;
    const noticesArmed = await isAutomationEnabled(app, 'extension_notices');

    for (const te of inLane) {
      const ins = await app.db.query(
        `INSERT INTO extension_batch_items (batch_id, tax_engagement_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [batchId, te.id]
      );
      if ((ins.rowCount ?? 0) === 0) continue; // already swept
      added++;

      // Client notice: reassuring, not alarming (v4.3 copy intent).
      if (!te.email) continue;
      if (!noticesArmed) { suppressed++; continue; }
      await sendTemplatedEmail(app, {
        to: te.email,
        templateKey: 'protective_extension_notice',
        language: te.language,
        contactId: te.contact_id,
        vars: { first_name: te.first_name, tax_year: String(taxYear), portal_link: app.config.PORTAL_BASE_URL },
      });
      await app.db.query(
        `UPDATE extension_batch_items SET client_notified_at = now() WHERE batch_id = $1 AND tax_engagement_id = $2`,
        [batchId, te.id]
      );
      notified++;
    }

    // Brian's review gate is a WORK ITEM (owner rollup), one per batch.
    const brian = await firstActiveByRole(app.db, 'ceo');
    if (brian && added > 0) {
      await createTask(app, {
        title: `Review the ${taxYear} ${lane} extension batch (${added} returns) — approve before preparers file`,
        description:
          'Protective extensions swept at the season cutoff. Pull anything that should not be extended, then approve. ' +
          'Preparers cannot file batch items until the batch is approved.',
        assignedStaffId: brian,
        priority: 2,
        source: 'automation',
        sourceType: 'extension_batch_review',
        sourceId: batchId,
      });
    }
  }

  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'daily-jobs',
    action: ACTION,
    details: { run_date: today, lane, tax_year: taxYear, added, notified, suppressed },
  });
  return { skipped: false, lane, added, notified, suppressed };
}

export async function approveBatch(
  app: FastifyInstance,
  batchId: string,
  actor: { id: string; email: string }
): Promise<{ items: number }> {
  const batch = await app.db.query<{ status: string; tax_year: number; lane: string }>(
    `SELECT status, tax_year, lane FROM extension_batches WHERE id = $1`,
    [batchId]
  );
  if (!batch.rows[0]) throw new AppError(404, 'not_found', 'Batch not found.');
  if (batch.rows[0].status !== 'draft') {
    throw new AppError(409, 'already_approved', `Batch is already ${batch.rows[0].status}.`);
  }
  await app.db.query(
    `UPDATE extension_batches SET status = 'approved', approved_by_staff_id = $2, approved_at = now() WHERE id = $1`,
    [batchId, actor.id]
  );
  const count = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM extension_batch_items WHERE batch_id = $1 AND removed_at IS NULL`,
    [batchId]
  );
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'extension_batch.approved', objectType: 'extension_batch', objectId: batchId,
    details: { tax_year: batch.rows[0].tax_year, lane: batch.rows[0].lane, items: count.rows[0]!.n },
  });
  return { items: count.rows[0]!.n };
}

/** Brian pulls an engagement out during review (approved batches too). */
export async function removeBatchItem(
  app: FastifyInstance,
  batchId: string,
  taxEngagementId: string,
  actor: { id: string; email: string }
): Promise<void> {
  const res = await app.db.query(
    `UPDATE extension_batch_items SET removed_at = now()
     WHERE batch_id = $1 AND tax_engagement_id = $2 AND filed_at IS NULL AND removed_at IS NULL`,
    [batchId, taxEngagementId]
  );
  if (res.rowCount === 0) throw new AppError(404, 'not_found', 'Batch item not found (or already filed).');
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.email,
    action: 'extension_batch.item_removed', objectType: 'extension_batch', objectId: batchId,
    details: { tax_engagement_id: taxEngagementId },
  });
}

/**
 * Preparer files a batch item in ATX and records it here. THE GATE: refused
 * until Brian has approved the batch (v4.3 "Brian reviews the batch list
 * before preparers file").
 */
export async function fileBatchItem(
  app: FastifyInstance,
  batchId: string,
  taxEngagementId: string,
  actor: { id: string; email: string },
  today: string
): Promise<{ extendedDeadline: string | null; batchComplete: boolean }> {
  const batch = await app.db.query<{ status: string }>(
    `SELECT status FROM extension_batches WHERE id = $1`,
    [batchId]
  );
  if (!batch.rows[0]) throw new AppError(404, 'not_found', 'Batch not found.');
  if (batch.rows[0].status === 'draft') {
    throw new AppError(
      409, 'batch_not_approved',
      'Blocked: this extension batch has not been approved yet. Brian reviews the batch before preparers file (v4.3 flow 3).'
    );
  }
  const item = await app.db.query(
    `SELECT 1 FROM extension_batch_items
     WHERE batch_id = $1 AND tax_engagement_id = $2 AND removed_at IS NULL AND filed_at IS NULL`,
    [batchId, taxEngagementId]
  );
  if (item.rows.length === 0) throw new AppError(404, 'not_found', 'Batch item not found (removed or already filed).');

  const result = await markExtensionFiled(app, { staffId: actor.id, label: actor.email }, taxEngagementId, today);
  await app.db.query(
    `UPDATE extension_batch_items SET filed_at = now() WHERE batch_id = $1 AND tax_engagement_id = $2`,
    [batchId, taxEngagementId]
  );

  // Batch closes itself when every remaining item is filed.
  const remaining = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM extension_batch_items
     WHERE batch_id = $1 AND removed_at IS NULL AND filed_at IS NULL`,
    [batchId]
  );
  const batchComplete = remaining.rows[0]!.n === 0;
  if (batchComplete) {
    await app.db.query(`UPDATE extension_batches SET status = 'filed' WHERE id = $1`, [batchId]);
  }
  return { extendedDeadline: result.extendedDeadline, batchComplete };
}

export async function batchWithItems(app: FastifyInstance, batchId: string) {
  const batch = await app.db.query(
    `SELECT b.id, b.tax_year, b.lane, b.cutoff_date::text AS cutoff_date, b.status, b.approved_at,
            st.full_name AS approved_by
     FROM extension_batches b LEFT JOIN staff st ON st.id = b.approved_by_staff_id
     WHERE b.id = $1`,
    [batchId]
  );
  if (!batch.rows[0]) throw new AppError(404, 'not_found', 'Batch not found.');
  const items = await app.db.query(
    `SELECT i.tax_engagement_id, i.client_notified_at, i.filed_at, i.removed_at,
            te.tax_year, te.return_type, te.stage, te.original_deadline::text AS original_deadline,
            te.extended_deadline::text AS extended_deadline,
            c.first_name, c.last_name, st.full_name AS preparer
     FROM extension_batch_items i
     JOIN tax_engagements te ON te.id = i.tax_engagement_id
     JOIN engagements e ON e.id = te.engagement_id
     JOIN contacts c ON c.id = e.contact_id
     LEFT JOIN staff st ON st.id = te.preparer_id
     WHERE i.batch_id = $1
     ORDER BY c.last_name, c.first_name`,
    [batchId]
  );
  return { batch: batch.rows[0], items: items.rows };
}
