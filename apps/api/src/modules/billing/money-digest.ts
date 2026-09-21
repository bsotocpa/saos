/*
 * THE MONEY DIGEST (2026-09-12, Brian's ruling 10, shipped with Rene's billing.manage grant).
 *
 * Rene holds full billing.manage: void, refund resync, deposit transfer, deposit restamp, and
 * whatever write-off arrives later. Nothing here blocks or delays any of it. This is DETECTION:
 * every money action performed by a member of staff other than the CEO is listed to the CEO
 * once a day — amount, client, invoice, actor, reason, time — and the same day's actions sit
 * on the executive view the moment they happen.
 *
 * The record is audit_log. That is deliberate: the digest reads the same rows every money
 * action already writes, so a new money path is in the digest the day it audits itself, and a
 * money path that does not audit itself is the defect, not a gap in this file.
 *
 * THE ACTOR CLASSES (2026-09-19, Brian's item 5). Every money action row is one of three:
 *   ceo    — actor_id is an active CEO. Not reported to himself.
 *   staff  — a human member of staff (actor_type staff, with an id) who is not the CEO.
 *            "By staff" counts this class ONLY.
 *   system — everything else: actor_type system, or no actor id. Stripe's webhook is here.
 * A webhook refund that SAOS initiated — a person recorded the refund id on the invoice
 * before Stripe's event arrived — is attributed to that person: the initiator's own row is the
 * money action, and the webhook's row is folded into it, so it is counted once. A webhook
 * refund with no initiator is money that moved OUTSIDE THE DOOR: counted and listed on its
 * own line, never inside "by staff".
 */
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.ts';
import { allActiveByRoles, notifyOnce } from '../../staffing.ts';
import { formatUsd } from './service.ts';

/** Every audit action that moves or unmakes money. Add here when a new one is born. */
export const MONEY_ACTIONS = [
  'invoice.voided',
  'invoice.refunded',
  // A person in SAOS recording Stripe's refunds onto the invoice: the SAOS-initiated refund.
  'invoice.refunds_resynced',
  /*
   * THE REFUND DOOR (R29, 2026-09-20): a member of staff created the refund in Ops, and Stripe
   * moved the money because SAOS asked. Class staff when a staff member presses it, neither line
   * when the CEO does — the ordinary classes, no special case.
   *
   * There is deliberately no entry here for `invoice.refund_reconciled`, the webhook's audit row
   * when Stripe confirms a refund this door already made. That row is Stripe agreeing with us, not
   * money moving: counting it would put the same dollars on the line twice, once as the person's
   * action and once as "outside the door".
   */
  'invoice.refund_issued',
  'invoice.deposit_transferred',
  'engagement.deposit_transferred',
  'engagement.deposit_restamped',
  'invoice.written_off',
  'tax_engagement.final_fee_outside_quote', // a final fee set outside the quoted range, with its reason (2026-09-19, item 2)
  // A quote whose lines were priced off the book — an edited amount or a custom line — with the
  // one reason for the whole quote and each changed line listed (2026-09-20). Staff class when a
  // member of staff built it, neither line when the CEO did: the ordinary classes.
  'quote.prices_changed',
] as const;

export type MoneyActorClass = 'ceo' | 'staff' | 'system';

export interface MoneyActionRow {
  at: string;
  action: string;
  actor: string;
  actorId: string | null;
  actorClass: MoneyActorClass;
  client: string | null;
  contactId: string | null;
  invoiceNumber: string | null;
  amountCents: number | null;
  reason: string | null;
}

/** The two lines the CEO reads. Class 'ceo' rows are in neither. */
export interface MoneyLine {
  /** Class 'staff' only: human staff who are not the CEO. */
  byStaff: MoneyActionRow[];
  /** Stripe webhook refunds with no SAOS initiator: money that moved outside the door. */
  outsideTheDoor: MoneyActionRow[];
}

const LABEL: Record<string, string> = {
  'invoice.voided': 'Void',
  'invoice.refunded': 'Refund',
  'invoice.refunds_resynced': 'Refund',
  'invoice.refund_issued': 'Refund',
  'invoice.deposit_transferred': 'Deposit moved',
  'engagement.deposit_transferred': 'Deposit moved',
  'engagement.deposit_restamped': 'Deposit restamped',
  'invoice.written_off': 'Write-off',
  'tax_engagement.final_fee_outside_quote': 'Final fee outside the quoted range',
  'quote.prices_changed': 'Quote priced off the book',
};

/**
 * Every money action in [from, to), classified, with SAOS-initiated webhook refunds folded
 * into their initiators' rows. The CEO is recognised by staff id, not by label, so a renamed
 * account cannot slip past.
 *
 * THE MATCHING RULE. A webhook `invoice.refunded` row is SAOS-initiated when every Stripe
 * refund id it carries was already on invoice_refunds before its event (the row's
 * stripe_event_id is not this event's), and the row was put there by a staff
 * `invoice.refunds_resynced` audit row in the same transaction — same invoice, and the audit
 * row's occurred_at equals the refund row's created_at, because now() is fixed for the life of
 * a transaction. That staff row is the initiator and is already a money action of its own.
 */
export async function moneyActionsBetween(app: FastifyInstance, from: Date, to: Date): Promise<MoneyActionRow[]> {
  const { rows } = await app.db.query<{
    occurred_at: Date; action: string; actor_label: string | null; actor_id: string | null;
    actor_class: MoneyActorClass;
    contact_id: string | null; first_name: string | null; last_name: string | null;
    invoice_number: string | null; details: Record<string, unknown>;
  }>(
    `SELECT a.occurred_at, a.action, a.actor_label, a.actor_id, a.contact_id,
            c.first_name, c.last_name,
            COALESCE(a.details->>'invoice_number', i.invoice_number) AS invoice_number,
            a.details,
            CASE WHEN a.actor_id IN (SELECT st.id FROM staff st JOIN roles r ON r.id = st.role_id
                                      WHERE r.key = 'ceo' AND st.is_active) THEN 'ceo'
                 WHEN a.actor_type = 'staff' AND a.actor_id IS NOT NULL THEN 'staff'
                 ELSE 'system' END AS actor_class
       FROM audit_log a
       LEFT JOIN contacts c ON c.id = a.contact_id
       LEFT JOIN invoices i ON a.object_type = 'invoice' AND i.id::text = a.object_id
      WHERE a.action = ANY($1::text[])
        AND a.occurred_at >= $2 AND a.occurred_at < $3
        -- A re-sync that recorded nothing moved nothing.
        AND (a.action <> 'invoice.refunds_resynced' OR COALESCE((a.details->>'recorded')::int, 0) > 0)
        -- A webhook refund SAOS initiated is folded into the initiator's row (see the matching rule).
        AND NOT (
          a.action = 'invoice.refunded' AND a.actor_type = 'system'
          AND jsonb_typeof(a.details->'refund_ids') = 'array'
          AND jsonb_array_length(a.details->'refund_ids') > 0
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(a.details->'refund_ids') AS rid
             WHERE NOT EXISTS (
               SELECT 1 FROM invoice_refunds r
                 JOIN audit_log init ON init.object_type = 'invoice' AND init.object_id = r.invoice_id::text
                                    AND init.action = 'invoice.refunds_resynced' AND init.actor_type = 'staff'
                                    AND init.occurred_at = r.created_at
                WHERE r.invoice_id::text = a.object_id
                  AND r.stripe_refund_id = rid
                  AND r.stripe_event_id IS DISTINCT FROM a.details->>'stripe_event_id')))
      ORDER BY a.occurred_at`,
    [[...MONEY_ACTIONS], from, to]
  );
  return rows.map((r) => {
    const d = r.details ?? {};
    const cents = [d['amount_cents'], d['total_cents'], d['refund_cents'], d['amount_refunded_cents'], d['transferred_cents'], d['cents']]
      .find((v) => typeof v === 'number') as number | undefined;
    const reason = [d['reason'], d['void_reason'], d['note']].find((v) => typeof v === 'string') as string | undefined;
    return {
      at: r.occurred_at.toISOString(),
      action: LABEL[r.action] ?? r.action,
      actor: r.actor_label ?? 'unknown actor',
      actorId: r.actor_id,
      actorClass: r.actor_class,
      client: r.first_name ? `${r.first_name} ${r.last_name ?? ''}`.trim() : null,
      contactId: r.contact_id,
      invoiceNumber: r.invoice_number,
      amountCents: cents ?? null,
      reason: reason ?? null,
    };
  });
}

/** The money line for [from, to): by human staff, and outside the door. */
export async function moneyLineBetween(app: FastifyInstance, from: Date, to: Date): Promise<MoneyLine> {
  const all = await moneyActionsBetween(app, from, to);
  return {
    byStaff: all.filter((a) => a.actorClass === 'staff'),
    // Only the webhook's own refund rows reach here as 'system': every SAOS-initiated one was folded.
    outsideTheDoor: all.filter((a) => a.actorClass === 'system' && a.action === 'Refund'),
  };
}

/** The executive view's same-day line: since local midnight, Chicago. */
export async function moneyLineToday(app: FastifyInstance, today: string): Promise<MoneyLine> {
  const { rows } = await app.db.query<{ from: Date; to: Date }>(
    `SELECT ($1::date::timestamp AT TIME ZONE 'America/Chicago') AS "from",
            (($1::date + 1)::timestamp AT TIME ZONE 'America/Chicago') AS "to"`,
    [today]
  );
  return moneyLineBetween(app, rows[0]!.from, rows[0]!.to);
}

/**
 * The daily job: yesterday's money actions by staff (class 'staff' only), to every active CEO
 * as one notification. Idempotent per run_date through the audit record, like the other daily
 * jobs. An empty day still writes the run record and sends nothing — silence is a count, not a
 * gap. Outside-the-door refunds are counted in the run record; they are not "by staff".
 */
export async function runMoneyDigestJob(
  app: FastifyInstance,
  today: string
): Promise<{ actions: number; outsideTheDoor: number; notified: number; skipped: boolean }> {
  const ran = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'job.money_digest' AND details->>'run_date' = $1 LIMIT 1`, [today]);
  if (ran.rows.length) return { actions: 0, outsideTheDoor: 0, notified: 0, skipped: true };

  const { rows: win } = await app.db.query<{ from: Date; to: Date }>(
    `SELECT (($1::date - 1)::timestamp AT TIME ZONE 'America/Chicago') AS "from",
            ($1::date::timestamp AT TIME ZONE 'America/Chicago') AS "to"`,
    [today]
  );
  const { byStaff: actions, outsideTheDoor } = await moneyLineBetween(app, win[0]!.from, win[0]!.to);
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
    details: { run_date: today, actions: actions.length, outside_the_door: outsideTheDoor.length, notified },
  });
  return { actions: actions.length, outsideTheDoor: outsideTheDoor.length, notified, skipped: false };
}
