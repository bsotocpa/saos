/*
 * THE MONEY DIGEST (2026-09-12, Brian's ruling 10, shipped with Rene's billing.manage grant).
 *
 * Rene holds full billing.manage: void, refund resync, deposit transfer, deposit restamp, and
 * whatever write-off arrives later. Nothing here blocks or delays any of it. This is DETECTION:
 * every money action performed by anyone other than the CEO is listed to the CEO once a day —
 * amount, client, invoice, actor, reason, time — and the same day's actions sit on the
 * executive view the moment they happen.
 *
 * The record is audit_log. That is deliberate: the digest reads the same rows every money
 * action already writes, so a new money path is in the digest the day it audits itself, and a
 * money path that does not audit itself is the defect, not a gap in this file.
 */
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { allActiveByRoles, notifyOnce } from '../../staffing.ts';
import { formatUsd } from './service.ts';

/** Every audit action that moves or unmakes money. Add here when a new one is born. */
export const MONEY_ACTIONS = [
  'invoice.voided',
  'invoice.refunded',
  'invoice.deposit_transferred',
  'engagement.deposit_transferred',
  'engagement.deposit_restamped',
  'invoice.written_off',
] as const;

export interface MoneyActionRow {
  at: string;
  action: string;
  actor: string;
  actorId: string | null;
  client: string | null;
  contactId: string | null;
  invoiceNumber: string | null;
  amountCents: number | null;
  reason: string | null;
}

const LABEL: Record<string, string> = {
  'invoice.voided': 'Void',
  'invoice.refunded': 'Refund',
  'invoice.deposit_transferred': 'Deposit moved',
  'engagement.deposit_transferred': 'Deposit moved',
  'engagement.deposit_restamped': 'Deposit restamped',
  'invoice.written_off': 'Write-off',
};

/**
 * Money actions in [from, to) by anyone who is not an active CEO. The CEO's own actions are
 * excluded by staff id, not by label, so a renamed account cannot slip past.
 */
export async function moneyActionsBetween(app: FastifyInstance, from: Date, to: Date): Promise<MoneyActionRow[]> {
  const { rows } = await app.db.query<{
    occurred_at: Date; action: string; actor_label: string | null; actor_id: string | null;
    contact_id: string | null; first_name: string | null; last_name: string | null;
    invoice_number: string | null; details: Record<string, unknown>;
  }>(
    `SELECT a.occurred_at, a.action, a.actor_label, a.actor_id, a.contact_id,
            c.first_name, c.last_name,
            COALESCE(a.details->>'invoice_number', i.invoice_number) AS invoice_number,
            a.details
       FROM audit_log a
       LEFT JOIN contacts c ON c.id = a.contact_id
       LEFT JOIN invoices i ON a.object_type = 'invoice' AND i.id::text = a.object_id
      WHERE a.action = ANY($1::text[])
        AND a.occurred_at >= $2 AND a.occurred_at < $3
        AND (a.actor_id IS NULL OR a.actor_id NOT IN (
              SELECT st.id FROM staff st JOIN roles r ON r.id = st.role_id WHERE r.key = 'ceo' AND st.is_active))
      ORDER BY a.occurred_at`,
    [[...MONEY_ACTIONS], from, to]
  );
  return rows.map((r) => {
    const d = r.details ?? {};
    const cents = [d['amount_cents'], d['total_cents'], d['refund_cents'], d['transferred_cents'], d['cents']]
      .find((v) => typeof v === 'number') as number | undefined;
    const reason = [d['reason'], d['void_reason'], d['note']].find((v) => typeof v === 'string') as string | undefined;
    return {
      at: r.occurred_at.toISOString(),
      action: LABEL[r.action] ?? r.action,
      actor: r.actor_label ?? 'unknown actor',
      actorId: r.actor_id,
      client: r.first_name ? `${r.first_name} ${r.last_name ?? ''}`.trim() : null,
      contactId: r.contact_id,
      invoiceNumber: r.invoice_number,
      amountCents: cents ?? null,
      reason: reason ?? null,
    };
  });
}

/** The executive view's same-day line: since local midnight, Chicago. */
export async function moneyActionsToday(app: FastifyInstance, today: string): Promise<MoneyActionRow[]> {
  const { rows } = await app.db.query<{ from: Date; to: Date }>(
    `SELECT ($1::date::timestamp AT TIME ZONE 'America/Chicago') AS "from",
            (($1::date + 1)::timestamp AT TIME ZONE 'America/Chicago') AS "to"`,
    [today]
  );
  return moneyActionsBetween(app, rows[0]!.from, rows[0]!.to);
}

/**
 * The daily job: yesterday's money actions by anyone but the CEO, to every active CEO as one
 * notification. Idempotent per run_date through the audit record, like the other daily jobs.
 * An empty day still writes the run record and sends nothing — silence is a count, not a gap.
 */
export async function runMoneyDigestJob(app: FastifyInstance, today: string): Promise<{ actions: number; notified: number; skipped: boolean }> {
  const ran = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'job.money_digest' AND details->>'run_date' = $1 LIMIT 1`, [today]);
  if (ran.rows.length) return { actions: 0, notified: 0, skipped: true };

  const { rows: win } = await app.db.query<{ from: Date; to: Date }>(
    `SELECT (($1::date - 1)::timestamp AT TIME ZONE 'America/Chicago') AS "from",
            ($1::date::timestamp AT TIME ZONE 'America/Chicago') AS "to"`,
    [today]
  );
  const actions = await moneyActionsBetween(app, win[0]!.from, win[0]!.to);
  let notified = 0;
  if (actions.length > 0) {
    const ceos = await allActiveByRoles(app.db, ['ceo']);
    const lines = actions.map((a) => {
      const when = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).format(new Date(a.at));
      return `${when}  ${a.action}  ${a.amountCents !== null ? formatUsd(a.amountCents) : '—'}  ${a.client ?? '—'}  ${a.invoiceNumber ?? '—'}  by ${a.actor}${a.reason ? `  — ${a.reason}` : ''}`;
    });
    for (const ceo of ceos) {
      const wrote = await notifyOnce(app.db, {
        staffId: ceo,
        type: `money_digest_${today}`,
        severity: 'warning',
        title: `Money actions yesterday by staff other than you: ${actions.length}`,
        body: lines.join('\n'),
      });
      if (wrote) notified++;
    }
  }
  await writeAudit(app.db, {
    actorType: 'system', actorLabel: 'money-digest',
    action: 'job.money_digest', objectType: 'job', objectId: 'money_digest',
    details: { run_date: today, actions: actions.length, notified },
  });
  return { actions: actions.length, notified, skipped: false };
}
