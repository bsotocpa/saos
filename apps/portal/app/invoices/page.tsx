'use client';

// Invoices & Payments (MP): history, line detail, Pay Now via Stripe Checkout.

import { useEffect, useState } from 'react';
import { api, formatMoney } from '../../lib/api';
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

  useEffect(() => {
    void api<{ invoices: Invoice[] }>('/portal/invoices').then((r) => {
      setInvoices(r.invoices);
      setLoaded(true);
    });
  }, []);

  const pay = async (id: string) => {
    const res = await api<{ url: string }>(`/portal/invoices/${id}/checkout`, { method: 'POST' });
    window.location.href = res.url;
  };

  return (
    <>
      <h1>{t('inv_title')}</h1>
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
                  <button type="button" className="btn accent" onClick={() => void pay(i.id)}>
                    {t('inv_pay')}
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
