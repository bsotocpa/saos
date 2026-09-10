// M26 flow 3: the auto-extension batch (v4.3 DECIDED).
//
// Engagements still missing documents are swept into a batch as their own
// deadline approaches, the client is notified that a protective extension is
// coming ("this is normal and protects you"), and BRIAN APPROVES THE BATCH
// before any preparer files. Filing without approval is refused in code, not
// convention. Approved-and-filed engagements re-enter the normal flow with
// their DERIVED extended deadline (markExtensionFiled → THE_TABLE).
//
// THE SWEEP IS DERIVED PER ENGAGEMENT (Brian, 2026-08-09 — correcting the
// spec's fixed Mar 25 / Apr 1 lanes, which fell AFTER the Mar 15 business
// deadline and so protected nothing):
//
//     cutoff = original due date − offset      (offset: setting, default 10)
//
// so 1065/1120-S sweep ~Mar 5, 1040/1120 ~Apr 5, 990s ~May 5, and fiscal-year
// filers and every future return type handle themselves with no settings
// maintenance. Fixed dates rot; the table doesn't. A batch is keyed on the
// DEADLINE it protects, and the sweep never fires on or after that deadline —
// an extension filed late protects nobody.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { AppError } from '../../types.ts';
import { isAutomationEnabled } from '../../automations.ts';
import { firstActiveByRole } from '../../staffing.ts';
import { createTask } from '../tasks/service.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { AUTOMATIC_EXTENSION_TYPES, addDays, originalDeadline, type DeadlineReturnType, calendarDay } from './deadlines.ts';
import { markExtensionFiled } from './extension.ts';

/** Stages where documents are still outstanding (pre-preparation work). */
const PRE_INTERNAL_REVIEW = [
  'intake_started', 'scheduled', 'documents_requested', 'pending_client_response', 'in_preparation', 'on_hold',
];

/**
 * The sweep window for one engagement, derived from the deadline table.
 * Returns null when the return type has no standalone deadline (W-7) or gets
 * its extension automatically (FBAR — nothing to file).
 */
export function sweepWindow(
  returnType: DeadlineReturnType,
  taxYear: number,
  fiscalYearEndMonth: number,
  offsetDays: number
): { deadline: string; cutoff: string } | null {
  if (AUTOMATIC_EXTENSION_TYPES.includes(returnType)) return null;
  const deadline = originalDeadline(returnType, taxYear, fiscalYearEndMonth);
  if (!deadline) return null;
  return { deadline, cutoff: addDays(deadline, -offsetDays) };
}

/** Days before the original due date that the protective sweep runs. */
async function offsetDays(app: FastifyInstance): Promise<number> {
  const { rows } = await app.db.query<{ value: number }>(
    `SELECT (value)::text::int AS value FROM app_settings WHERE key = 'extension.auto_batch_offset_days'`
  );
  return rows[0]?.value ?? 10;
}

/**
 * Daily, date-guarded. Sweeps every engagement whose derived cutoff window is
 * open today into the batch for its deadline (idempotent per engagement),
 * notifies the clients (kill-switch gated), and opens Brian's review task.
 */
export async function runAutoExtensionBatchJob(
  app: FastifyInstance,
  today: string
): Promise<{ skipped: boolean; added: number; notified: number; suppressed: number; batches: string[] }> {
  const ACTION = 'job.auto_extension_batch';
  const already = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = $1 AND details->>'run_date' = $2 LIMIT 1`,
    [ACTION, today]
  );
  if (already.rows.length > 0) return { skipped: true, added: 0, notified: 0, suppressed: 0, batches: [] };

  const offset = await offsetDays(app);

  // Every engagement still waiting on documents, regardless of year or type —
  // the deadline table decides which of them are due for a sweep TODAY.
  const { rows } = await app.db.query<{
    id: string; return_type: DeadlineReturnType; tax_year: number; fiscal_year_end_month: number | null;
    contact_id: string; first_name: string; email: string | null; language: 'en' | 'es';
  }>(
    `SELECT te.id, te.return_type, te.tax_year, b.fiscal_year_end_month,
            c.id AS contact_id, c.first_name, c.email, c.language
     FROM tax_engagements te
     JOIN engagements e ON e.id = te.engagement_id
     JOIN contacts c ON c.id = e.contact_id
     LEFT JOIN businesses b ON b.id = e.business_id
     WHERE te.docs_received_at IS NULL
       AND NOT te.extension_filed
       AND te.stage = ANY($1::tax_stage[])`,
    [PRE_INTERNAL_REVIEW]
  );

  const noticesArmed = await isAutomationEnabled(app, 'extension_notices');
  const brian = await firstActiveByRole(app.db, 'ceo');
  const perBatch = new Map<string, { batchId: string; deadline: string; taxYear: number; added: number }>();
  let added = 0;
  let notified = 0;
  let suppressed = 0;

  for (const te of rows) {
    const window = sweepWindow(te.return_type, te.tax_year, te.fiscal_year_end_month ?? 12, offset);
    if (!window) continue;
    // In the window: from the cutoff up to (never on or past) the deadline. The
    // >= makes a missed run day self-correcting; the < keeps the system from
    // ever "protecting" a return whose deadline has already passed.
    if (calendarDay(today) < calendarDay(window.cutoff, 'cutoff') || calendarDay(today) >= calendarDay(window.deadline, 'deadline')) continue;

    const key = `${te.tax_year}|${window.deadline}`;
    let batch = perBatch.get(key);
    if (!batch) {
      const created = await app.db.query<{ id: string }>(
        `INSERT INTO extension_batches (tax_year, deadline_date, cutoff_date)
         VALUES ($1, $2, $3)
         ON CONFLICT (tax_year, deadline_date) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [te.tax_year, window.deadline, window.cutoff]
      );
      batch = { batchId: created.rows[0]!.id, deadline: window.deadline, taxYear: te.tax_year, added: 0 };
      perBatch.set(key, batch);
    }

    const ins = await app.db.query(
      `INSERT INTO extension_batch_items (batch_id, tax_engagement_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [batch.batchId, te.id]
    );
    if ((ins.rowCount ?? 0) === 0) continue; // already swept on an earlier day
    added++;
    batch.added++;

    // Client notice: reassuring, not alarming (v4.3 copy intent).
    if (!te.email) continue;
    if (!noticesArmed) { suppressed++; continue; }
    await sendTemplatedEmail(app, {
      to: te.email,
      templateKey: 'protective_extension_notice',
      language: te.language,
      contactId: te.contact_id,
      vars: { first_name: te.first_name, tax_year: String(te.tax_year), portal_link: app.config.PORTAL_BASE_URL },
    });
    await app.db.query(
      `UPDATE extension_batch_items SET client_notified_at = now() WHERE batch_id = $1 AND tax_engagement_id = $2`,
      [batch.batchId, te.id]
    );
    notified++;
  }

  // Brian's review gate is a WORK ITEM (owner rollup), one per batch. createTask
  // dedupes on (source_type, source_id), so a batch that grows over several
  // days keeps ONE review task.
  for (const batch of perBatch.values()) {
    if (batch.added === 0 || !brian) continue;
    await createTask(app, {
      title: `Review the ${batch.taxYear} extension batch for the ${batch.deadline} deadline — approve before preparers file`,
      description:
        `Protective extensions swept ${offset} days before the ${batch.deadline} due date. Pull anything that ` +
        'should not be extended, then approve. Preparers cannot file batch items until the batch is approved.',
      assignedStaffId: brian,
      priority: 2,
      source: 'automation',
      sourceType: 'extension_batch_review',
      sourceId: batch.batchId,
    });
  }

  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'daily-jobs',
    action: ACTION,
    details: {
      run_date: today, offset_days: offset, added, notified, suppressed,
      deadlines: [...perBatch.values()].map((b) => b.deadline),
    },
  });
  return { skipped: false, added, notified, suppressed, batches: [...perBatch.values()].map((b) => b.batchId) };
}

export async function approveBatch(
  app: FastifyInstance,
  batchId: string,
  actor: { id: string; email: string; fullName: string }
): Promise<{ items: number }> {
  const batch = await app.db.query<{ status: string; tax_year: number; deadline_date: string }>(
    `SELECT status, tax_year, deadline_date::text AS deadline_date FROM extension_batches WHERE id = $1`,
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
    actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
    action: 'extension_batch.approved', objectType: 'extension_batch', objectId: batchId,
    details: { tax_year: batch.rows[0].tax_year, deadline: batch.rows[0].deadline_date, items: count.rows[0]!.n },
  });
  return { items: count.rows[0]!.n };
}

/** Brian pulls an engagement out during review (approved batches too). */
export async function removeBatchItem(
  app: FastifyInstance,
  batchId: string,
  taxEngagementId: string,
  actor: { id: string; email: string; fullName: string }
): Promise<void> {
  const res = await app.db.query(
    `UPDATE extension_batch_items SET removed_at = now()
     WHERE batch_id = $1 AND tax_engagement_id = $2 AND filed_at IS NULL AND removed_at IS NULL`,
    [batchId, taxEngagementId]
  );
  if (res.rowCount === 0) throw new AppError(404, 'not_found', 'Batch item not found (or already filed).');
  await writeAudit(app.db, {
    actorType: 'staff', actorId: actor.id, actorLabel: actor.fullName,
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
  actor: { id: string; email: string; fullName: string },
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

  const result = await markExtensionFiled(app, { staffId: actor.id, label: actor.fullName }, taxEngagementId, today);
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
    `SELECT b.id, b.tax_year, b.deadline_date::text AS deadline_date,
            b.cutoff_date::text AS cutoff_date, b.status, b.approved_at,
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
