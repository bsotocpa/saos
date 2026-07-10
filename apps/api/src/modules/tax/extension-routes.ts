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

const DecisionBody = z.object({ recommend: z.boolean() });
const PaymentEstimateBody = z.object({ amountCents: z.number().int().positive() });
const PaymentMadeBody = z.object({ made: z.boolean() });
const ListQuery = z.object({ deadline: z.iso.date() });
const AsOfQuery = z.object({ asOf: z.iso.date().optional() });

function actorOf(request: FastifyRequest) {
  return { staffId: request.staff!.id, label: request.staff!.email };
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
}
