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
  step_consent_at: string | null;
  step_confirm_info_at: string | null;
  step_questionnaire_at: string | null;
  step_upload_documents_at: string | null;
  step_track_services_at: string | null;
  step_book_consult_at: string | null;
  completed_at: string | null;
}
interface Engagement { id: string; tax_year: number; return_type: string; stage: string; extension_filed: boolean; deadline: string | null }
interface DocRequest { id: string; title_en: string; title_es: string | null; items: Array<{ id: string; status: string }> }
interface Envelope { id: string; type: string; status: string }
interface Invoice { id: string; invoice_number: string; status: string; total_cents: number }

/*
 * THE CANONICAL CLIENT JOURNEY, as Brian ruled it (2026-08-16, finding #34). Step 1 —
 * login setup from the one email — is not on this list because it is how they arrive.
 *
 *   2. Review & sign packet          → /sign
 *   3. §7216 consent, own screen     → /consent
 *   4. Onboarding questionnaire      → /questionnaire
 *   5. Upload documents              → /documents
 *   6. Book kickoff, OPTIONAL        → the booking link
 *
 * THE DEPOSIT IS GONE from this list. It is collected at quote acceptance, before the
 * portal journey starts, so it is not something the client comes here to do. Its column
 * still fills in, because when the deposit was paid is real history.
 *
 * CONSENT COULD NOT HAVE BEEN LINKED ANY EARLIER. Until now nothing in the portal
 * pointed at /consent at all: the dashboard knew an offer was outstanding — it used the
 * count to suppress "you're all caught up" — and gave the client no way to reach it. A
 * client could finish every step and never be asked.
 *
 * Its ordering is not enforced here. `consentsToPresent` withholds every offer until the
 * Master is signed, because a consent presented beside the document you must sign to be
 * served is the conditioning §7216 prohibits. So the step appears when step 2 completes,
 * which is what "immediately after signing" means, and this file just renders it.
 *
 * A `waiting` label means the step completes ITSELF and the client is not asked to tick
 * it, because the system already knows: consent completes when they ANSWER it (yes or
 * no — a step that only completed on "yes" would pressure them into consenting), the
 * questionnaire completes when it is submitted, and booking completes when Cal.com says
 * a booking exists rather than when a client claims one does. Each says what it is
 * waiting FOR: "Waiting on payment" under a consent step was the previous shape of this
 * code and would have been nonsense.
 *
 * `optional` keeps a step out of the completion rule. Booking is the only one.
 */
const STEPS = [
  { key: 'step_sign_docs_at', label: 'checklist_sign', href: '/sign', step: 'sign_docs', waiting: null, optional: false },
  { key: 'step_consent_at', label: 'checklist_consent', href: '/consent', step: null, waiting: 'checklist_consent_waiting', optional: false },
  { key: 'step_confirm_info_at', label: 'checklist_confirm', href: '/profile', step: 'confirm_info', waiting: null, optional: false },
  { key: 'step_questionnaire_at', label: 'checklist_questionnaire', href: '/questionnaire', step: null, waiting: 'checklist_questionnaire_waiting', optional: false },
  { key: 'step_upload_documents_at', label: 'checklist_upload', href: '/documents', step: 'upload_documents', waiting: null, optional: false },
  { key: 'step_track_services_at', label: 'checklist_track', href: '#services', step: 'track_services', waiting: null, optional: false },
  { key: 'step_book_consult_at', label: 'checklist_book', href: '', step: null, waiting: 'checklist_book_waiting', optional: true },
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
  // Whether this client has a questionnaire at all: the modules assemble from their
  // own services and industry, so some clients have none. Same reasoning as the
  // deposit — nobody should stare at a step they can never complete.
  const [questionnaireApplies, setQuestionnaireApplies] = useState(false);
  // Consent is withheld until the packet is signed, so before that there is no step.
  const [consentApplies, setConsentApplies] = useState(false);
  // Booking is a setting; null means scheduling is not open, not that it is broken.
  const [bookingApplies, setBookingApplies] = useState(false);

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
        questionnaireApplies: boolean;
        consentApplies: boolean;
        bookingApplies: boolean;
      }>('/portal/onboarding').then((r) => {
        setOnboarding(r.onboarding);
        setBookingUrl(r.bookingUrl ?? null);
        setSupportUrl(r.supportBookingUrl ?? null);
        setIrsUrl(r.irsPaymentUrl ?? null);
        setStateUrl(r.statePaymentUrl ?? null);
        setQuestionnaireApplies(Boolean(r.questionnaireApplies));
        setConsentApplies(Boolean(r.consentApplies));
        setBookingApplies(Boolean(r.bookingApplies));
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
  /*
   * A step nobody can complete is worse than no step. Each of these is conditional on
   * something real: the questionnaire assembles from the client's own services,
   * consent is withheld until the packet is signed, and booking needs a scheduler to
   * point at. The deposit is not in STEPS at all any more — it is collected at quote
   * acceptance, before this journey begins.
   */
  const visibleSteps = STEPS.filter(
    (s) =>
      (s.key !== 'step_questionnaire_at' || questionnaireApplies) &&
      (s.key !== 'step_consent_at' || consentApplies) &&
      (s.key !== 'step_book_consult_at' || bookingApplies)
  );
  /*
   * Progress counts REQUIRED steps only. Booking is optional and completable at any
   * time, so counting it would leave a client who finished everything asked of them
   * looking at 6/7 — and the checklist itself disappears at that point, which would
   * make the bar contradict the page.
   */
  const requiredSteps = visibleSteps.filter((s) => !s.optional);
  const doneCount = onboarding
    ? requiredSteps.filter((s) => onboarding[s.key as keyof Onboarding]).length
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
            <div style={{ width: `${requiredSteps.length ? (doneCount / requiredSteps.length) * 100 : 0}%` }} />
          </div>
          {visibleSteps.map((s, i) => {
            const done = Boolean(onboarding?.[s.key as keyof Onboarding]);
            // Booking lives on an external scheduler, so its destination is a setting
            // rather than a route. Every other step is a portal page.
            const href = s.key === 'step_book_consult_at' ? (bookingUrl ?? '') : s.href;
            return (
              /* Keyed on the COLUMN, not on `step`: self-completing steps have no
                 `step` name, and there are now four of them — React would see four
                 children keyed `null`. */
              <div className="checklist-step" key={s.key}>
                <span className={`step-dot ${done ? 'done' : ''}`}>{done ? '✓' : i + 1}</span>
                <span className="grow">
                  {t(s.label)}
                  {s.optional ? <span className="muted small"> · {t('checklist_optional')}</span> : null}
                </span>
                {done ? (
                  <span className="badge ok">{t('checklist_done')}</span>
                ) : s.waiting ? (
                  /* Completes ITSELF. There is no "Mark done": a client cannot honestly
                     tick these, and asking them to confirm something we can already see
                     is how a checklist starts lying. Go takes them to the place where
                     the real thing happens; the tick follows the event. */
                  <>
                    <a className="btn ghost" href={href}>{t('checklist_go')}</a>
                    <span className="muted small">{t(s.waiting)}</span>
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
