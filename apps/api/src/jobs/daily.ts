// Daily job runner. Jobs are idempotent per calendar date (each guards via
// its audit-log run record), so the tick can fire as often as it likes —
// including immediately after a restart — without double-sending anything.

import type { FastifyInstance } from 'fastify';
import { todayChicago } from '../modules/tax/deadlines.ts';
import { runExtensionDecisionListJob, runSummerChaseJob } from '../modules/tax/extension.ts';
import { runHealthRefresh } from '../modules/crm/health.ts';
import { runNoticeEscalations } from '../modules/notices/service.ts';
import { runEntityComplianceJob } from '../modules/entity/service.ts';
import { runDocumentChaseJob } from '../modules/documents/service.ts';
import { runInvoiceOverdueJob } from '../modules/billing/service.ts';
import { runSosRecheckJob } from '../modules/entity/sos.ts';

const TICK_MS = 15 * 60 * 1000;

export async function runDailyJobs(app: FastifyInstance, today: string): Promise<void> {
  const decision = await runExtensionDecisionListJob(app, today);
  if (!decision.skipped) app.log.info({ job: 'extension_decision_list', ...decision }, 'daily job ran');
  const chase = await runSummerChaseJob(app, today);
  if (!chase.skipped) app.log.info({ job: 'summer_chase', ...chase }, 'daily job ran');
  const entity = await runEntityComplianceJob(app, today);
  if (!entity.skipped) app.log.info({ job: 'entity_compliance', ...entity }, 'daily job ran');
  const docs = await runDocumentChaseJob(app, today);
  if (!docs.skipped) app.log.info({ job: 'document_chase', ...docs }, 'daily job ran');
  const invoices = await runInvoiceOverdueJob(app, today);
  if (!invoices.skipped) app.log.info({ job: 'invoice_overdue', ...invoices }, 'daily job ran');
  const sos = await runSosRecheckJob(app, today);
  if (!sos.skipped) app.log.info({ job: 'sos_recheck', ...sos }, 'daily job ran');
  // Restart safety: re-enqueue recordings stuck before processing began.
  if (app.meetingQueue) {
    const { recoverStuckMeetings } = await import('../modules/meetings/pipeline.ts');
    const recovered = await recoverStuckMeetings(app, app.meetingQueue);
    if (recovered > 0) app.log.info({ job: 'meeting_recovery', recovered }, 'stuck meetings re-enqueued');
  }
  // Notice escalations run EVERY tick (48h precision matters); idempotent per notice.
  const notices = await runNoticeEscalations(app);
  if (notices.unactioned > 0 || notices.deadline > 0) {
    app.log.info({ job: 'notice_escalations', ...notices }, 'escalations fired');
  }
}

/** Kick off the scheduler loop; health refresh runs on the first tick of each day too. */
export function startScheduler(app: FastifyInstance): NodeJS.Timeout {
  let lastHealthRun = '';
  const tick = async () => {
    try {
      const today = todayChicago();
      await runDailyJobs(app, today);
      if (lastHealthRun !== today) {
        // Health is transition-alerting and cheap at this scale — once per day.
        const summary = await runHealthRefresh(app);
        lastHealthRun = today;
        app.log.info({ job: 'health_refresh', ...summary }, 'daily job ran');
      }
    } catch (err) {
      app.log.error({ err }, 'daily job tick failed');
    }
  };
  void tick();
  const handle = setInterval(tick, TICK_MS);
  handle.unref();
  return handle;
}
