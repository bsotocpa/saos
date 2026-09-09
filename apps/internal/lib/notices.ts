// What actually happened to a client message (2026-09-09, Brian's ruling). Mirrors the API's
// billing/notices.ts: two words, queued or delivered, from the record — never "the client
// has been told" over an outbox row.

export type NoticeKind = 'invoice_send' | 'void_notice' | 'refund_receipt' | 'payment_receipt';

export interface NoticeState {
  kind: NoticeKind;
  state: 'queued' | 'delivered' | 'failed' | 'skipped';
  at: string | null;
  outboxId: string | null;
  auditId: string | null;
  detail: string | null;
}

export const NOTICE_LABEL: Record<NoticeKind, string> = {
  invoice_send: 'Invoice email',
  void_notice: 'Cancellation notice',
  refund_receipt: 'Refund receipt',
  payment_receipt: 'Payment receipt',
};

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
