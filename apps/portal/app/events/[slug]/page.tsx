'use client';

// Public Hilo workshop page (M27) — the Eventbrite replacement, client side.
//
// PUBLIC by necessity: a workshop page has to work for someone who has never
// heard of Hilo and has no account. Bilingual because Hilo's audience is majority
// Spanish-speaking — the toggle in the header switches everything, including the
// copy that comes from the event record itself.
//
// A full workshop offers the waitlist rather than a dead end, and says where you
// stand in it.

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, ApiError } from '../../../lib/api';
import { useSession } from '../../../lib/session';

interface EventPage {
  event: {
    slug: string;
    title_en: string;
    title_es: string;
    description_en: string;
    description_es: string;
    location: string | null;
    is_virtual: boolean;
    starts_at: string;
    ends_at: string | null;
    capacity: number;
    confirmed: number;
    waitlisted: number;
  };
  seatsLeft: number;
  full: boolean;
  cancelled: boolean;
}

export default function EventPublicPage() {
  const { t, lang } = useSession();
  const params = useParams<{ slug: string }>();
  const [data, setData] = useState<EventPage | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'invalid'>('loading');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [done, setDone] = useState<{ status: string; position: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api<EventPage>(`/public/events/${params.slug}`));
      setState('ready');
    } catch {
      setState('invalid');
    }
  }, [params.slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ status: string; position: number | null }>(
        `/public/events/${params.slug}/register`,
        {
          method: 'POST',
          body: {
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            email: email.trim(),
            ...(phone.trim() ? { phone: phone.trim() } : {}),
            language: lang,
            smsOptIn,
          },
        }
      );
      setDone(r);
      await load();
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
        <h1>{t('event_not_found_title')}</h1>
        <p>{t('event_not_found_body')}</p>
      </section>
    );
  }

  const e = data!.event;
  const es = lang === 'es';
  const title = es ? e.title_es : e.title_en;
  const description = es ? e.description_es : e.description_en;
  const when = e.starts_at.slice(0, 16).replace('T', ' ');

  if (done) {
    return (
      <section className="card">
        <h1>{done.status === 'confirmed' ? t('event_confirmed_title') : t('event_waitlisted_title')}</h1>
        <p>
          {done.status === 'confirmed'
            ? t('event_confirmed_body')
            : `${t('event_waitlisted_body')} (${done.position})`}
        </p>
        <p className="muted small">{title} · {when}</p>
      </section>
    );
  }

  return (
    <>
      <h1>{title}</h1>
      <p className="muted small">
        {when}
        {e.location ? ` · ${e.location}` : ''}
        {e.is_virtual ? ` · ${t('event_virtual')}` : ''}
      </p>

      {data!.cancelled ? <div className="alert error">{t('event_cancelled')}</div> : null}

      <section className="card">
        <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{description}</p>
      </section>

      <section className="card">
        <h2>{t('event_register')}</h2>
        {data!.full ? (
          <div className="alert warn">{t('event_full')}</div>
        ) : (
          <p className="muted small">
            {t('event_seats_left')}: <strong>{data!.seatsLeft}</strong>
          </p>
        )}
        {error ? <div className="alert error">{error}</div> : null}

        <div className="grid2">
          <label className="field">
            {t('event_first_name')}
            <input value={firstName} onChange={(ev) => setFirstName(ev.target.value)} />
          </label>
          <label className="field">
            {t('event_last_name')}
            <input value={lastName} onChange={(ev) => setLastName(ev.target.value)} />
          </label>
        </div>
        <label className="field">
          {t('event_email')}
          <input type="email" inputMode="email" value={email} onChange={(ev) => setEmail(ev.target.value)} />
        </label>
        <label className="field">
          {t('event_phone')}
          <input type="tel" inputMode="tel" value={phone} onChange={(ev) => setPhone(ev.target.value)} />
        </label>
        {/* TCPA: a workshop signup is not consent to be texted about anything
            else, so the reminder opt-in is its own unticked box. */}
        <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontWeight: 400 }}>
          <input
            type="checkbox"
            className="tickbox"
            checked={smsOptIn}
            onChange={(ev) => setSmsOptIn(ev.target.checked)}
            disabled={phone.trim().length < 7}
          />
          <span>{t('event_sms_optin')}</span>
        </label>

        <button
          type="button"
          className="btn accent block"
          disabled={
            busy || data!.cancelled ||
            firstName.trim().length === 0 || lastName.trim().length === 0 || !email.includes('@')
          }
          onClick={() => void submit()}
        >
          {data!.full ? t('event_join_waitlist') : t('event_register')}
        </button>
      </section>
    </>
  );
}
