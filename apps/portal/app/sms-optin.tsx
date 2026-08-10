'use client';

// SMS opt-in card, shown in the portal welcome flow (Brian's addition,
// 2026-08-09). The migrated book carries ZERO SMS consent, so without a backfill
// path every text nudge stays permanently suppressed for existing clients.
//
// TCPA shape, deliberately:
//  · the checkbox starts UNTICKED and the button is disabled until it is ticked —
//    express affirmative consent, never consent-by-default
//  · the disclosure is above the control, not behind a link
//  · declining is a first-class button, not the absence of a choice, and it says
//    what the client still gets
//  · turning it back off is available in the same place, without texting STOP

import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';

export function SmsOptIn({
  smsConsent,
  phone,
  onChange,
}: {
  smsConsent: boolean;
  phone: string | null;
  onChange: () => void;
}) {
  const { t } = useSession();
  const [agreed, setAgreed] = useState(false);
  const [number, setNumber] = useState(phone ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dismissed, setDismissed] = useState(false);

  const submit = async (consent: boolean) => {
    setBusy(true);
    setError('');
    try {
      await api('/portal/sms-consent', {
        method: 'POST',
        body: consent ? { consent: true, phone: number.trim() } : { consent: false },
      });
      onChange();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'phone_required') setError(t('sms_optin_phone_required'));
      else setError(err instanceof ApiError ? err.message : t('error_generic'));
    } finally {
      setBusy(false);
    }
  };

  if (smsConsent) {
    return (
      <section className="card">
        <h2>{t('sms_optin_title')}</h2>
        <p className="small">
          <strong>{t('sms_optin_on')}</strong>
          {phone ? ` · ${phone}` : ''}
        </p>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => void submit(false)}>
          {t('sms_optin_turn_off')}
        </button>
      </section>
    );
  }

  if (dismissed) {
    return (
      <section className="card">
        <h2>{t('sms_optin_title')}</h2>
        <p className="muted small">{t('sms_optin_off_note')}</p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>{t('sms_optin_title')}</h2>
      <p className="small">{t('sms_optin_body')}</p>
      <p className="muted small">{t('sms_optin_disclosure')}</p>
      {error ? <div className="alert error">{error}</div> : null}
      <label className="field">
        {t('sms_optin_phone')}
        <input
          type="tel"
          inputMode="tel"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="(312) 555-0100"
        />
      </label>
      <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontWeight: 400 }}>
        <input
          type="checkbox"
          className="tickbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
        />
        <span>{t('sms_optin_agree')}</span>
      </label>
      <div className="quote-actions">
        <button
          type="button"
          className="btn accent"
          disabled={busy || !agreed || number.trim().length < 7}
          onClick={() => void submit(true)}
        >
          {t('sms_optin_agree')}
        </button>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => setDismissed(true)}>
          {t('sms_optin_skip')}
        </button>
      </div>
    </section>
  );
}
