'use client';

// The client-facing proposal (M27). PUBLIC by design — the emailed token is the
// credential, so a prospect can read and accept a proposal before they have a
// portal account. That is the whole point: the first thing we ask of someone is
// not "create a login."
//
// Every price on this page was copied from the price book when the quote was
// built, so what the client sees is what the engagement will charge.

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, ApiError, formatMoney } from '../../../lib/api';
import { useSession } from '../../../lib/session';

interface Line {
  item_code: string;
  // Both frozen at build time, so flipping the language toggle relabels the
  // lines without re-pricing anything.
  description_en: string;
  description_es: string;
  quantity: string;
  unit_cents: number | null;
  line_cents: number | null;
  min_cents: number | null;
  max_cents: number | null;
  is_optional: boolean;
  chosen: boolean;
  is_pass_through: boolean;
}

/**
 * The deposit the client will be asked for, resolved server-side from the lines' price-book
 * deposits (v4: per line, summed) and any override. Shown BEFORE acceptance.
 *
 * 2026-09-09. Walking the builder end to end: the builder now showed the deposit, the API
 * returned it, and this page rendered nothing — the client read "Nothing is charged until you
 * accept", accepted, and only THEN learned a deposit invoice was on its way. The builder's
 * new copy promised the client would see the same figure on the proposal; this makes that true.
 */
interface Deposit {
  standardCents: number | null;
  dueCents: number | null;
  treatment: 'standard' | 'reduced' | 'waived' | null;
  waived: boolean;
  reduced: boolean;
}

interface Quote {
  id: string;
  status: string;
  language: 'en' | 'es';
  subtotal_cents: number;
  discount_cents: number;
  total_cents: number;
  range_min_cents: number | null;
  range_max_cents: number | null;
  expires_at: string | null;
  expired: boolean;
  notes: string | null;
  first_name: string;
}

export default function QuotePage() {
  const { t, lang, setLang } = useSession();
  const params = useParams<{ token: string }>();
  const token = params.token;

  const [quote, setQuote] = useState<Quote | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [deposit, setDeposit] = useState<Deposit | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [state, setState] = useState<'loading' | 'ready' | 'accepted' | 'declined' | 'invalid'>('loading');
  const [hasDeposit, setHasDeposit] = useState(false);
  const [showDecline, setShowDecline] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api<{ quote: Quote; lines: Line[]; deposit: Deposit }>(`/public/quote/${token}`);
      setQuote(r.quote);
      setLines(r.lines);
      setDeposit(r.deposit);
      // Meet the client in the language the quote was written in.
      if (r.quote.language !== lang) setLang(r.quote.language);
      if (r.quote.status === 'accepted') setState('accepted');
      else if (r.quote.status === 'declined') setState('declined');
      else setState('ready');
    } catch {
      setState('invalid');
    }
    // setLang/lang deliberately omitted: this runs once per token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const chosenOptional = lines.filter((l) => l.is_optional && picked[l.item_code]);
  const optionalCents = chosenOptional.reduce((sum, l) => sum + (l.line_cents ?? 0), 0);
  const runningTotal = (quote?.total_cents ?? 0) + optionalCents;

  // A range quote stays a range when the client ticks an add-on. The band is
  // whatever the server applied (max ÷ min) — reading it back off the quote
  // keeps the figure honest without duplicating the setting here.
  const rangeFor = (cents: number): [number, number] | null => {
    if (quote?.range_min_cents == null || quote.range_max_cents == null || quote.range_min_cents === 0) return null;
    return [cents, Math.round(cents * (quote.range_max_cents / quote.range_min_cents))];
  };

  const accept = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ depositInvoiceId: string | null }>(`/public/quote/${token}/accept`, {
        method: 'POST',
        body: { chooseOptional: chosenOptional.map((l) => l.item_code) },
      });
      setHasDeposit(Boolean(r.depositInvoiceId));
      setState('accepted');
    } catch (err) {
      /*
       * #48 — "already accepted" is not a failure from this chair.
       *
       * Acceptance now claims the quote in one statement before doing any work, so a
       * double-tap has a loser and the loser gets a 409. The acceptance still HAPPENED —
       * showing the client an error for something that succeeded would be the system
       * reporting its own race back to them as their mistake.
       */
      if (err instanceof ApiError && err.code === 'already_accepted') {
        setState('accepted');
        setBusy(false);
        return;
      }
      if (err instanceof ApiError && err.code === 'expired') {
        setQuote((q) => (q ? { ...q, expired: true } : q));
      }
      setError(err instanceof ApiError ? err.message : t('error_generic'));
    } finally {
      setBusy(false);
    }
  };

  const decline = async () => {
    if (reason.trim().length === 0) return;
    setBusy(true);
    setError('');
    try {
      await api(`/public/quote/${token}/decline`, { method: 'POST', body: { reason: reason.trim() } });
      setState('declined');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error_generic'));
    } finally {
      setBusy(false);
    }
  };

  if (state === 'loading') return <p className="muted">{t('loading')}</p>;

  if (state === 'invalid') {
    return (
      <section className="card">
        <h1>{t('quote_title')}</h1>
        <p>{t('quote_invalid')}</p>
      </section>
    );
  }

  if (state === 'accepted') {
    return (
      <section className="card">
        <h1>{t('quote_accepted_title')}</h1>
        <p>{t('quote_accepted_body')}</p>
        {hasDeposit ? <p className="muted">{t('quote_accepted_deposit')}</p> : null}
      </section>
    );
  }

  if (state === 'declined') {
    return (
      <section className="card">
        <h1>{t('quote_declined_title')}</h1>
        <p>{t('quote_declined_body')}</p>
      </section>
    );
  }

  if (quote?.expired) {
    return (
      <section className="card">
        <h1>{t('quote_expired_title')}</h1>
        <p>{t('quote_expired_body')}</p>
      </section>
    );
  }

  const included = lines.filter((l) => !l.is_optional);
  const optional = lines.filter((l) => l.is_optional);
  const label = (l: Line) => (lang === 'es' ? l.description_es : l.description_en);
  const isRange = quote?.range_min_cents !== null && quote?.range_max_cents !== null;

  return (
    <>
      <h1>{t('quote_title')}</h1>
      <p className="muted">{t('quote_intro')}</p>
      {error ? <div className="alert error">{error}</div> : null}

      <section className="card">
        <h2>{t('quote_included')}</h2>
        <ul className="quote-lines">
          {included.map((l) => (
            <li key={l.item_code}>
              <span className="quote-desc">
                {label(l)}
                {Number(l.quantity) > 1 ? ` × ${Number(l.quantity)}` : ''}
                {l.is_pass_through ? (
                  <>
                    <br />
                    <span className="muted small">{t('quote_passthrough')}</span>
                  </>
                ) : null}
              </span>
              <span className="quote-amount">
                {l.line_cents !== null
                  ? formatMoney(l.line_cents)
                  : l.min_cents !== null && l.max_cents !== null
                    ? `${formatMoney(l.min_cents)}–${formatMoney(l.max_cents)}`
                    : '—'}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {optional.length > 0 ? (
        <section className="card">
          <h2>{t('quote_optional')}</h2>
          <p className="muted small">{t('quote_optional_hint')}</p>
          <ul className="quote-lines">
            {optional.map((l) => (
              <li key={l.item_code}>
                <label className="quote-desc" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <input
                    type="checkbox"
                    checked={Boolean(picked[l.item_code])}
                    onChange={(e) => setPicked((p) => ({ ...p, [l.item_code]: e.target.checked }))}
                  />
                  <span>{label(l)}</span>
                </label>
                <span className="quote-amount">
                  {l.line_cents !== null ? formatMoney(l.line_cents) : '—'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="card">
        <ul className="quote-lines">
          {quote!.discount_cents > 0 ? (
            <>
              <li>
                <span className="quote-desc">{t('quote_subtotal')}</span>
                <span className="quote-amount">{formatMoney(quote!.subtotal_cents)}</span>
              </li>
              <li>
                <span className="quote-desc">{t('quote_discount')}</span>
                <span className="quote-amount">−{formatMoney(quote!.discount_cents)}</span>
              </li>
            </>
          ) : null}
          <li className="quote-total">
            <span className="quote-desc">
              <strong>{t('quote_total')}</strong>
            </span>
            <span className="quote-amount">
              <strong>
                {(() => {
                  const band = rangeFor(runningTotal);
                  return band ? `${formatMoney(band[0])}–${formatMoney(band[1])}` : formatMoney(runningTotal);
                })()}
              </strong>
            </span>
          </li>
          {deposit && deposit.standardCents !== null ? (
            <li>
              <span className="quote-desc">
                {t('quote_deposit')}
                <br />
                <span className="muted small">{t('quote_deposit_note')}</span>
              </span>
              <span className="quote-amount">
                {deposit.waived ? (
                  <>
                    <s className="muted">{formatMoney(deposit.standardCents)}</s> {t('quote_deposit_waived')}
                  </>
                ) : deposit.reduced && deposit.dueCents !== null ? (
                  <>
                    {formatMoney(deposit.dueCents)}
                    <br />
                    <span className="muted small">
                      {t('quote_deposit_reduced_from')} {formatMoney(deposit.standardCents)}
                    </span>
                  </>
                ) : (
                  formatMoney(deposit.dueCents ?? deposit.standardCents)
                )}
              </span>
            </li>
          ) : null}
        </ul>
        {isRange ? <p className="muted small">{t('quote_estimate_note')}</p> : null}
        {quote!.expires_at ? (
          <p className="muted small">
            {t('quote_expires')} {quote!.expires_at.slice(0, 10)}
          </p>
        ) : null}
        {quote!.notes ? <p className="small">{quote!.notes}</p> : null}
      </section>

      <div className="quote-actions">
        <button type="button" className="btn accent" disabled={busy} onClick={() => void accept()}>
          {t('quote_accept')}
        </button>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => setShowDecline((s) => !s)}>
          {t('quote_decline')}
        </button>
      </div>

      {showDecline ? (
        <section className="card">
          <p>{t('quote_decline_prompt')}</p>
          <label className="field">
            <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button
            type="button"
            className="btn"
            disabled={busy || reason.trim().length === 0}
            onClick={() => void decline()}
          >
            {t('quote_decline_send')}
          </button>
        </section>
      ) : null}
    </>
  );
}
