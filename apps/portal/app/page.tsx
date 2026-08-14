'use client';

// Dashboard (MP Soto Portal): the 5-step setup checklist first, engagement status,
// document requests, open invoices, quick actions, estimated payment due, and the
// optional SMS opt-in last. Reordered by Brian after running the journey himself.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, formatMoney, isAuthed } from '../lib/api';
import { useSession } from '../lib/session';
import { SmsOptIn } from './sms-optin';
import type { DictKey } from '../lib/i18n';

interface Onboarding {
  variant: string;
  step_sign_docs_at: string | null;
  step_pay_deposit_at: string | null;
  step_confirm_info_at: string | null;
  step_upload_documents_at: string | null;
  step_track_services_at: string | null;
  completed_at: string | null;
}
interface Engagement { id: string; tax_year: number; return_type: string; stage: string; extension_filed: boolean; deadline: string | null }
interface DocRequest { id: string; title_en: string; title_es: string | null; items: Array<{ id: string; status: string }> }
interface Envelope { id: string; type: string; status: string }
interface Invoice { id: string; invoice_number: string; status: string; total_cents: number }

/*
 * The checklist, reordered by Brian after running the journey himself (2026-08-13).
 *
 * Deposit second, because services do not start before it is paid. "Book your
 * consultation" is gone — a client only reaches this screen after the discovery
 * meeting, so asking them to book one asked for something already done; booking moved
 * to Quick actions as "Schedule a Call/Meeting".
 *
 * `selfCompleting` means the client cannot tick it and is not asked to: Pay deposit
 * completes when the invoice is paid, because the system already knows.
 */
const STEPS = [
  { key: 'step_sign_docs_at', label: 'checklist_sign', href: '/sign', step: 'sign_docs', selfCompleting: false },
  { key: 'step_pay_deposit_at', label: 'checklist_deposit', href: '/invoices', step: null, selfCompleting: true },
  { key: 'step_confirm_info_at', label: 'checklist_confirm', href: '/profile', step: 'confirm_info', selfCompleting: false },
  { key: 'step_upload_documents_at', label: 'checklist_upload', href: '/documents', step: 'upload_documents', selfCompleting: false },
  { key: 'step_track_services_at', label: 'checklist_track', href: '#services', step: 'track_services', selfCompleting: false },
] as const;

export default function Dashboard() {
  const { t, me, nextEstimate, ready, lang, refresh } = useSession();
  const router = useRouter();
  const [onboarding, setOnboarding] = useState<Onboarding | null>(null);
  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [requests, setRequests] = useState<DocRequest[]>([]);
  const [envelopes, setEnvelopes] = useState<Envelope[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [packetToSign, setPacketToSign] = useState(false);
  const [pendingSchedules, setPendingSchedules] = useState(0);
  const [consentOffers, setConsentOffers] = useState(0);
  const [bookingUrl, setBookingUrl] = useState<string | null>(null);
  const [supportUrl, setSupportUrl] = useState<string | null>(null);
  const [irsUrl, setIrsUrl] = useState<string | null>(null);
  const [stateUrl, setStateUrl] = useState<string | null>(null);
  const [depositApplies, setDepositApplies] = useState(false);

  useEffect(() => {
    if (!isAuthed()) {
      router.replace('/login');
      return;
    }
    void Promise.all([
      api<{
        onboarding: Onboarding | null;
        bookingUrl: string | null;
        supportBookingUrl: string | null;
        irsPaymentUrl: string | null;
        statePaymentUrl: string | null;
        depositApplies: boolean;
      }>('/portal/onboarding').then((r) => {
        setOnboarding(r.onboarding);
        setBookingUrl(r.bookingUrl ?? null);
        setSupportUrl(r.supportBookingUrl ?? null);
        setIrsUrl(r.irsPaymentUrl ?? null);
        setStateUrl(r.statePaymentUrl ?? null);
        setDepositApplies(Boolean(r.depositApplies));
      }),
      api<{ engagements: Engagement[] }>('/portal/engagements').then((r) => setEngagements(r.engagements)),
      api<{ requests: DocRequest[] }>('/portal/document-requests').then((r) => setRequests(r.requests)),
      api<{ envelopes: Envelope[] }>('/portal/signature-envelopes').then((r) =>
        setEnvelopes(r.envelopes.filter((e) => e.status !== 'completed'))
      ),
      api<{ invoices: Invoice[] }>('/portal/invoices').then((r) =>
        setInvoices(r.invoices.filter((i) => i.status === 'sent' || i.status === 'overdue'))
      ),
      // "Waiting on you" has to know about the things that ACTUALLY wait on a client
      // now. It was computed from document requests, signature envelopes and invoices
      // only — and portal-native signing does not create envelopes at all, so an
      // unsigned agreement counted as nothing. 404 is the normal "no packet" answer.
      api<{ alreadySigned: boolean }>('/portal/packet')
        .then((r) => setPacketToSign(!r.alreadySigned))
        .catch(() => setPacketToSign(false)),
      api<{ pending: unknown[] }>('/portal/schedules')
        .then((r) => setPendingSchedules((r.pending ?? []).length))
        .catch(() => setPendingSchedules(0)),
      api<{ offers: unknown[] }>('/portal/consents')
        .then((r) => setConsentOffers((r.offers ?? []).length))
        .catch(() => setConsentOffers(0)),
    ]);
  }, [router]);

  const markStep = async (step: string) => {
    await api(`/portal/onboarding/steps/${step}/complete`, { method: 'POST' });
    const r = await api<{ onboarding: Onboarding | null }>('/portal/onboarding');
    setOnboarding(r.onboarding);
  };

  if (!ready) return <p>{t('loading')}</p>;

  const showChecklist = onboarding && !onboarding.completed_at;
  // A client with no deposit owed should not stare at a step they can never complete.
  const visibleSteps = STEPS.filter((s) => s.key !== 'step_pay_deposit_at' || depositApplies);
  const doneCount = onboarding
    ? visibleSteps.filter((s) => onboarding[s.key as keyof Onboarding]).length
    : 0;
  /**
   * "You're all caught up" must not appear ABOVE an unfinished setup checklist —
   * two systems on one screen disagreeing about what is waiting. It was computed
   * from document requests, envelopes and invoices only, and knew nothing about the
   * checklist, an unsigned agreement, a schedule awaiting acceptance, or an open
   * §7216 offer. Portal-native signing makes the envelope check useless on its own,
   * since packets no longer create envelopes.
   */
  const nothingWaiting =
    requests.length === 0 &&
    envelopes.length === 0 &&
    invoices.length === 0 &&
    !showChecklist &&
    !packetToSign &&
    pendingSchedules === 0 &&
    consentOffers === 0;

  return (
    <>
      <h1>
        {t('home_title')}
        {me ? `, ${me.first_name}` : ''}
      </h1>



      {showChecklist ? (
        <section className="card" data-testid="checklist">
          <h2>{t('checklist_title')}</h2>
          <div className="progress">
            <div style={{ width: `${(doneCount / visibleSteps.length) * 100}%` }} />
          </div>
          {visibleSteps.map((s, i) => {
            const done = Boolean(onboarding?.[s.key as keyof Onboarding]);
            return (
              <div className="checklist-step" key={s.step}>
                <span className={`step-dot ${done ? 'done' : ''}`}>{done ? '✓' : i + 1}</span>
                <span className="grow">{t(s.label)}</span>
                {done ? (
                  <span className="badge ok">{t('checklist_done')}</span>
                ) : s.selfCompleting ? (
                  /* Pay deposit completes ITSELF when the invoice is paid. There is no
                     "Mark done": a client cannot honestly tick this, and asking them to
                     confirm something we can already see is how a checklist starts
                     lying. Go takes them to the invoice; the tick follows the money. */
                  <>
                    <a className="btn ghost" href={s.href}>{t('checklist_go')}</a>
                    <span className="muted small">{t('checklist_deposit_waiting')}</span>
                  </>
                ) : (
                  <>
                    <a className="btn ghost" href={s.href}>{t('checklist_go')}</a>
                    {s.step ? (
                      <button className="btn ghost" type="button" onClick={() => void markStep(s.step!)}>
                        {t('checklist_mark_done')}
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            );
          })}
        </section>
      ) : null}

      {engagements.length > 0 ? (
        /* Checklist step 5 ('Track your services') links here — Brian's ruling: the
           existing engagement stages, not a new invented view. */
        <section className="card" id="services">
          <h2>{t('status_title')}</h2>
          <ul className="list">
            {engagements.map((e) => (
              <li key={e.id}>
                <span className="grow">
                  <strong>
                    {e.tax_year} · {e.return_type.toUpperCase()}
                  </strong>
                  <br />
                  <span className="muted small">
                    {t(`stage_${e.stage}` as DictKey)}
                    {e.deadline ? ` · ${t('status_deadline')}: ${e.deadline}` : ''}
                  </span>
                </span>
                {e.extension_filed ? <span className="badge warn">{t('status_extended')}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {nothingWaiting ? <p className="alert info">{t('all_caught_up')}</p> : null}

      <div className="grid2">
        {requests.length > 0 ? (
          <section className="card">
            <h2>{t('requests_title')}</h2>
            <ul className="list">
              {requests.map((r) => (
                <li key={r.id}>
                  <span className="grow">{lang === 'es' ? (r.title_es ?? r.title_en) : r.title_en}</span>
                  <Link className="btn accent" href="/documents">
                    {t('docs_upload')}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {envelopes.length > 0 ? (
          <section className="card">
            <h2>{t('unsigned_title')}</h2>
            <ul className="list">
              {envelopes.map((e) => (
                <li key={e.id}>
                  <span className="grow">{t(`env_${e.type}` as DictKey)}</span>
                  <Link className="btn accent" href="/sign">
                    {t('nav_sign')}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {invoices.length > 0 ? (
          <section className="card">
            <h2>{t('invoices_open_title')}</h2>
            <ul className="list">
              {invoices.map((i) => (
                <li key={i.id}>
                  <span className="grow">
                    {i.invoice_number} · <strong>{formatMoney(i.total_cents)}</strong>
                  </span>
                  <Link className="btn accent" href="/invoices">
                    {t('inv_pay')}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="card">
          <h2>{t('quick_actions')}</h2>
          <p>
            <Link className="btn ghost block" href="/documents">{t('action_upload')}</Link>
          </p>
          <p>
            <Link className="btn ghost block" href="/messages">{t('action_message')}</Link>
          </p>
          <p>
            <Link className="btn ghost block" href="/request-service">{t('action_request')}</Link>
          </p>
          <p>
            <Link className="btn ghost block" href="/estimate">{t('action_estimate')}</Link>
          </p>
          {/* Replaced the 'Book your consultation' checklist step: a client reaching
              this screen has already had the discovery meeting, but still needs a way
              to reach us. Hidden entirely when no booking link is configured, rather
              than offering a dead button. */}
          {supportUrl ? (
            <p>
              <a className="btn ghost block" href={supportUrl} target="_blank" rel="noreferrer">
                {t('qa_schedule')}
              </a>
            </p>
          ) : null}
        </section>
      </div>

      {/* ESTIMATED PAYMENT DUE — its own container now (Brian, 2026-08-13). It was one
          grey line under the greeting: the largest number a client owes anyone, styled
          like a footnote, with no way to act on it. */}
      {nextEstimate ? (
        <section className="card" data-testid="estimate-due">
          <h2>{t('estdue_title')}</h2>
          <p>
            <strong>{nextEstimate.quarter}</strong> — {nextEstimate.date}
          </p>
          <p className="muted small">{t('estdue_intro')}</p>
          {irsUrl ? (
            <p>
              <a className="btn ghost block" href={irsUrl} target="_blank" rel="noreferrer">
                {t('estdue_pay_irs')}
              </a>
            </p>
          ) : null}
          {stateUrl ? (
            <p>
              <a className="btn ghost block" href={stateUrl} target="_blank" rel="noreferrer">
                {t('estdue_pay_state')}
              </a>
            </p>
          ) : null}
          {supportUrl ? (
            <>
              <p>
                <a className="btn ghost block" href={supportUrl} target="_blank" rel="noreferrer">
                  {t('estdue_review')}
                </a>
              </p>
              <p className="muted small">{t('estdue_review_note')}</p>
            </>
          ) : null}
        </section>
      ) : null}

      {/* SMS opt-in LAST: it is optional, and it used to sit between the client and the
          checklist we actually want them to start with. */}
      {showChecklist && me ? (
        <SmsOptIn smsConsent={me.sms_consent} phone={me.phone} onChange={() => void refresh()} />
      ) : null}
    </>
  );
}
