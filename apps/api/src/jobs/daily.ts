// Daily job runner. Jobs are idempotent per calendar date (each guards via
// its audit-log run record), so the tick can fire as often as it likes —
// including immediately after a restart — without double-sending anything.

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../audit.ts';
import { todayChicago } from '../modules/tax/deadlines.ts';
import { runEstimateReminderJob, runExtensionDecisionListJob, runSummerChaseJob } from '../modules/tax/extension.ts';
import { runHealthRefresh } from '../modules/crm/health.ts';
import { runNoticeEscalations } from '../modules/notices/service.ts';
import { runEntityComplianceJob } from '../modules/entity/service.ts';
import { runDocumentChaseJob } from '../modules/documents/service.ts';
import { runInvoiceOverdueJob } from '../modules/billing/service.ts';
import { runDunningJob } from '../modules/billing/dunning.ts';
import { runSosRecheckJob } from '../modules/entity/sos.ts';
import { runBackupStaleCheckJob, runRestoreDrillReminderJob } from '../modules/admin/ops.ts';
import { runDubsadoRetirementCheckJob } from '../modules/admin/dubsado-retirement.ts';
import { runLadderJob, runTaskReminderSweep } from '../modules/tasks/service.ts';
import { runPerfectionClockJob } from '../modules/tax/pipeline.ts';
import { runAutoExtensionBatchJob } from '../modules/tax/extension-batch.ts';
import { runVoucherReminderJob } from '../modules/grants/vouchers.ts';
import { runQuoteExpiryJob } from '../modules/pricing/quotes.ts';
import { runStripeDriftCheckJob } from '../modules/billing/drift.ts';
import { runReviewRequestJob } from '../modules/comms/review-requests.ts';
import { runEventReminderJob } from '../modules/events/service.ts';
import { runOnboardingRescueJob } from '../modules/portal-auth/onboarding-rescue.ts';
import { makePusher, runPushSweep } from '../notify/push.ts';

const TICK_MS = 15 * 60 * 1000;
const PUSH_SWEEP_MS = 60 * 1000; // alerts reach iPhones within a minute
/**
 * THE OUTBOX FAST LANE (2026-09-09).
 *
 * The outbox drain also runs inside the 15-minute tick, and that was the only place it ran.
 * Brian accepted a rehearsal quote eleven seconds after a tick — a deploy had just restarted
 * the API, so the tick's phase was wherever the restart put it — and the screen he had just
 * read said "your deposit invoice is on its way by email." It was: fifteen minutes away. He
 * reported nothing had triggered, and from where he sat nothing had.
 *
 * A client who has just accepted is at the moment of highest intent; the payment link has to
 * arrive while they are still holding the phone. So the drain gets the same fast lane the
 * push sweep has: every minute, cheap when empty (one indexed query that returns nothing).
 * The tick keeps its drain too — overlap is safe, each row is claimed FOR UPDATE SKIP LOCKED.
 *
 * Frozen at 60s deliberately: the portal copy promises "within a few minutes", and this is
 * the number that makes the copy true. Raise it and the copy is a lie again.
 */
export const OUTBOX_SWEEP_MS = 60 * 1000;

/**
 * ONE JOB'S FAILURE IS THAT JOB'S. 2026-09-10: the Stripe drift check threw on a payment the live
 * key could not see, and because the jobs ran as one straight line, everything after it — review
 * requests, event reminders, the perfection clock, the escalation ladder, the health refresh — did
 * not run that day, and would not have run any day until the throw was fixed. Each job now runs
 * inside its own try; a failure is logged with the job's name, written to the audit log as
 * job.failed, and the next job runs. Jobs stay idempotent per calendar date, so a tick can retry
 * a failed one on the next pass without touching the ones that succeeded.
 */
export interface DailyJob {
  name: string;
  run: (app: FastifyInstance, today: string) => Promise<Record<string, unknown> & { skipped?: boolean }>;
}

export const DAILY_JOBS: DailyJob[] = [
  { name: 'extension_decision_list', run: runExtensionDecisionListJob },
  { name: 'summer_chase', run: runSummerChaseJob },
  { name: 'estimate_reminder', run: runEstimateReminderJob },
  { name: 'entity_compliance', run: runEntityComplianceJob },
  { name: 'document_chase', run: runDocumentChaseJob },
  { name: 'invoice_overdue', run: runInvoiceOverdueJob },
  // v4.3 flow 4: dunning ladder + late fees, AFTER the overdue flip so freshly-overdue invoices
  // enter the ladder the same day.
  { name: 'ar_dunning', run: runDunningJob },
  { name: 'sos_recheck', run: runSosRecheckJob },
  { name: 'restore_drill_reminder', run: runRestoreDrillReminderJob },
  { name: 'backup_stale_check', run: runBackupStaleCheckJob },
  // Brian's trigger: alert once when Dubsado can be switched off.
  { name: 'dubsado_retirement', run: async (app, today) => { const r = await runDubsadoRetirementCheckJob(app, today); return { ...r, skipped: r.skipped || !r.alerted }; } },
  { name: 'voucher_reminders', run: runVoucherReminderJob },
  { name: 'onboarding_rescue', run: runOnboardingRescueJob },
  { name: 'auto_extension_batch', run: runAutoExtensionBatchJob },
  { name: 'quote_expiry', run: runQuoteExpiryJob },
  // 2026-09-09: does Stripe still agree with what SAOS says about every paid invoice?
  { name: 'stripe_drift', run: runStripeDriftCheckJob },
  { name: 'review_requests', run: runReviewRequestJob },
  { name: 'event_reminders', run: runEventReminderJob },
  // v4.3 flow 1: perfection-period clocks on rejected e-files.
  { name: 'perfection_clock', run: runPerfectionClockJob },
  // v4.5: the waiting-for-input escalation ladder (D3 email → D7 SMS → D14 call → D30 stalled).
  { name: 'escalation_ladder', run: async (app, today) => { const r = await runLadderJob(app, today); return { rungs: r.rungs, skipped: r.skipped }; } },
  // Restart safety: re-enqueue recordings stuck before processing began.
  { name: 'meeting_recovery', run: async (app) => {
    if (!app.meetingQueue) return { skipped: true };
    const { recoverStuckMeetings } = await import('../modules/meetings/pipeline.ts');
    const recovered = await recoverStuckMeetings(app, app.meetingQueue);
    return { recovered, skipped: recovered === 0 };
  } },
  /*
   * THE OUTBOX DRAIN, EVERY TICK — not daily (#48). Every row here is a client waiting: a payment
   * link, a signing link. Cheap when empty. The fast lane (OUTBOX_SWEEP_MS) drains it every minute
   * too; this is the belt to that suspender.
   */
  { name: 'outbox_drain', run: async (app) => { const { drainOutbox } = await import('../outbox.ts'); const r = await drainOutbox(app); return { ...r, skipped: r.considered === 0 }; } },
  // Notice escalations run EVERY tick (48h precision matters); idempotent per notice.
  { name: 'notice_escalations', run: async (app) => { const r = await runNoticeEscalations(app); return { ...r, skipped: !Object.values(r).some((v) => typeof v === 'number' && v > 0) }; } },
  { name: 'task_reminder_sweep', run: async (app) => { const r = await runTaskReminderSweep(app); return { ...r, skipped: !Object.values(r).some((v) => typeof v === 'number' && v > 0) }; } },
  // DEPENDENCY PROBE, every tick: can the API reach the scanner right now — the question nobody
  // was asking while ClamAV sat wedged for twelve hours.
  { name: 'dependency_probe', run: async (app) => { const { probeDependencies } = await import('../modules/admin/container-health.ts'); const d = await probeDependencies(app); if (d.alerted.length > 0) app.log.error({ job: 'dependency_probe', unreachable: d.alerted }, 'dependency unreachable'); return { unreachable: d.alerted, skipped: true }; } },
  { name: 'document_rescan', run: async (app) => { const { runDocumentRescanJob } = await import('../modules/documents/rescan.ts'); const { makeMinioClient } = await import('../modules/documents/storage.ts'); const r = await runDocumentRescanJob(app, makeMinioClient(app.config)); return { ...r, skipped: r.considered === 0 }; } },
  /*
   * FINDING #24 — payment reconciliation, every tick. A client who pays and closes the tab never
   * triggers the browser-side reconcile; a lost webhook would leave them unpaid indefinitely.
   * 2026-09-10: this sat behind the drift check's throw for a whole morning — every tick died
   * before reaching it. Isolated now, like everything else on this list.
   */
  { name: 'payment_reconcile', run: async (app) => { const { runPaymentReconcileJob } = await import('../modules/billing/reconcile.ts'); const r = await runPaymentReconcileJob(app); if (r.settled > 0 || r.retired > 0 || r.errors > 0) app.log.warn({ job: 'payment_reconcile', ...r }, 'settled payments the webhook never delivered'); return { ...r, skipped: true }; } },
];

export async function runJobsIsolated(app: FastifyInstance, today: string, jobs: DailyJob[]): Promise<{ ran: string[]; failed: string[] }> {
  const ran: string[] = [];
  const failed: string[] = [];
  for (const job of jobs) {
    try {
      const result = await job.run(app, today);
      ran.push(job.name);
      if (!result.skipped) app.log.info({ job: job.name, ...result }, 'daily job ran');
    } catch (err) {
      failed.push(job.name);
      app.log.error({ err, job: job.name }, 'daily job failed — the next one still runs');
      try {
        await writeAudit(app.db, {
          actorType: 'system', actorLabel: 'daily jobs',
          action: 'job.failed', objectType: 'job', objectId: job.name,
          details: { job: job.name, run_date: today, error: err instanceof Error ? err.message : String(err) },
        });
      } catch (auditErr) {
        app.log.error({ err: auditErr, job: job.name }, 'could not even record the failure');
      }
    }
  }
  return { ran, failed };
}

export async function runDailyJobs(app: FastifyInstance, today: string): Promise<void> {
  await runJobsIsolated(app, today, DAILY_JOBS);
}

export function startScheduler(app: FastifyInstance): NodeJS.Timeout {
  let lastHealthRun = '';
  const tick = async () => {
    try {
      const today = todayChicago();
      await runDailyJobs(app, today);
      if (lastHealthRun !== today) {
        // Health is transition-alerting and cheap at this scale — once per day, and isolated
        // like every other job (2026-09-10: it did not run because a job before it threw).
        const { failed } = await runJobsIsolated(app, today, [{ name: 'health_refresh', run: async (a) => ({ ...(await runHealthRefresh(a)) }) }]);
        if (failed.length === 0) lastHealthRun = today;
      }
    } catch (err) {
      app.log.error({ err }, 'daily job tick failed');
    }
  };
  void tick();
  const handle = setInterval(tick, TICK_MS);
  handle.unref();

  // Fast lane: leadership alerts push to iPhones within a minute (MP Alert Center).
  const pusher = makePusher(app.config);
  const pushHandle = setInterval(() => {
    runPushSweep(app, pusher).catch((err) => app.log.warn({ err }, 'push sweep failed'));
  }, PUSH_SWEEP_MS);
  pushHandle.unref();

  // Fast lane: client-facing effects (payment links, signing links) leave within a minute.
  const outboxHandle = setInterval(() => {
    runOutboxSweep(app).catch((err) => app.log.warn({ err }, 'outbox sweep failed'));
  }, OUTBOX_SWEEP_MS);
  outboxHandle.unref();
  return handle;
}

/**
 * One pass of the outbox fast lane. Separate from the tick so it can run every minute without
 * dragging the escalation, rescan and reconcile work along with it; logs only when it did
 * something, so an idle minute is silent.
 */
export async function runOutboxSweep(app: FastifyInstance): Promise<import('../outbox.ts').DrainResult> {
  const { drainOutbox } = await import('../outbox.ts');
  const outbox = await drainOutbox(app);
  if (outbox.considered > 0) {
    app.log.info({ job: 'outbox_sweep', ...outbox }, 'outbox effects performed');
  }
  return outbox;
}
