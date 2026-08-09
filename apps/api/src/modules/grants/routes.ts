// Grant vouchering routes (M26 flow 6) + the onboarding-rescue board (flow 7).
// Vouchering is STATUS TRACKING ONLY — there is deliberately no export, no
// file generation, no funder submission endpoint anywhere in this module.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { todayChicago } from '../tax/deadlines.ts';
import { createVoucherPeriod, runVoucherReminderJob, setVoucherStatus, voucherBoard } from './vouchers.ts';
import { onboardingPipeline, runOnboardingRescueJob } from '../portal-auth/onboarding-rescue.ts';

const PeriodBody = z.object({
  grantId: z.uuid(),
  periodLabel: z.string().min(1).max(60),
  periodStart: z.iso.date().optional(),
  periodEnd: z.iso.date().optional(),
  funderDueDate: z.iso.date().optional(),
  amountCents: z.number().int().nonnegative().optional(),
  notes: z.string().max(2000).optional(),
});

export function registerGrantVoucherRoutes(app: FastifyInstance): void {
  // Grants are leadership/nonprofit-CFO work; the same guard the grants
  // module already uses for its records.
  const manage = { preHandler: [app.authenticate, requirePermission('jobs.run')] };

  app.get('/grant-vouchers', manage, async () => voucherBoard(app));

  app.post('/grant-vouchers', manage, async (request, reply) => {
    const b = PeriodBody.parse(request.body);
    const result = await createVoucherPeriod(
      app,
      {
        grantId: b.grantId, periodLabel: b.periodLabel,
        periodStart: b.periodStart ?? null, periodEnd: b.periodEnd ?? null,
        funderDueDate: b.funderDueDate ?? null, amountCents: b.amountCents ?? null,
        notes: b.notes ?? null,
      },
      request.staff!
    );
    return reply.code(result.created ? 201 : 200).send(result);
  });

  app.patch<{ Params: { id: string } }>('/grant-vouchers/:id', manage, async (request) => {
    const id = z.uuid().parse(request.params.id);
    const b = z.object({ status: z.enum(['due', 'in_progress', 'submitted', 'reimbursed']) }).parse(request.body);
    await setVoucherStatus(app, id, b.status, request.staff!);
    return { status: 'ok' };
  });

  app.post('/jobs/voucher-reminders', manage, async (request) => {
    const q = z.object({ asOf: z.iso.date().optional() }).parse(request.query);
    return runVoucherReminderJob(app, q.asOf ?? todayChicago());
  });

  // ── flow 7: onboarding pipeline + rescue ──────────────────────────────────
  app.get('/onboarding-pipeline', { preHandler: [app.authenticate, requirePermission('contacts.read')] }, async () => {
    return { onboarding: await onboardingPipeline(app) };
  });

  app.post('/jobs/onboarding-rescue', manage, async (request) => {
    const q = z.object({ asOf: z.iso.date().optional() }).parse(request.query);
    return runOnboardingRescueJob(app, q.asOf ?? todayChicago());
  });
}
