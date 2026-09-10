import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { todayChicago } from './deadlines.ts';
import {
  deadlineDashboard,
  extensionDecisionList,
  markExtensionDecision,
  markExtensionFiled,
  runEstimateReminderJob,
  runExtensionDecisionListJob,
  runSummerChaseJob,
  setExtensionPaymentEstimate,
} from './extension.ts';
import {
  approveBatch,
  batchWithItems,
  fileBatchItem,
  removeBatchItem,
  runAutoExtensionBatchJob,
} from './extension-batch.ts';
import { closeTasksForSource } from '../tasks/service.ts';

const DecisionBody = z.object({ recommend: z.boolean() });
const PaymentEstimateBody = z.object({ amountCents: z.number().int().positive() });
const PaymentMadeBody = z.object({ made: z.boolean() });
const ListQuery = z.object({ deadline: z.iso.date() });
const AsOfQuery = z.object({ asOf: z.iso.date().optional() });

function actorOf(request: FastifyRequest) {
  return { staffId: request.staff!.id, label: request.staff!.fullName };
}

export function registerExtensionRoutes(app: FastifyInstance): void {
  const manage = { preHandler: [app.authenticate, requirePermission('engagements.tax.manage')] };
  const read = { preHandler: [app.authenticate, requirePermission('engagements.read')] };
  const jobs = { preHandler: [app.authenticate, requirePermission('jobs.run')] };

  app.get('/tax-engagements/extension-decision-list', read, async (request) => {
    const q = ListQuery.parse(request.query);
    return { deadline: q.deadline, engagements: await extensionDecisionList(app, q.deadline) };
  });

  app.post<{ Params: { id: string } }>('/tax-engagements/:id/extension/decision', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = DecisionBody.parse(request.body);
    await markExtensionDecision(app, actorOf(request), id, b.recommend);
    return { status: 'ok' };
  });

  app.post<{ Params: { id: string } }>('/tax-engagements/:id/extension/payment-estimate', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = PaymentEstimateBody.parse(request.body);
    await setExtensionPaymentEstimate(app, actorOf(request), id, b.amountCents);
    return { status: 'ok' };
  });

  app.post<{ Params: { id: string } }>('/tax-engagements/:id/extension/payment-made', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = PaymentMadeBody.parse(request.body);
    await app.db.query(`UPDATE tax_engagements SET extension_payment_made = $2 WHERE id = $1`, [id, b.made]);
    return { status: 'ok' };
  });

  app.post<{ Params: { id: string } }>('/tax-engagements/:id/extension/filed', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const result = await markExtensionFiled(app, actorOf(request), id, todayChicago());
    return { status: 'ok', extendedDeadline: result.extendedDeadline };
  });

  app.get('/dashboards/deadlines', read, async (request) => {
    const q = AsOfQuery.parse(request.query);
    return deadlineDashboard(app, q.asOf ?? todayChicago());
  });

  // Manual/test triggers for the daily jobs (the scheduler in index.ts runs
  // them automatically with today's Chicago date).
  app.post('/jobs/extension-decision-list', jobs, async (request) => {
    const q = AsOfQuery.parse(request.query);
    return runExtensionDecisionListJob(app, q.asOf ?? todayChicago());
  });

  app.post('/jobs/summer-chase', jobs, async (request) => {
    const q = AsOfQuery.parse(request.query);
    return runSummerChaseJob(app, q.asOf ?? todayChicago());
  });

  app.post('/jobs/estimate-reminder', jobs, async (request) => {
    const q = AsOfQuery.parse(request.query);
    return runEstimateReminderJob(app, q.asOf ?? todayChicago());
  });

  // ── v4.3 flow 3: auto-extension batch (owner review before filing) ────────
  app.post('/jobs/auto-extension-batch', jobs, async (request) => {
    const q = AsOfQuery.parse(request.query);
    return runAutoExtensionBatchJob(app, q.asOf ?? todayChicago());
  });

  app.get('/extension-batches', read, async () => {
    const { rows } = await app.db.query(
      `SELECT b.id, b.tax_year, b.deadline_date::text AS deadline_date,
              b.cutoff_date::text AS cutoff_date, b.status, b.approved_at,
              (SELECT count(*)::int FROM extension_batch_items i WHERE i.batch_id = b.id AND i.removed_at IS NULL) AS items,
              (SELECT count(*)::int FROM extension_batch_items i WHERE i.batch_id = b.id AND i.filed_at IS NOT NULL) AS filed
       FROM extension_batches b ORDER BY b.deadline_date DESC`
    );
    return { batches: rows };
  });

  app.get<{ Params: { id: string } }>('/extension-batches/:id', read, async (request) => {
    return batchWithItems(app, z.uuid().parse(request.params.id));
  });

  // Approval is leadership-only — this IS the owner-review gate.
  app.post<{ Params: { id: string } }>('/extension-batches/:id/approve', jobs, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const result = await approveBatch(app, id, request.staff!);
    // The review task is done once the batch is approved.
    await closeTasksForSource(app, 'extension_batch_review', id, 'batch approved');
    return { status: 'approved', ...result };
  });

  app.delete<{ Params: { id: string; teId: string } }>('/extension-batches/:id/items/:teId', jobs, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const teId = z.uuid().parse(request.params.teId);
    await removeBatchItem(app, id, teId, request.staff!);
    return { status: 'ok' };
  });

  // Preparers file — refused until the batch is approved.
  app.post<{ Params: { id: string; teId: string } }>('/extension-batches/:id/items/:teId/filed', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const teId = z.uuid().parse(request.params.teId);
    const q = AsOfQuery.parse(request.query);
    return fileBatchItem(app, id, teId, request.staff!, q.asOf ?? todayChicago());
  });
}
