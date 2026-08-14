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

  useEffect(() => {
    const load = async () => {
      const r = await api<{ invoices: Invoice[] }>('/portal/invoices');
      setInvoices(r.invoices);
      setLoaded(true);
      return r.invoices;
    };

    void (async () => {
      const list = await load();

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
      // The list is newest-first and the invoice just paid is effectively always the
      // newest, so a handful covers it. Bounded because a client with twenty open
      // invoices should not fire twenty Stripe lookups on a page load; the every-tick
      // sweep picks up anything this misses.
      const unpaid = list.filter((i) => i.status !== 'paid').slice(0, 5);
      try {
        const results = await Promise.all(
          unpaid.map((i) =>
            api<{ status: string }>(`/portal/invoices/${i.id}/reconcile`, { method: 'POST' })
              .catch(() => ({ status: 'error' }))
          )
        );
        const settled = results.some((r) => r.status === 'paid' || r.status === 'already_paid');
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
          {invoices.map((i) => (
            <li key={i.id}>
              <span className="grow">
                <strong>{i.invoice_number}</strong> · {formatMoney(i.total_cents)}
                <br />
                <span className="muted small">{i.lines.map((l) => l.description).join(' · ')}</span>
              </span>
              {i.status === 'paid' ? (
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
