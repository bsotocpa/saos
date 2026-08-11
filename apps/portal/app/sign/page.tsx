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
import { api, ApiError } from '../../lib/api';
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

interface PresentedPacket {
  packetId: string;
  html: string;
  documentSha256: string;
  scheduleCodes: string[];
  sections: Array<{ kind: string; code: string | null; title: string }>;
  alreadySigned: boolean;
  affirmations: { intent: string; esignConsent: string };
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

  // The engagement packet: read it, then sign it here.
  const [packet, setPacket] = useState<PresentedPacket | null>(null);
  const [signedName, setSignedName] = useState('');
  const [intentOk, setIntentOk] = useState(false);
  const [esignOk, setEsignOk] = useState(false);
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [staleDocument, setStaleDocument] = useState(false);
  const [justSigned, setJustSigned] = useState(false);

  const load = async () => {
    const [env, sch, con] = await Promise.all([
      api<{ envelopes: Envelope[] }>('/portal/signature-envelopes'),
      api<{ pending: PendingSchedule[] }>('/portal/schedules'),
      api<{ offers: ConsentOffer[] }>('/portal/consents'),
    ]);
    setEnvelopes(env.envelopes);
    setSchedules(sch.pending);
    setOffers(con.offers);
    // 404 here just means there is no packet waiting — not an error worth showing.
    try {
      setPacket(await api<PresentedPacket>(`/portal/packet?language=${lang}`));
    } catch {
      setPacket(null);
    }
    setLoaded(true);
  };

  const signPacket = async () => {
    if (!packet) return;
    setSignError(null);
    if (signedName.trim().length < 2) {
      setSignError(t('packet_name_required'));
      return;
    }
    if (!intentOk || !esignOk) {
      setSignError(t('packet_affirm_required'));
      return;
    }
    setSigning(true);
    try {
      await api('/portal/packet/sign', {
        method: 'POST',
        body: {
          signedName: signedName.trim(),
          intentAffirmed: intentOk,
          esignConsentAck: esignOk,
          documentSha256: packet.documentSha256,
          language: lang,
        },
      });
      setJustSigned(true);
      // Reload: this is what makes the §7216 consent offer appear, and it appears
      // only now — after the signature, separately, and optionally.
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'document_changed') {
        setStaleDocument(true);
      } else {
        setSignError(err instanceof ApiError ? err.message : t('error_generic'));
      }
    } finally {
      setSigning(false);
    }
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

      {/* THE ENGAGEMENT PACKET — the first thing a new client does. */}
      {packet && !packet.alreadySigned ? (
        <section className="card" style={{ borderColor: 'var(--electric)' }}>
          <h2>{t('packet_title')}</h2>
          <p className="muted">{t('packet_intro')}</p>
          {lang === 'es' ? <p className="muted small">{t('consent_en_only')}</p> : null}

          <p className="small">
            <strong>{t('packet_includes')}:</strong>{' '}
            {packet.sections.map((s) => s.title).join(' · ')}
          </p>

          {/*
            The document itself, scrollable so the page stays usable on a phone.
            dangerouslySetInnerHTML is safe here for a specific reason, not by
            assumption: buildPacketDocument is the only producer of this string, and
            it escapes EVERY interpolated value — template bodies, titles, template
            keys, the client's name — before wrapping them in its own markup. Admin
            copy is admin-editable, so if someone pasted a <script> into a template
            body it renders as visible text rather than executing. The markup is
            entirely the generator's.
          */}
          <div
            style={{
              maxHeight: 380, overflowY: 'auto', fontSize: 13, lineHeight: 1.55,
              padding: 12, border: '1px solid var(--line)', borderRadius: 8,
              background: 'var(--paper, #fff)',
            }}
            dangerouslySetInnerHTML={{ __html: packet.html }}
          />

          {staleDocument ? (
            <>
              <p className="alert error" style={{ marginTop: 12 }}>{t('packet_changed')}</p>
              <p>
                <button className="btn accent" type="button" onClick={() => window.location.reload()}>
                  {t('packet_reload')}
                </button>
              </p>
            </>
          ) : (
            <div style={{ marginTop: 16 }}>
              <label className="field" style={{ display: 'block' }}>
                <input
                  type="checkbox"
                  checked={intentOk}
                  onChange={(e) => setIntentOk(e.target.checked)}
                />{' '}
                <span className="small">{packet.affirmations.intent}</span>
              </label>
              <label className="field" style={{ display: 'block' }}>
                <input
                  type="checkbox"
                  checked={esignOk}
                  onChange={(e) => setEsignOk(e.target.checked)}
                />{' '}
                <span className="small">{packet.affirmations.esignConsent}</span>
              </label>
              <label className="field">
                {t('packet_name_label')}
                <input
                  value={signedName}
                  onChange={(e) => setSignedName(e.target.value)}
                  autoComplete="name"
                  style={{ fontSize: 18 }}
                />
              </label>
              {signError ? <p className="alert error">{signError}</p> : null}
              <p>
                <button className="btn accent" type="button" disabled={signing} onClick={() => void signPacket()}>
                  {signing ? t('packet_signing') : t('packet_sign_button')}
                </button>
              </p>
            </div>
          )}
        </section>
      ) : null}

      {justSigned || packet?.alreadySigned ? (
        <section className="card">
          <h2>{t('packet_signed_title')}</h2>
          <p>{t('packet_signed_body')}</p>
        </section>
      ) : null}

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
