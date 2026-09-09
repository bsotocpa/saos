// Daily job runner. Jobs are idempotent per calendar date (each guards via
// its audit-log run record), so the tick can fire as often as it likes —
// including immediately after a restart — without double-sending anything.

import type { FastifyInstance } from 'fastify';
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

export async function runDailyJobs(app: FastifyInstance, today: string): Promise<void> {
  const decision = await runExtensionDecisionListJob(app, today);
  if (!decision.skipped) app.log.info({ job: 'extension_decision_list', ...decision }, 'daily job ran');
  const chase = await runSummerChaseJob(app, today);
  if (!chase.skipped) app.log.info({ job: 'summer_chase', ...chase }, 'daily job ran');
  const estimates = await runEstimateReminderJob(app, today);
  if (!estimates.skipped) app.log.info({ job: 'estimate_reminder', ...estimates }, 'daily job ran');
  const entity = await runEntityComplianceJob(app, today);
  if (!entity.skipped) app.log.info({ job: 'entity_compliance', ...entity }, 'daily job ran');
  const docs = await runDocumentChaseJob(app, today);
  if (!docs.skipped) app.log.info({ job: 'document_chase', ...docs }, 'daily job ran');
  const invoices = await runInvoiceOverdueJob(app, today);
  if (!invoices.skipped) app.log.info({ job: 'invoice_overdue', ...invoices }, 'daily job ran');
  // v4.3 flow 4: dunning ladder + late fees (runs AFTER the overdue flip so
  // freshly-overdue invoices enter the ladder the same day).
  const dunning = await runDunningJob(app, today);
  if (!dunning.skipped) app.log.info({ job: 'ar_dunning', ...dunning }, 'daily job ran');
  const sos = await runSosRecheckJob(app, today);
  if (!sos.skipped) app.log.info({ job: 'sos_recheck', ...sos }, 'daily job ran');
  const drill = await runRestoreDrillReminderJob(app, today);
  if (!drill.skipped) app.log.info({ job: 'restore_drill_reminder', ...drill }, 'daily job ran');
  const backup = await runBackupStaleCheckJob(app, today);
  if (!backup.skipped) app.log.info({ job: 'backup_stale_check', ...backup }, 'daily job ran');
  // Brian's trigger: alert once when Dubsado can be switched off.
  const dubsado = await runDubsadoRetirementCheckJob(app, today);
  if (!dubsado.skipped && dubsado.alerted) app.log.info({ job: 'dubsado_retirement', ...dubsado.readiness }, 'retirement trigger met');
  // v4.3 flow 6: funder-deadline reminders on open voucher periods.
  const vouchers = await runVoucherReminderJob(app, today);
  if (!vouchers.skipped) app.log.info({ job: 'voucher_reminders', ...vouchers }, 'daily job ran');
  // v4.3 flow 7: stalled-onboarding rescue (Day-60 decisions to Brian).
  const rescue = await runOnboardingRescueJob(app, today);
  if (!rescue.skipped) app.log.info({ job: 'onboarding_rescue', ...rescue }, 'daily job ran');
  // v4.3 flow 3: season auto-extension batch. The sweep window is DERIVED per
  // engagement — original due date minus the admin offset (default 10 days).
  const extBatch = await runAutoExtensionBatchJob(app, today);
  if (!extBatch.skipped) app.log.info({ job: 'auto_extension_batch', ...extBatch }, 'daily job ran');
  // M27: expire quotes past their date, back to the pipeline with a reason.
  const quoteExpiry = await runQuoteExpiryJob(app, today);
  if (!quoteExpiry.skipped) app.log.info({ job: 'quote_expiry', ...quoteExpiry }, 'daily job ran');
  // M27: review asks off accepted returns / completed onboardings. Client-acting,
  // so gated by the review_requests kill switch; every skip is recorded.
  const reviews = await runReviewRequestJob(app, today);
  if (!reviews.skipped) app.log.info({ job: 'review_requests', ...reviews }, 'daily job ran');
  // M27: T-1 reminders for tomorrow's Hilo workshops. Client-acting, so gated by
  // the event_reminders kill switch; the SMS half additionally needs the
  // registrant's own opt-in plus the standing TCPA consent gate.
  const eventReminders = await runEventReminderJob(app, today);
  if (!eventReminders.skipped) app.log.info({ job: 'event_reminders', ...eventReminders }, 'daily job ran');
  // v4.3 flow 1: perfection-period clocks on rejected e-files.
  const perfection = await runPerfectionClockJob(app, today);
  if (!perfection.skipped) app.log.info({ job: 'perfection_clock', ...perfection }, 'daily job ran');
  // v4.5: the waiting-for-input escalation ladder (D3 email → D7 SMS → D14 call → D30 stalled).
  const ladder = await runLadderJob(app, today);
  if (!ladder.skipped) app.log.info({ job: 'escalation_ladder', rungs: ladder.rungs }, 'daily job ran');
  // Restart safety: re-enqueue recordings stuck before processing began.
  if (app.meetingQueue) {
    const { recoverStuckMeetings } = await import('../modules/meetings/pipeline.ts');
    const recovered = await recoverStuckMeetings(app, app.meetingQueue);
    if (recovered > 0) app.log.info({ job: 'meeting_recovery', recovered }, 'stuck meetings re-enqueued');
  }
  /*
   * THE OUTBOX DRAIN, EVERY TICK — not daily (#48).
   *
   * Every row here is a client waiting: a payment link, a signing link. The gap between the
   * state committing and the client hearing about it should be minutes. Cheap when empty —
   * one indexed query that returns nothing and breaks out.
   *
   * Runs FIRST among the tick jobs, ahead of the escalation work, because chasing someone
   * about a document while an unsent invoice sits in the queue is the wrong order to do
   * things in.
   */
  const { drainOutbox } = await import('../outbox.ts');
  const outbox = await drainOutbox(app);
  if (outbox.considered > 0) {
    app.log.info({ job: 'outbox_drain', ...outbox }, 'outbox effects performed');
  }

  // Notice escalations run EVERY tick (48h precision matters); idempotent per notice.
  const notices = await runNoticeEscalations(app);
  if (notices.unactioned > 0 || notices.deadline > 0) {
    app.log.info({ job: 'notice_escalations', ...notices }, 'escalations fired');
  }
  // Task reminders every tick too (reminded_at NULL-check makes it idempotent;
  // 15-minute granularity is fine for a "remind me at" alarm).
  const reminders = await runTaskReminderSweep(app);
  if (reminders.reminded > 0) app.log.info({ job: 'task_reminders', ...reminders }, 'reminders fired');

  // DEPENDENCY PROBE, every tick — not daily. Docker health answers "does the
  // container think it is fine"; this answers "can the API reach the scanner right
  // now", which is the question that matters and the one nobody was asking while
  // ClamAV sat wedged for twelve hours.
  const { probeDependencies } = await import('../modules/admin/container-health.ts');
  const deps = await probeDependencies(app);
  if (deps.alerted.length > 0) {
    app.log.error({ job: 'dependency_probe', unreachable: deps.alerted }, 'dependency unreachable');
  }

  // FINDING #14 — rescan documents whose verdict is still outstanding, every tick.
  //
  // Every tick, not daily: this is the mechanism that makes "intake never refuses"
  // honest. A document sitting at 'skipped' is a client who uploaded what we asked
  // for and is still being chased for it. The gap between the scanner coming back and
  // the filing completing should be minutes, not until tomorrow.
  //
  // It no-ops cheaply when there is nothing outstanding — one indexed query.
  const { runDocumentRescanJob } = await import('../modules/documents/rescan.ts');
  const { makeMinioClient } = await import('../modules/documents/storage.ts');
  const rescan = await runDocumentRescanJob(app, makeMinioClient(app.config));
  if (rescan.considered > 0) {
    app.log.info({ job: 'document_rescan', ...rescan }, 'rescanned documents awaiting a verdict');
  }

  /*
   * FINDING #24 — payment reconciliation, every tick.
   *
   * A client who pays and closes the tab never triggers the browser-side reconcile, so
   * a lost webhook would leave them marked unpaid indefinitely. This asks Stripe about
   * any checkout started and not settled. Every tick rather than daily: the gap between
   * a client's money leaving and our record agreeing should be minutes.
   */
  const { runPaymentReconcileJob } = await import('../modules/billing/reconcile.ts');
  const recon = await runPaymentReconcileJob(app);
  if (recon.settled > 0 || recon.errors > 0) {
    app.log.warn({ job: 'payment_reconcile', ...recon }, 'settled payments the webhook never delivered');
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
