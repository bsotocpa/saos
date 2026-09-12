/*
 * THE TRANSACTIONAL OUTBOX (#48).
 *
 * Two rules that between them force this shape:
 *
 *   1. An outward effect must not happen inside a transaction. It cannot be rolled back, and
 *      a transaction holds a pool connection while it runs.
 *   2. An outward effect must not be lost if the process dies after the commit.
 *
 * Doing the send after the commit satisfies (1) and fails (2). Writing a ROW that says "this
 * needs sending", inside the transaction, satisfies both: the intent commits or vanishes with
 * the state that justified it, and a drain performs it afterwards with retries.
 *
 * THE PAYLOAD IS IDs, NEVER A RENDERED MESSAGE. Two reasons, and the second is a hard rule:
 * the drain re-reads the record at send time so a template correction between enqueue and
 * send is picked up, and CLAUDE.md forbids PII outside its own tables — a queue full of
 * rendered client emails would be exactly that.
 */

import type { FastifyInstance } from 'fastify';
import { AppError } from './types.ts';
import { writeAudit } from './audit.ts';
import { ownerForRole, notifyOnce } from './staffing.ts';

/**
 * Every effect the drain knows how to perform.
 *
 * A closed set rather than a callback registry: an effect name that outlives the code that
 * handled it would sit in the table failing forever, and a typo would enqueue a row nothing
 * can ever perform. `assertKnownEffect` refuses at enqueue time, where the caller is still
 * on the stack.
 */
export const OUTBOX_EFFECTS = [
  /** Email the client a deposit or fee invoice with its portal pay link. */
  'invoice.send',
  /** Email the client the link to sign their engagement packet. */
  'packet.send_signature_link',
  /** Email the client that money went back to their card (2026-09-09). */
  'invoice.refund_receipt',
  /** Email the client that an invoice they hold a pay link for no longer exists (2026-09-09). */
  'invoice.void_notice',
  /** Email the client that the IRS or a state accepted their return (2026-09-12). Federal and state are separate rows. */
  'efile.ack_notice',
] as const;
export type OutboxEffect = (typeof OUTBOX_EFFECTS)[number];

/** How many times the drain tries before giving up and asking a person. */
export const MAX_ATTEMPTS = 5;

/**
 * Backoff, in minutes, by attempt number.
 *
 * Front-loaded on purpose: the overwhelming majority of send failures are transient (SES
 * throttling, a DNS blip), and a client waiting on a payment link should not wait an hour
 * because the first try landed during a hiccup. The tail is long enough that a genuine
 * outage does not burn all five attempts in ten minutes.
 */
const BACKOFF_MINUTES = [1, 5, 20, 60];

export interface EnqueueInput {
  effect: OutboxEffect;
  payload: Record<string, unknown>;
  contactId?: string | null;
  objectType?: string | null;
  objectId?: string | null;
}

function assertKnownEffect(effect: string): asserts effect is OutboxEffect {
  if (!(OUTBOX_EFFECTS as readonly string[]).includes(effect)) {
    throw new AppError(
      500,
      'unknown_outbox_effect',
      `'${effect}' is not an outbox effect. Add it to OUTBOX_EFFECTS and give it a handler, ` +
        `or the row would sit in the table failing forever.`
    );
  }
}

/**
 * Record the intent to perform an effect. CALL THIS INSIDE THE TRANSACTION.
 *
 * Outside one it still works and behaves like a plain insert — the drain will pick it up —
 * but the atomicity that is the whole point is gone. There is no way to assert the caller
 * is inside a transaction that would not also fire for legitimate single-statement uses, so
 * this is a convention with a comment rather than a check. The three current callers are all
 * inside `withTransaction`.
 *
 * Idempotent per (effect, object): a unique partial index means a second enqueue for the same
 * pending effect is a no-op rather than a second email. Returns null when it was already
 * queued.
 */
export async function enqueueEffect(
  app: FastifyInstance,
  input: EnqueueInput
): Promise<{ id: string } | null> {
  assertKnownEffect(input.effect);
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO outbox (effect, payload, contact_id, object_type, object_id)
     VALUES ($1, $2::jsonb, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      input.effect,
      JSON.stringify(input.payload),
      input.contactId ?? null,
      input.objectType ?? null,
      input.objectId ?? null,
    ]
  );
  return rows[0] ?? null;
}

/** What a handler reports back. `skip` retires the row without sending and without alarm. */
/*
 * WHAT THE DRAIN LEARNED FROM THE HANDLER (2026-09-10, Brian's ruling).
 *
 * `skip` and `hold` both retire the row without sending and without alarm, and the difference
 * between them is the whole point: a HOLD is a decision Brian made in Admin → Automations and
 * has to be countable as one; a SKIP is the effect no longer being needed. They used to be the
 * same branch, and both wrote status 'sent'.
 */
type HandlerResult =
  | { sent: true }
  | { sent: false; skip: string }
  | { sent: false; hold: string }
  | { sent: false; retry: string };

/**
 * Machine reason code → the sentence a person reads.
 *
 * `last_error` is not only a log field: it goes into the dead-letter task's description, which
 * is a P1 a human opens under time pressure. "no_email" tells them to go and read code;
 * "the client has no email address" tells them what to do.
 */
function humanReason(reason: string | undefined): string {
  switch (reason) {
    case 'no_email':
      return 'the client has no email address on file, so there is nowhere to send it';
    case 'not_sent':
    case undefined:
      return 'the send returned without delivering and gave no reason';
    default:
      return reason;
  }
}

async function performEffect(
  app: FastifyInstance,
  row: { effect: string; payload: Record<string, unknown> }
): Promise<HandlerResult> {
  switch (row.effect) {
    case 'invoice.send': {
      const invoiceId = String(row.payload.invoiceId ?? '');
      if (!invoiceId) return { sent: false, skip: 'no invoiceId in the payload' };
      const { sendInvoiceNow } = await import('./modules/billing/service.ts');
      const result = await sendInvoiceNow(app, invoiceId, { type: 'system', label: 'outbox' });
      if (result.sent) return { sent: true };
      /*
       * `already_sent` retires quietly — someone sent it by hand, which is a resolution, not
       * a failure. `no_email` does NOT: a client with no address who is waiting on a payment
       * link is precisely the case Brian named, and retrying will not conjure an address, so
       * it goes to the dead letter and a person is told.
       */
      if (result.reason === 'already_sent') return { sent: false, skip: 'already sent by hand' };
      return { sent: false, retry: humanReason(result.reason) };
    }
    case 'invoice.refund_receipt': {
      const invoiceId = String(row.payload.invoiceId ?? '');
      const refundId = String(row.payload.refundId ?? '');
      if (!invoiceId || !refundId) return { sent: false, skip: 'no invoiceId/refundId in the payload' };
      const { sendRefundReceipt } = await import('./modules/billing/refunds.ts');
      const result = await sendRefundReceipt(app, invoiceId, refundId);
      if (result.sent) return { sent: true };
      if (result.reason === 'already_sent') return { sent: false, skip: 'receipt already sent' };
      // Item 9 (2026-09-09): a gated send that is OFF retires — it is a decision, not a fault.
      if (result.reason === 'suppressed') return { sent: false, hold: 'held — the automation is off (Admin → Automations)' };
      return { sent: false, retry: humanReason(result.reason) };
    }
    case 'invoice.void_notice': {
      const invoiceId = String(row.payload.invoiceId ?? '');
      if (!invoiceId) return { sent: false, skip: 'no invoiceId in the payload' };
      const { sendVoidNotice } = await import('./modules/billing/void.ts');
      const result = await sendVoidNotice(app, invoiceId);
      if (result.sent) return { sent: true };
      if (result.reason === 'already_sent') return { sent: false, skip: 'void notice already sent' };
      // Item 9 (2026-09-09): a gated send that is OFF retires — it is a decision, not a fault.
      if (result.reason === 'suppressed') return { sent: false, hold: 'held — the automation is off (Admin → Automations)' };
      return { sent: false, retry: humanReason(result.reason) };
    }
    case 'efile.ack_notice': {
      const ackId = String(row.payload.ackId ?? '');
      if (!ackId) return { sent: false, skip: 'no ackId in the payload' };
      const { sendEfileAckNotice } = await import('./modules/tax/efile-ack.ts');
      const result = await sendEfileAckNotice(app, ackId);
      if (result.sent) return { sent: true };
      if (result.reason === 'already_sent') return { sent: false, skip: 'already sent, or held after release' };
      if (result.reason === 'suppressed') return { sent: false, hold: 'held — the automation is off (Admin → Automations)' };
      return { sent: false, retry: humanReason(result.reason) };
    }
    case 'packet.send_signature_link': {
      const packetId = String(row.payload.packetId ?? '');
      if (!packetId) return { sent: false, skip: 'no packetId in the payload' };
      const { deliverPacketSignatureLink } = await import('./modules/engagements/packet.ts');
      const result = await deliverPacketSignatureLink(app, packetId);
      if (result.sent) return { sent: true };
      if (result.reason === 'already_sent') return { sent: false, skip: 'already sent by hand' };
      return { sent: false, retry: result.reason ?? 'not sent' };
    }
    default:
      // Unreachable via enqueueEffect, but a row could predate a handler being removed.
      return { sent: false, retry: `no handler for effect '${row.effect}'` };
  }
}

export interface DrainResult {
  considered: number;
  sent: number;
  retried: number;
  /** Retired because the effect was no longer needed. */
  skipped: number;
  /** Retired because an automation gate held it — a decision, counted as one. */
  suppressed: number;
  abandoned: number;
}

/**
 * Perform every due effect. Runs on the 60-second fast lane (jobs/daily.ts, OUTBOX_SWEEP_MS)
 * AND inside the 15-minute tick — a client waiting on a payment link or a signature should
 * wait about a minute, not until the next tick and not until tomorrow. The tick alone was the
 * whole schedule until 2026-09-09, when an acceptance landed eleven seconds after one.
 *
 * ONE ROW AT A TIME, each claimed with `FOR UPDATE SKIP LOCKED`, so two ticks overlapping (or
 * two API containers, if there is ever a second) cannot both perform the same effect. That is
 * the same lesson as #48's claim: the guard has to be the statement that takes the row, not a
 * read followed by a decision.
 *
 * NOT automation-gated. `isAutomationEnabled()` stands in for the decision to message a
 * client on their own; every row here was enqueued by a decision that already passed its own
 * gate — a staff member accepting a quote, a signature landing, a return being filed. Gating
 * again would silently strand effects whose cause was already approved.
 */
export async function drainOutbox(app: FastifyInstance, limit = 25): Promise<DrainResult> {
  const result: DrainResult = { considered: 0, sent: 0, retried: 0, skipped: 0, suppressed: 0, abandoned: 0 };

  for (let i = 0; i < limit; i++) {
    /*
     * Claim exactly one row. The UPDATE is what claims it: a SELECT then UPDATE would let two
     * drains pick the same row, and SKIP LOCKED means a row another drain is mid-send on is
     * passed over rather than waited for.
     */
    const claimed = await app.db.query<{
      id: string; effect: string; payload: Record<string, unknown>;
      attempts: number; contact_id: string | null; object_type: string | null; object_id: string | null;
    }>(
      /*
       * THE CLAIM IS A LEASE (2026-09-09). Bumping attempts alone left the row 'pending' with
       * next_attempt_at in the past for as long as the handler ran, and the fast lane and the
       * tick overlapped on exactly that window: both claimed the same refund receipt and the
       * client got it twice. Pushing next_attempt_at forward at claim time means a row in
       * flight matches no other drain's WHERE. Success sets 'sent'; failure sets its own
       * backoff; a crash mid-handler surfaces again after the lease, which is a retry, not a
       * loss.
       */
      `UPDATE outbox SET attempts = attempts + 1, next_attempt_at = now() + interval '10 minutes'
        WHERE id = (
          SELECT id FROM outbox
           WHERE status IN ('pending', 'failed') AND next_attempt_at <= now()
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        RETURNING id, effect, payload, attempts, contact_id, object_type, object_id`
    );
    const row = claimed.rows[0];
    if (!row) break;
    result.considered++;

    let outcome: HandlerResult;
    try {
      outcome = await performEffect(app, row);
    } catch (err) {
      outcome = { sent: false, retry: err instanceof Error ? err.message : 'handler threw' };
    }

    if (outcome.sent) {
      await app.db.query(
        `UPDATE outbox SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1`,
        [row.id]
      );
      result.sent++;
      continue;
    }

    if ('hold' in outcome) {
      /*
       * An automation gate held it. NOTHING WAS SENT, so sent_at stays null and the status says
       * suppressed — the row used to read 'sent', which is the one thing that did not happen.
       */
      await app.db.query(
        `UPDATE outbox SET status = 'suppressed', sent_at = NULL, last_error = $2 WHERE id = $1`,
        [row.id, outcome.hold]
      );
      result.suppressed++;
      continue;
    }

    if ('skip' in outcome) {
      // Retired without sending and without alarm — the effect is no longer needed.
      await app.db.query(
        `UPDATE outbox SET status = 'skipped', sent_at = NULL, last_error = $2 WHERE id = $1`,
        [row.id, outcome.skip]
      );
      result.skipped++;
      continue;
    }

    if (row.attempts >= MAX_ATTEMPTS) {
      await app.db.query(
        `UPDATE outbox SET status = 'abandoned', last_error = $2 WHERE id = $1`,
        [row.id, outcome.retry]
      );
      result.abandoned++;
      await raiseDeadLetter(app, row, outcome.retry);
      continue;
    }

    const backoff = BACKOFF_MINUTES[Math.min(row.attempts - 1, BACKOFF_MINUTES.length - 1)] ?? 60;
    await app.db.query(
      `UPDATE outbox
          SET status = 'failed', last_error = $2,
              next_attempt_at = now() + ($3 || ' minutes')::interval
        WHERE id = $1`,
      [row.id, outcome.retry, String(backoff)]
    );
    result.retried++;
    app.log.warn(
      { outboxId: row.id, effect: row.effect, attempt: row.attempts, reason: outcome.retry, retryInMinutes: backoff },
      '#48 outbox effect failed, will retry'
    );
  }

  return result;
}

/**
 * A row that will never be performed — so a person is told, by name, that a client is waiting
 * on something we did not send.
 *
 * Brian's rule: "silent post-commit failure is how a client gets an engagement and never
 * learns it exists." Five attempts over roughly an hour and a half is the system having tried
 * everything it can; what is left is a judgement call.
 */
async function raiseDeadLetter(
  app: FastifyInstance,
  row: { id: string; effect: string; contact_id: string | null; object_type: string | null; object_id: string | null },
  reason: string
): Promise<void> {
  app.log.error(
    { outboxId: row.id, effect: row.effect, contactId: row.contact_id, reason },
    '#48 OUTBOX ABANDONED: a client was not told something, after every retry'
  );
  const { createTask } = await import('./modules/tasks/service.ts');
  const owner = await ownerForRole(app.db, 'comms_billing');
  const who = row.contact_id
    ? (
        await app.db.query<{ name: string }>(
          `SELECT first_name || ' ' || last_name AS name FROM contacts WHERE id = $1`,
          [row.contact_id]
        )
      ).rows[0]?.name ?? 'a client'
    : 'a client';

  const LABEL: Record<string, string> = {
    'invoice.send': 'an invoice with their payment link',
    'packet.send_signature_link': 'the link to sign their engagement packet',
  };
  const what = LABEL[row.effect] ?? row.effect;

  await createTask(app, {
    title: `NOT DELIVERED after ${MAX_ATTEMPTS} attempts: ${who} never received ${what}`,
    description:
      `The system tried ${MAX_ATTEMPTS} times over about 90 minutes and gave up (${reason}). ` +
      `The record itself is fine — only the delivery failed, so nothing needs recreating. ` +
      `Send it by hand from the client record, then check why delivery failed before the next one. ` +
      `Nothing else in the system will chase this.`,
    assignedStaffId: owner,
    contactId: row.contact_id,
    priority: 1,
    source: 'automation',
    sourceType: 'outbox_abandoned',
    sourceId: row.id,
  });
  if (owner) {
    await notifyOnce(app.db, {
      staffId: owner,
      type: 'outbox_abandoned',
      severity: 'critical',
      title: `Delivery failed for good: ${who} — ${what}`,
      contactId: row.contact_id,
      relatedObjectType: 'outbox',
      relatedObjectId: row.id,
    });
  }
  await writeAudit(app.db, {
    actorType: 'system',
    actorLabel: 'outbox',
    action: 'outbox.abandoned',
    objectType: 'outbox',
    objectId: row.id,
    contactId: row.contact_id,
    details: { effect: row.effect, reason, attempts: MAX_ATTEMPTS, of: row.object_type, of_id: row.object_id },
  });
}
