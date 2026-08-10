'use client';

// Sign Documents (MP): the Master Engagement Agreement, §7216 consents, 8879s.
// Docuseal emails the signing link when an envelope goes out; statuses live here.
//
// Legal package v3 added two client actions that are NOT signatures:
//  · A Service Schedule for a service added after signing — accepted here, per
//    Master §1, without re-executing the Master.
//  · The two §7216 consents, presented on v3's terms and framed as what they
//    are: optional permissions that change nothing if declined.

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import type { DictKey } from '../../lib/i18n';

interface Envelope {
  id: string;
  type: string;
  status: string;
  sent_at: string | null;
  completed_at: string | null;
}

interface PendingSchedule {
  schedule_code: string;
  title: string;
  body_en: string;
}

interface ConsentOffer {
  kind: '7216_use' | '7216_disclose';
  headlineEn: string;
  bodyEn: string;
}

function statusKey(status: string): DictKey {
  if (status === 'completed') return 'env_status_completed';
  if (status === 'sent' || status === 'viewed') return 'env_status_sent';
  if (status.startsWith('kba')) return 'env_status_kba';
  return 'env_status_draft';
}

export default function SignPage() {
  const { t, lang } = useSession();
  const [envelopes, setEnvelopes] = useState<Envelope[]>([]);
  const [schedules, setSchedules] = useState<PendingSchedule[]>([]);
  const [offers, setOffers] = useState<ConsentOffer[]>([]);
  const [answered, setAnswered] = useState<Record<string, 'yes' | 'no'>>({});
  const [accepted, setAccepted] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = async () => {
    const [env, sch, con] = await Promise.all([
      api<{ envelopes: Envelope[] }>('/portal/signature-envelopes'),
      api<{ pending: PendingSchedule[] }>('/portal/schedules'),
      api<{ offers: ConsentOffer[] }>('/portal/consents'),
    ]);
    setEnvelopes(env.envelopes);
    setSchedules(sch.pending);
    setOffers(con.offers);
    setLoaded(true);
  };
  useEffect(() => {
    void load();
  }, []);

  const acceptSchedule = async (code: string) => {
    await api(`/portal/schedules/${code}/accept`, { method: 'POST' });
    setAccepted((prev) => [...prev, code]);
    setSchedules((prev) => prev.filter((s) => s.schedule_code !== code));
  };

  const answerConsent = async (kind: ConsentOffer['kind'], granted: boolean) => {
    await api('/portal/consents', { method: 'POST', body: { kind, granted } });
    setAnswered((prev) => ({ ...prev, [kind]: granted ? 'yes' : 'no' }));
    setOffers((prev) => prev.filter((o) => o.kind !== kind));
  };

  return (
    <>
      <h1>{t('sign_title')}</h1>
      <p className="muted">{t('sign_intro')}</p>

      <section className="card">
        {loaded && envelopes.length === 0 ? <p className="muted">{t('sign_empty')}</p> : null}
        <ul className="list">
          {envelopes.map((e) => (
            <li key={e.id}>
              <span className="grow">{t(`env_${e.type}` as DictKey)}</span>
              <span className={`badge ${e.status === 'completed' ? 'ok' : e.status === 'draft' ? '' : 'warn'}`}>
                {t(statusKey(e.status))}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* A service added after signing: its schedule, not a new signature. */}
      {schedules.length > 0 ? (
        <section className="card">
          <h2>{t('schedules_title')}</h2>
          <p className="muted">{t('schedules_intro')}</p>
          {lang === 'es' ? <p className="muted small">{t('consent_en_only')}</p> : null}
          {schedules.map((s) => (
            <div key={s.schedule_code} style={{ marginTop: 16 }}>
              {/* The title already reads "Schedule D — …", so no badge repeating the letter. */}
              <h3>{s.title}</h3>
              <div
                style={{
                  maxHeight: 260, overflowY: 'auto', whiteSpace: 'pre-wrap',
                  fontSize: 13, lineHeight: 1.5, padding: 12,
                  border: '1px solid var(--line)', borderRadius: 8,
                }}
              >
                {s.body_en}
              </div>
              <p>
                <button className="btn accent" type="button" onClick={() => void acceptSchedule(s.schedule_code)}>
                  {t('schedules_accept')}
                </button>
              </p>
            </div>
          ))}
        </section>
      ) : null}

      {accepted.length > 0 ? (
        <p className="alert ok">
          {t('schedules_accepted')}: {accepted.join(', ')}
        </p>
      ) : null}

      {/* §7216 — optional permissions, benefit-framed, never conditioning service. */}
      {offers.length > 0 ? (
        <section className="card">
          <h2>{t('consents_title')}</h2>
          {lang === 'es' ? <p className="muted small">{t('consent_en_only')}</p> : null}
          {offers.map((o) => (
            <div key={o.kind} style={{ marginTop: 16 }}>
              <h3>{o.headlineEn}</h3>
              <p style={{ whiteSpace: 'pre-wrap' }}>{o.bodyEn}</p>
              <p className="muted small">{t('consent_optional')}</p>
              <p>
                <button className="btn accent" type="button" onClick={() => void answerConsent(o.kind, true)}>
                  {t('consent_yes')}
                </button>{' '}
                <button className="btn ghost" type="button" onClick={() => void answerConsent(o.kind, false)}>
                  {t('consent_no')}
                </button>
              </p>
            </div>
          ))}
        </section>
      ) : null}

      {Object.entries(answered).map(([kind, value]) => (
        <p key={kind} className={value === 'yes' ? 'alert ok' : 'alert info'}>
          {t(value === 'yes' ? 'consent_recorded_yes' : 'consent_recorded_no')}
        </p>
      ))}
    </>
  );
}
