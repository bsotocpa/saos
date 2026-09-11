// How an invoice's state reads on the Ops client page (2026-09-09, Brian's ruling).
//
// The badge reads the SAME status column the portal reads. Void rows say why, who and when;
// refunded rows say how much and when; a partial refund says how much of what. Pure, so it
// is tested directly — the page has no render harness.

export interface InvoiceForDisplay {
  invoice_number: string;
  status: string;
  total_cents: number;
  amount_paid_cents: number;
  amount_refunded_cents?: number | null;
  void_reason?: string | null;
  voided_by?: string | null;
  voided_at?: string | null;
  refunded_at?: string | null;
}

export type BadgeTone = 'ok' | 'warn' | 'danger' | '';

export function badgeToneFor(status: string): BadgeTone {
  switch (status) {
    case 'paid':
      return 'ok';
    case 'overdue':
    case 'disputed':
      return 'danger';
    case 'refunded':
    case 'partially_refunded':
      return 'warn';
    default:
      return '';
  }
}

/**
 * The line under the number: "void · <reason> · <actor> · <date>",
 * "refunded · <amount> · <date>", "partially refunded <amount> of <paid> · <date>", or the status
 * alone. `money` and `date` are injected so the page's own formatters (Chicago time, USD) are
 * the ones used.
 */
export function invoiceStatusLine(
  inv: InvoiceForDisplay,
  fmt: { money: (cents: number) => string; date: (iso: string) => string }
): string {
  const refunded = inv.amount_refunded_cents ?? 0;
  switch (inv.status) {
    case 'void':
      // No money record reads "unknown" (2026-09-10). Pre-2026-09-10 rows that genuinely have
      // no actor recorded say where to look instead of shrugging.
      return ['void', inv.void_reason ?? '(no reason recorded)', inv.voided_by ?? 'actor not recorded — see the audit log', inv.voided_at ? fmt.date(inv.voided_at) : '(date unknown)']
        .join(' · ');
    case 'refunded':
      return ['refunded', fmt.money(refunded), inv.refunded_at ? fmt.date(inv.refunded_at) : '(date unknown)'].join(' · ');
    case 'partially_refunded':
      return [`partially refunded ${fmt.money(refunded)} of ${fmt.money(inv.amount_paid_cents)}`, inv.refunded_at ? fmt.date(inv.refunded_at) : '(date unknown)'].join(' · ');
    default:
      return inv.status;
  }
}
