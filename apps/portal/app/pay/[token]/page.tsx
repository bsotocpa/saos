'use client';

// THE PAY PAGE (2026-09-09). PUBLIC by design — the emailed token is the credential, scoped
// to one invoice, and Stripe Checkout is the authentication. A client who has just accepted
// a quote has no portal account yet, and must not need one to pay.
//
// The page knows the invoice number and the amount. A dead token (paid, void, expired,
// revoked, or simply wrong) gets a plain sentence and no invoice data.

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, ApiError, formatMoney } from '../../../lib/api';
import { useSession } from '../../../lib/session';
import { formatDate } from '../../../lib/dates';

type View =
  | { state: 'payable'; invoiceNumber: string; amountCents: number; dueDate: string | null; language: 'en' | 'es' }
  | { state: 'paid'; invoiceNumber: string; language: 'en' | 'es' }
  | { state: 'unavailable' };

export default function PayPage() {
  const { t, lang, setLang } = useSession();
  const params = useParams<{ token: string }>();
  const token = params.token;

  const [view, setView] = useState<View | null>(null);
  const [notice, setNotice] = useState<'confirming' | 'pending' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const v = await api<View>(`/public/pay/${token}`);
      if (v.state !== 'unavailable' && v.language !== lang) setLang(v.language);
      setView(v);
      return v;
    } catch {
      setView({ state: 'unavailable' });
      return { state: 'unavailable' } as View;
    }
    // lang/setLang omitted on purpose: runs once per token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    void (async () => {
      const v = await load();
      const paidReturn = new URLSearchParams(window.location.search).get('paid') === '1';
      if (!paidReturn || v.state === 'paid' || v.state === 'unavailable') return;
      // Back from Stripe: ASK, rather than wait to be told (the webhook usually wins the
      // race, in which case the first load already read 'paid').
      setNotice('confirming');
      try {
        const r = await api<{ status: string }>(`/public/pay/${token}/reconcile`, { method: 'POST' });
        if (r.status === 'paid' || r.status === 'already_paid') {
          setNotice(null);
          await load();
        } else {
          setNotice('pending');
        }
      } catch {
        setNotice('pending');
      }
      window.history.replaceState({}, '', window.location.pathname);
    })();
  }, [load, token]);

  const pay = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ url: string }>(`/public/pay/${token}/checkout`, { method: 'POST' });
      window.location.href = r.url;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error_generic'));
      setBusy(false);
    }
  };

  if (view === null) return <p className="muted">{t('loading')}</p>;

  if (view.state === 'unavailable') {
    return (
      <section className="card">
        <h1>{t('pay_unavailable_title')}</h1>
        <p>{t('pay_unavailable_body')}</p>
      </section>
    );
  }

  if (view.state === 'paid') {
    return (
      <section className="card">
        <h1>{t('pay_paid_title')}</h1>
        <p>
          {t('pay_invoice')} {view.invoiceNumber}
        </p>
        <p className="muted">{t('pay_paid_body')}</p>
      </section>
    );
  }

  return (
    <>
      <h1>{t('pay_title')}</h1>
      {notice === 'confirming' ? <p className="alert info" role="status" aria-live="polite">{t('pay_confirming')}</p> : null}
      {notice === 'pending' ? <p className="alert info" role="status" aria-live="polite">{t('pay_pending')}</p> : null}
      {error ? <div className="alert error">{error}</div> : null}
      <section className="card">
        <ul className="quote-lines">
          <li>
            <span className="quote-desc">
              {t('pay_invoice')} <strong>{view.invoiceNumber}</strong>
              {view.dueDate ? (
                <>
                  <br />
                  <span className="muted small">
                    {t('pay_due')} {formatDate(view.dueDate, lang)}
                  </span>
                </>
              ) : null}
            </span>
            <span className="quote-amount">
              <strong>{formatMoney(view.amountCents)}</strong>
            </span>
          </li>
        </ul>
        <p className="muted small">{t('pay_secure')}</p>
      </section>
      <div className="quote-actions">
        <button type="button" className="btn accent" disabled={busy} onClick={() => void pay()}>
          {t('pay_button')}
        </button>
      </div>
    </>
  );
}
