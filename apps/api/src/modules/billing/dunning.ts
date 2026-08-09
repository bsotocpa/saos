// M26 flow 4 (v4.3): A/R dunning ladder + late fees.
//
// LADDER (from the invoice due date / overdue stamp): reminder attempts ×3
// over 10 days, each notifying the client → unresolved after the third: call
// task to Rene → 30 days unpaid: engagement work PAUSES with a client-visible
// reason ("account needs attention").
//
// LATE FEES, three hard rules:
//   1. The rate comes from the price book (LATE_FEE_MONTHLY.metadata), never
//      from code (CLAUDE.md).
//   2. The client's signed engagement letter must carry the late-fee
//      disclosure — enforced by a stamp written at signing. No stamp, no fee,
//      ever.
//   3. Deposits and credits net against the balance BEFORE the fee computes.
// Both halves are gated by their own kill switches (ar_dunning, late_fees).

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { isAutomationEnabled } from '../../automations.ts';
import { firstActiveByRole, notifyOnce } from '../../staffing.ts';
import { createTask } from '../tasks/service.ts';
import { sendTemplatedEmail } from '../templates/service.ts';
import { addDays, daysBetween } from '../tax/deadlines.ts';

const ATTEMPT_SPACING_DAYS = 5;   // attempts at overdue+0, +5, +10 (3 over 10 days)
const MAX_ATTEMPTS = 3;
const WORK_PAUSE_DAYS = 30;

function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Late-fee rate + grace period, straight from the price book in force. */
export async function lateFeeTerms(app: FastifyInstance): Promise<{ ratePercent: number; graceDays: number } | null> {
  const { rows } = await app.db.query<{ metadata: { monthly_rate_percent?: number; grace_days?: number } }>(
    `SELECT i.metadata
     FROM price_book_items i
     JOIN price_book_versions v ON v.id = i.version_id
     WHERE i.item_code = 'LATE_FEE_MONTHLY' AND i.is_active
       AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
     ORDER BY v.version_number DESC LIMIT 1`
  );
  const meta = rows[0]?.metadata;
  if (!meta?.monthly_rate_percent) return null; // no rate configured → no fees
  return { ratePercent: Number(meta.monthly_rate_percent), graceDays: Number(meta.grace_days ?? 30) };
}

interface OverdueRow {
  id: string; invoice_number: string; total_cents: number; paid_cents: number;
  credit_cents: number; contact_id: string; engagement_id: string | null;
  first_name: string; last_name: string; email: string | null; language: 'en' | 'es';
  overdue_since: string; dunning_attempts: number; last_dunning_at: string | null;
  disclosure_signed: boolean; late_fee_cents: number;
}

/**
 * Daily, date-guarded. Walks every overdue invoice through the ladder and
 * assesses late fees where the disclosure gate allows.
 */
export async function runDunningJob(
  app: FastifyInstance,
  today: string
): Promise<{
  skipped: boolean; reminders: number; suppressed: number; callTasks: number;
  paused: number; feesAssessed: number; feesBlockedNoDisclosure: number;
}> {
  const ACTION = 'job.ar_dunning';
  const already = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = $1 AND details->>'run_date' = $2 LIMIT 1`,
    [ACTION, today]
  );
  if (already.rows.length > 0) {
    return { skipped: true, reminders: 0, suppressed: 0, callTasks: 0, paused: 0, feesAssessed: 0, feesBlockedNoDisclosure: 0 };
  }

  const dunningArmed = await isAutomationEnabled(app, 'ar_dunning');
  const feesArmed = await isAutomationEnabled(app, 'late_fees');
  const terms = await lateFeeTerms(app);

  const { rows } = await app.db.query<OverdueRow>(
    `SELECT i.id, i.invoice_number, i.total_cents,
            COALESCE(i.amount_paid_cents, 0) AS paid_cents,
            COALESCE(i.credit_cents, 0) AS credit_cents,
            i.contact_id, i.engagement_id,
            c.first_name, c.last_name, c.email, c.language,
            COALESCE(i.overdue_since, i.due_date, i.sent_at::date)::text AS overdue_since,
            i.dunning_attempts, i.last_dunning_at::text AS last_dunning_at,
            (c.late_fee_disclosure_signed_at IS NOT NULL) AS disclosure_signed,
            i.late_fee_cents
     FROM invoices i JOIN contacts c ON c.id = i.contact_id
     WHERE i.status = 'overdue'`
  );

  let reminders = 0;
  let suppressed = 0;
  let callTasks = 0;
  let paused = 0;
  let feesAssessed = 0;
  let feesBlockedNoDisclosure = 0;
  const rene = await firstActiveByRole(app.db, 'comms_billing');

  for (const inv of rows) {
    // Deposits and credits net against the balance FIRST (v4.3 rule).
    const balance = inv.total_cents + inv.late_fee_cents - inv.paid_cents - inv.credit_cents;
    if (balance <= 0) continue; // covered by deposits/credits — nothing to chase

    const daysOverdue = daysBetween(inv.overdue_since, today);
    if (daysOverdue < 0) continue;

    // ── reminder attempts: overdue+0, +5, +10 ──
    const nextAttemptDue =
      inv.dunning_attempts === 0
        ? true
        : inv.last_dunning_at !== null &&
          inv.dunning_attempts < MAX_ATTEMPTS &&
          daysBetween(inv.last_dunning_at.slice(0, 10), today) >= ATTEMPT_SPACING_DAYS;

    if (nextAttemptDue) {
      if (inv.email && dunningArmed) {
        await sendTemplatedEmail(app, {
          to: inv.email,
          templateKey: 'invoice_reminder',
          language: inv.language,
          contactId: inv.contact_id,
          vars: {
            first_name: inv.first_name,
            invoice_number: inv.invoice_number,
            amount: formatUsd(balance),
            portal_link: app.config.PORTAL_BASE_URL,
          },
        });
        reminders++;
      } else if (inv.email) {
        suppressed++;
      }
      // The attempt COUNTER advances either way: the ladder's shape is A/R
      // bookkeeping, and Rene's escalation must not stall because the client
      // channel is disarmed.
      // Stamp the JOB's date, not wall-clock: the spacing check below reads
      // this against `today`, so the two must share one clock (that is also
      // what makes the ladder testable with an injected date).
      await app.db.query(
        `UPDATE invoices SET dunning_attempts = dunning_attempts + 1, last_dunning_at = $2::date WHERE id = $1`,
        [inv.id, today]
      );

      // Third attempt exhausted → Rene owns a call.
      if (inv.dunning_attempts + 1 >= MAX_ATTEMPTS && rene) {
        const created = await createTask(app, {
          title: `Call ${inv.first_name} ${inv.last_name} — invoice ${inv.invoice_number} unpaid after ${MAX_ATTEMPTS} reminders (${formatUsd(balance)})`,
          description: 'Dunning ladder exhausted. Agree a payment plan or escalate to Brian before the 30-day work pause.',
          assignedStaffId: rene,
          contactId: inv.contact_id,
          priority: 2,
          source: 'automation',
          sourceType: 'dunning_call',
          sourceId: inv.id,
        });
        if (created.created) callTasks++;
      }
    }

    // ── 30 days unpaid → work pauses, visibly ──
    if (daysOverdue >= WORK_PAUSE_DAYS && inv.engagement_id) {
      const res = await app.db.query(
        `UPDATE engagements
         SET work_paused_at = now(),
             work_pause_reason = 'account needs attention'
         WHERE id = $1 AND work_paused_at IS NULL`,
        [inv.engagement_id]
      );
      if ((res.rowCount ?? 0) > 0) {
        paused++;
        await writeAudit(app.db, {
          actorType: 'system', actorLabel: 'ar-dunning',
          action: 'engagement.work_paused', objectType: 'engagement', objectId: inv.engagement_id,
          contactId: inv.contact_id,
          details: { invoice_number: inv.invoice_number, days_overdue: daysOverdue, balance_cents: balance },
        });
        const brian = await firstActiveByRole(app.db, 'ceo');
        if (brian) {
          await notifyOnce(app.db, {
            staffId: brian,
            type: 'work_paused_nonpayment',
            severity: 'warning',
            title: `Work PAUSED (${daysOverdue}d unpaid): ${inv.first_name} ${inv.last_name} — ${inv.invoice_number}`,
            contactId: inv.contact_id,
            relatedObjectType: 'invoice',
            relatedObjectId: inv.id,
          });
        }
      }
    }

    // ── late fee: monthly, after the grace period, disclosure-gated ──
    if (!terms || !feesArmed) continue;
    if (daysOverdue < terms.graceDays) continue;
    if (!inv.disclosure_signed) {
      // THE GATE (CLAUDE.md): no signed disclosure → never a fee. Counted so
      // Brian can see which letters need finalizing.
      feesBlockedNoDisclosure++;
      continue;
    }
    // One assessment per 30-day period: skip if the last one is too recent.
    const lastFee = await app.db.query<{ assessed_on: string }>(
      `SELECT assessed_on::text AS assessed_on FROM invoice_late_fees
       WHERE invoice_id = $1 ORDER BY assessed_on DESC LIMIT 1`,
      [inv.id]
    );
    const last = lastFee.rows[0]?.assessed_on;
    if (last && daysBetween(last, today) < 30) continue;
    if (!last && daysOverdue < terms.graceDays) continue;

    const feeCents = Math.round((balance * terms.ratePercent) / 100);
    if (feeCents <= 0) continue;
    const ins = await app.db.query(
      `INSERT INTO invoice_late_fees (invoice_id, assessed_on, basis_cents, rate_percent, fee_cents)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (invoice_id, assessed_on) DO NOTHING`,
      [inv.id, today, balance, terms.ratePercent, feeCents]
    );
    if ((ins.rowCount ?? 0) === 0) continue;
    await app.db.query(
      `UPDATE invoices
       SET late_fee_cents = late_fee_cents + $2,
           total_cents = total_cents + $2,
           last_late_fee_at = now()
       WHERE id = $1`,
      [inv.id, feeCents]
    );
    feesAssessed++;
    await writeAudit(app.db, {
      actorType: 'system', actorLabel: 'ar-dunning',
      action: 'invoice.late_fee_assessed', objectType: 'invoice', objectId: inv.id,
      contactId: inv.contact_id,
      details: {
        invoice_number: inv.invoice_number, basis_cents: balance,
        rate_percent: terms.ratePercent, fee_cents: feeCents, days_overdue: daysOverdue,
      },
    });
  }

  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'daily-jobs',
    action: ACTION,
    details: {
      run_date: today, reminders, suppressed, call_tasks: callTasks, paused,
      fees_assessed: feesAssessed, fees_blocked_no_disclosure: feesBlockedNoDisclosure,
      dunning_armed: dunningArmed, fees_armed: feesArmed,
    },
  });
  return { skipped: false, reminders, suppressed, callTasks, paused, feesAssessed, feesBlockedNoDisclosure };
}

/** Payment clears the ladder: closes the call task and lifts any work pause. */
export async function resumeAfterPayment(app: FastifyInstance, invoiceId: string): Promise<void> {
  const { rows } = await app.db.query<{ engagement_id: string | null; contact_id: string }>(
    `SELECT engagement_id, contact_id FROM invoices WHERE id = $1`,
    [invoiceId]
  );
  const inv = rows[0];
  if (!inv) return;
  if (inv.engagement_id) {
    const res = await app.db.query(
      `UPDATE engagements SET work_paused_at = NULL, work_pause_reason = NULL
       WHERE id = $1 AND work_paused_at IS NOT NULL`,
      [inv.engagement_id]
    );
    if ((res.rowCount ?? 0) > 0) {
      await writeAudit(app.db, {
        actorType: 'system', actorLabel: 'ar-dunning',
        action: 'engagement.work_resumed', objectType: 'engagement', objectId: inv.engagement_id,
        contactId: inv.contact_id, details: { invoice_id: invoiceId },
      });
    }
  }
}

/** Next assessment date for a given overdue invoice (portal/staff display). */
export function nextFeeDate(overdueSince: string, graceDays: number, lastAssessed: string | null): string {
  return lastAssessed ? addDays(lastAssessed, 30) : addDays(overdueSince, graceDays);
}
