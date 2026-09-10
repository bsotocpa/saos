/*
 * WHAT ACTUALLY HAPPENED TO THE CLIENT MESSAGE (2026-09-09, Brian's ruling).
 *
 * The void flash said "The client has been told." The notice was a row in the outbox; the
 * email left forty-one seconds later. A post-action notice that involves a send states the
 * ACTUAL state, from the record, in one of two words: queued (an outbox row exists and has
 * not delivered) or delivered (the send log says so, with the time). Anything else — a
 * failed attempt, a skipped send, no record at all — is named as that, never rounded up.
 *
 * The send log IS the outbox (intent, attempts, delivery time) plus the audit rows each
 * sender writes when the mail actually left. This module reads both and never invents a
 * third state.
 */

import type { FastifyInstance } from 'fastify';

export type NoticeKind = 'invoice_send' | 'void_notice' | 'refund_receipt' | 'payment_receipt' | 'pay_link';

export interface NoticeState {
  kind: NoticeKind;
  /** queued: intent recorded, not delivered. delivered: the send log confirms it. */
  state: 'queued' | 'delivered' | 'failed' | 'skipped';
  /** When it was delivered (or last attempted). ISO. */
  at: string | null;
  /** The outbox row, when the send went through the outbox. */
  outboxId: string | null;
  /** The audit row that records the actual send. */
  auditId: string | null;
  /** Why it is not delivered, when it is not. */
  detail: string | null;
}

const KIND_BY_EFFECT: Record<string, NoticeKind> = {
  'invoice.send': 'invoice_send',
  'invoice.void_notice': 'void_notice',
  'invoice.refund_receipt': 'refund_receipt',
};

const AUDIT_BY_KIND: Record<NoticeKind, string> = {
  invoice_send: 'invoice.sent',
  void_notice: 'invoice.void_notice_sent',
  refund_receipt: 'invoice.refund_receipt_sent',
  payment_receipt: 'invoice.payment_receipt_sent',
  pay_link: 'invoice.pay_link_sent',
};

/** Item 9 (2026-09-09): the audit a gated send writes when its automation is OFF — the hold, on the log. */
const SUPPRESSED_BY_KIND: Partial<Record<NoticeKind, string>> = {
  void_notice: 'invoice.void_notice_suppressed',
  refund_receipt: 'invoice.refund_receipt_suppressed',
  payment_receipt: 'invoice.payment_receipt_suppressed',
};

export const NOTICE_LABEL: Record<NoticeKind, string> = {
  invoice_send: 'Invoice email',
  void_notice: 'Cancellation notice',
  refund_receipt: 'Refund receipt',
  payment_receipt: 'Payment receipt',
  pay_link: 'Pay link',
};

/** One line a person reads: "Cancellation notice queued" / "Refund receipt delivered 09:08". */
export function describeNotice(n: NoticeState, fmtTime: (iso: string) => string = (iso) => iso): string {
  const label = NOTICE_LABEL[n.kind];
  switch (n.state) {
    case 'delivered':
      return `${label} delivered${n.at ? ` ${fmtTime(n.at)}` : ''}`;
    case 'queued':
      return `${label} queued${n.detail ? ` — ${n.detail}` : ''}`;
    case 'failed':
      return `${label} FAILED${n.detail ? ` — ${n.detail}` : ''}`;
    case 'skipped':
      return `${label} not sent${n.detail ? ` — ${n.detail}` : ''}`;
  }
}

/**
 * Every client-facing notice about these invoices, with its real state. Keyed by invoice id;
 * an invoice with no notices has an empty list (a paid invoice from before receipts were
 * audited shows nothing rather than a guess).
 */
export async function noticesForInvoices(
  app: FastifyInstance,
  invoiceIds: string[]
): Promise<Record<string, NoticeState[]>> {
  const out: Record<string, NoticeState[]> = {};
  for (const id of invoiceIds) out[id] = [];
  if (invoiceIds.length === 0) return out;

  // Outbox rows: on the invoice itself, or on one of its refunds.
  const outbox = await app.db.query<{
    id: string; effect: string; status: string; last_error: string | null; attempts: number;
    created_at: Date; sent_at: Date | null; invoice_id: string;
  }>(
    `SELECT o.id, o.effect, o.status::text AS status, o.last_error, o.attempts, o.created_at, o.sent_at,
            COALESCE(r.invoice_id, o.object_id) AS invoice_id
       FROM outbox o
       LEFT JOIN invoice_refunds r ON o.object_type = 'invoice_refund' AND r.id = o.object_id
      WHERE (o.object_type = 'invoice' AND o.object_id = ANY($1::uuid[]))
         OR (o.object_type = 'invoice_refund' AND r.invoice_id = ANY($1::uuid[]))
      ORDER BY o.created_at`,
    [invoiceIds]
  );
  // Audit rows: the senders' own record that the mail left.
  const audits = await app.db.query<{ id: string; action: string; object_id: string; occurred_at: Date }>(
    `SELECT id::text AS id, action, object_id, occurred_at FROM audit_log
      WHERE object_type = 'invoice' AND object_id = ANY($1::text[])
        AND action = ANY($2::text[])
      ORDER BY occurred_at`,
    [invoiceIds, [...Object.values(AUDIT_BY_KIND), ...Object.values(SUPPRESSED_BY_KIND)]]
  );
  const auditFor = (invoiceId: string, kind: NoticeKind) =>
    audits.rows.find((a) => a.object_id === invoiceId && a.action === AUDIT_BY_KIND[kind]) ?? null;

  for (const row of outbox.rows) {
    const kind = KIND_BY_EFFECT[row.effect];
    if (!kind) continue;
    const audit = auditFor(row.invoice_id, kind);
    let state: NoticeState['state'];
    let detail: string | null = null;
    if (row.status === 'sent' && row.last_error?.startsWith('skipped:')) {
      state = 'skipped';
      detail = row.last_error.replace(/^skipped:\s*/, '');
    } else if (row.status === 'sent') {
      state = 'delivered';
    } else if (row.status === 'abandoned') {
      state = 'failed';
      detail = row.last_error;
    } else {
      state = 'queued';
      detail = row.attempts > 0 && row.last_error ? `retrying: ${row.last_error}` : null;
    }
    out[row.invoice_id]?.push({
      kind,
      state,
      at: (audit?.occurred_at ?? row.sent_at)?.toISOString() ?? null,
      outboxId: row.id,
      auditId: audit?.id ?? null,
      detail,
    });
  }

  // Inline sends (no outbox row): the payment receipt, and the pay link a person sent (item 14).
  // Delivered iff the audit row exists.
  for (const a of audits.rows) {
    if (a.action === AUDIT_BY_KIND.payment_receipt) {
      out[a.object_id]?.push({ kind: 'payment_receipt', state: 'delivered', at: a.occurred_at.toISOString(), outboxId: null, auditId: a.id, detail: null });
    } else if (a.action === AUDIT_BY_KIND.pay_link) {
      out[a.object_id]?.push({ kind: 'pay_link', state: 'delivered', at: a.occurred_at.toISOString(), outboxId: null, auditId: a.id, detail: null });
    }
  }
  // Held sends (item 9): the automation was off, and the hold is on the log where the send would be.
  // The outbox-carried kinds already show "not sent — held" through their outbox row; the
  // inline payment receipt has only this audit row to speak for it.
  for (const a of audits.rows) {
    if (a.action !== SUPPRESSED_BY_KIND.payment_receipt) continue;
    out[a.object_id]?.push({ kind: 'payment_receipt', state: 'skipped', at: a.occurred_at.toISOString(), outboxId: null, auditId: a.id, detail: 'held — the automation is off (Admin → Automations)' });
  }
  return out;
}

/** The send log for one invoice, row by row — what the "view send log" link opens. */
export async function sendLogForInvoice(
  app: FastifyInstance,
  invoiceId: string
): Promise<Array<{ source: 'outbox' | 'audit'; id: string; what: string; state: string; at: string; detail: string | null }>> {
  const notices = (await noticesForInvoices(app, [invoiceId]))[invoiceId] ?? [];
  const rows: Array<{ source: 'outbox' | 'audit'; id: string; what: string; state: string; at: string; detail: string | null }> = [];
  const outbox = await app.db.query<{ id: string; effect: string; status: string; created_at: Date; sent_at: Date | null; last_error: string | null; attempts: number }>(
    `SELECT o.id, o.effect, o.status::text AS status, o.created_at, o.sent_at, o.last_error, o.attempts
       FROM outbox o LEFT JOIN invoice_refunds r ON o.object_type = 'invoice_refund' AND r.id = o.object_id
      WHERE (o.object_type = 'invoice' AND o.object_id = $1) OR (o.object_type = 'invoice_refund' AND r.invoice_id = $1)
      ORDER BY o.created_at`,
    [invoiceId]
  );
  for (const o of outbox.rows) {
    rows.push({ source: 'outbox', id: o.id, what: `${o.effect} (attempt ${o.attempts})`, state: o.status, at: o.created_at.toISOString(), detail: o.last_error });
  }
  const audits = await app.db.query<{ id: string; action: string; occurred_at: Date; actor_label: string | null }>(
    `SELECT id::text AS id, action, occurred_at, actor_label FROM audit_log
      WHERE object_type = 'invoice' AND object_id = $1 AND action = ANY($2::text[]) ORDER BY occurred_at`,
    [invoiceId, Object.values(AUDIT_BY_KIND)]
  );
  for (const a of audits.rows) {
    rows.push({ source: 'audit', id: a.id, what: a.action, state: 'delivered', at: a.occurred_at.toISOString(), detail: a.actor_label });
  }
  rows.sort((x, y) => x.at.localeCompare(y.at));
  void notices;
  return rows;
}
