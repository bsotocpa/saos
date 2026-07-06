// Daily job runner. Jobs are idempotent per calendar date (each guards via
// its audit-log run record), so the tick can fire as often as it likes —
// including immediately after a restart — without double-sending anything.

import type { FastifyInstance } from 'fastify';
import { todayChicago } from '../modules/tax/deadlines.ts';
import { runExtensionDecisionListJob, runSummerChaseJob } from '../modules/tax/extension.ts';
import { runHealthRefresh } from '../modules/crm/health.ts';

const TICK_MS = 15 * 60 * 1000;

export async function runDailyJobs(app: FastifyInstance, today: string): Promise<void> {
  const decision = await runExtensionDecisionListJob(app, today);
  if (!decision.skipped) app.log.info({ job: 'extension_decision_list', ...decision }, 'daily job ran');
  const chase = await runSummerChaseJob(app, today);
  if (!chase.skipped) app.log.info({ job: 'summer_chase', ...chase }, 'daily job ran');
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
