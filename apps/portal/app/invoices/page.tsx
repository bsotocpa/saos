'use client';

// Invoices & Payments (MP): history, line detail, Pay Now via Stripe Checkout.

import { useEffect, useState } from 'react';
import { api, ApiError, formatMoney } from '../../lib/api';
import { useSession } from '../../lib/session';

interface Line { description: string; qty: string; totalCents: number }
interface Invoice {
  id: string; invoice_number: string; status: string; total_cents: number;
  paid_at: string | null; lines: Line[];
}

export default function InvoicesPage() {
  const { t } = useSession();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loaded, setLoaded] = useState(false);
  // FINDING #22: Pay now was `void pay(id)` with no error handling and no busy state,
  // so a 503 produced NOTHING — Brian reported the button as "dead". A payment control
  // that fails invisibly is worse than one that errors.
  const [payingId, setPayingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // FINDING #23/#24: Stripe returns the client to ?paid=1 and the page ignored it.
  const [paidNotice, setPaidNotice] = useState<'confirming' | 'paid' | 'pending' | null>(null);
  /*
   * The invoice the email pointed at (?invoice=<id>).
   *
   * invoice_sent used to link to the portal HOME, so a client told "your invoice is
   * ready" landed on a dashboard and had to go find it. Naming it here lets the page
   * put that one first and mark it, which is what the email is promising.
   */
  const [focusInvoiceId, setFocusInvoiceId] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const r = await api<{ invoices: Invoice[] }>('/portal/invoices');
      setInvoices(r.invoices);
      setLoaded(true);
      return r.invoices;
    };

    void (async () => {
      const list = await load();

      // Read before the ?paid=1 branch clears the query string below.
      const focus = new URLSearchParams(window.location.search).get('invoice');
      if (focus) setFocusInvoiceId(focus);

      /*
       * FINDINGS #23 + #24 — the return from Stripe.
       *
       * Stripe sends the client back to ?paid=1. The page used to ignore that entirely:
       * Brian paid a deposit and landed on a screen still showing the invoice as Open, with
       * no acknowledgement of any kind. Worse, the webhook that would have settled it
       * had vanished, so waiting would never have fixed it.
       *
       * So on return we ASK Stripe through the API rather than waiting to be told. The
       * client gets a real answer in the moment, and a lost webhook costs a round trip
       * instead of leaving them marked unpaid.
       */
      const params = new URLSearchParams(window.location.search);
      if (params.get('paid') !== '1') return;
      setPaidNotice('confirming');
      /*
       * 2026-09-09. The return from Stripe now names the invoice (?invoice=<id>), so ask
       * about THAT one. The old way — reconcile every open invoice and hope — put a "no
       * confirmation yet" banner over an invoice that already said Paid: the webhook had
       * settled it before the client landed (the healthy case), so it was not in the
       * "open" list at all, and the only open invoice left carried a stale session that
       * 404'd. One precise question, and "already paid" is the good answer.
       *
       * Older links without the id fall back to the bounded guess.
       */
      const isSettled = (status: string) => status === 'paid' || status === 'already_paid';
      const ask = (id: string) =>
        api<{ status: string }>(`/portal/invoices/${id}/reconcile`, { method: 'POST' })
          .catch(() => ({ status: 'error' }));
      try {
        let settled = false;
        if (focus && list.some((i) => i.id === focus)) {
          settled = isSettled((await ask(focus)).status);
        } else {
          const unpaid = list.filter((i) => i.status !== 'paid').slice(0, 5);
          const results = await Promise.all(unpaid.map((i) => ask(i.id)));
          settled = results.some((r) => isSettled(r.status));
        }
        setPaidNotice(settled ? 'paid' : 'pending');
        if (settled) await load();
      } catch {
        setPaidNotice('pending');
      }
      // Clear the flag so a refresh does not re-run the confirmation.
      window.history.replaceState({}, '', window.location.pathname);
    })();
  }, []);

  const pay = async (id: string) => {
    setError(null);
    setPayingId(id);
    try {
      const res = await api<{ url: string }>(`/portal/invoices/${id}/checkout`, { method: 'POST' });
      window.location.href = res.url;
    } catch (err) {
      // Say what happened. The server's message is written for a client to read.
      setError(err instanceof ApiError ? err.message : t('error_generic'));
      setPayingId(null);
    }
  };

  return (
    <>
      <h1>{t('inv_title')}</h1>
      {paidNotice ? (
        <p className="alert info" role="status" aria-live="polite">
          {paidNotice === 'confirming' ? t('inv_confirming') : null}
          {paidNotice === 'paid' ? t('inv_paid_notice') : null}
          {paidNotice === 'pending' ? t('inv_paid_pending') : null}
        </p>
      ) : null}
      {error ? (
        <p className="alert error" role="alert">
          {error}
        </p>
      ) : null}
      <section className="card">
        {loaded && invoices.length === 0 ? <p className="muted">{t('inv_empty')}</p> : null}
        <ul className="list">
          {/*
            The invoice the email named comes first. Sorting rather than filtering: the
            client may have others, and hiding them to honour a link would be a worse
            surprise than reordering them.
          */}
          {[...invoices]
            // The one from the email first; void sorts last (Cancelled, no pay action).
            .sort((a, b) =>
              Number(b.id === focusInvoiceId) - Number(a.id === focusInvoiceId) ||
              Number(a.status === 'void') - Number(b.status === 'void'))
            .map((i) => (
            <li
              key={i.id}
              {...(i.id === focusInvoiceId
                ? { style: { borderLeft: '3px solid var(--electric)', paddingLeft: 10 } }
                : {})}
            >
              <span className="grow">
                <strong>{i.invoice_number}</strong> · {formatMoney(i.total_cents)}
                {i.id === focusInvoiceId ? (
                  <span className="badge" style={{ marginLeft: 6 }}>{t('inv_from_email')}</span>
                ) : null}
                <br />
                <span className="muted small">{i.lines.map((l) => l.description).join(' · ')}</span>
              </span>
              {i.status === 'refunded' || i.status === 'partially_refunded' || i.status === 'disputed' || i.status === 'void' ? (
                <span className="badge">
                  {t(i.status === 'refunded' ? 'inv_refunded' : i.status === 'partially_refunded' ? 'inv_partially_refunded' : i.status === 'void' ? 'inv_void' : 'inv_disputed')}
                </span>
              ) : i.status === 'paid' ? (
                <span className="badge ok">{t('inv_paid')}</span>
              ) : (
                <>
                  <span className={`badge ${i.status === 'overdue' ? 'danger' : 'warn'}`}>
                    {t(i.status === 'overdue' ? 'inv_overdue' : 'inv_open')}
                  </span>
                  <button
                    type="button"
                    className="btn accent"
                    disabled={payingId !== null}
                    onClick={() => void pay(i.id)}
                  >
                    {payingId === i.id ? t('inv_paying') : t('inv_pay')}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
