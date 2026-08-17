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
/*
 * A PROJECT, in the client's sense: any service they have with us, not only the tax
 * ones. `kind` separates the two honest shapes of progress — tax work is a pipeline
 * with a finish line, bookkeeping and payroll are ongoing and have none.
 */
interface Engagement {
  id: string;
  service_line: string;
  status: string;
  kind: 'pipeline' | 'ongoing';
  title: string | null;
  tax_year: number | null;
  return_type: string | null;
  stage: string | null;
  extension_filed: boolean;
  deadline: string | null;
}
interface Booking { id: string; event_slug: string; title: string | null; starts_at: string | null; location: string | null }
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
 * "Confirm your information" left this list on 2026-08-16 (#27): the questionnaire opens
 * with those fields prefilled from what we hold, so a step whose whole job was already
 * being done one screen later is duplicate work. Its column stays.
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
  { key: 'step_questionnaire_at', label: 'checklist_questionnaire', href: '/questionnaire', step: null, waiting: 'checklist_questionnaire_waiting', optional: false },
  { key: 'step_upload_documents_at', label: 'checklist_upload', href: '/documents', step: 'upload_documents', waiting: null, optional: false },
  { key: 'step_book_consult_at', label: 'checklist_book', href: '', step: null, waiting: 'checklist_book_waiting', optional: true },
] as const;

/*
 * The tax pipeline, in the order work actually moves through it. Used for the progress
 * bar, so a client can see that "in preparation" is further along than "documents
 * requested" without being told. Terminal-but-not-finished states (on_hold, rejected) are
 * absent on purpose: they are not positions on the road, and the stage label already says
 * what is happening.
 */
const STAGE_ORDER = [
  'intake_started', 'scheduled', 'documents_requested', 'pending_client_response',
  'in_preparation', 'internal_review', 'client_review', 'ready_to_file', 'filed', 'completed',
] as const;

function stagePercent(stage: string): number {
  const i = STAGE_ORDER.indexOf(stage as (typeof STAGE_ORDER)[number]);
  if (i < 0) return 0;
  return Math.round(((i + 1) / STAGE_ORDER.length) * 100);
}

/**
 * What the client calls this piece of work. Tax work is named by year and form, because
 * that is how a client thinks about it; everything else by its service line.
 */
function projectName(e: Engagement, t: (k: DictKey) => string): string {
  if (e.tax_year && e.return_type) return `${e.tax_year} · ${e.return_type.toUpperCase()}`;
  const line = t(`svcline_${e.service_line}` as DictKey);
  /*
   * #41 option (1): show the engagement's own title when it says MORE than the bare
   * service line — that is #19's composition ("Taxes — 1040 individual return +2 more")
   * reaching the client, so two engagements on one service line are distinguishable.
   *
   * #35 deliberately ignored this column because it held "Accepted quote" placeholders.
   * Those are backfilled, and a title that is merely the service-line name adds nothing,
   * so it falls through to the translated label rather than showing an English one.
   */
  const title = e.title?.trim();
  if (title && title.toLowerCase() !== line.toLowerCase() && title.toLowerCase() !== e.service_line) {
    return title;
  }
  return line;
}

export default function Dashboard() {
  const { t, me, nextEstimate, ready, lang, refresh } = useSession();
  const router = useRouter();
  const [onboarding, setOnboarding] = useState<Onboarding | null>(null);
  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
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
  // Always true since #27 — the questionnaire's first screen is the client's own
  // details, and every client has those. Still read from the API rather than assumed,
  // so the server stays the one place that decides which steps a client is shown.
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
      api<{ bookings: Booking[] }>('/portal/bookings')
        .then((r) => setBookings(r.bookings))
        .catch(() => setBookings([])),
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
        /*
         * YOUR WORK WITH US (#35). This was "Your returns", selected from tax rows only,
         * so a bookkeeping or payroll client saw nothing at all — and in production four
         * of six active tax engagements had no tax row either, so they were invisible to
         * their own clients too. It is now every service they have with us.
         *
         * The name comes from the service line and the tax year, never from
         * `engagements.title`: that column is internal and holds legacy values like
         * "Accepted quote", which is not a thing to show someone about their own business.
         */
        <section className="card" id="services">
          <h2>{t('projects_title')}</h2>
          <ul className="list">
            {engagements.map((e) => (
              <li key={e.id}>
                <span className="grow">
                  <strong>{projectName(e, t)}</strong>
                  <br />
                  <span className="muted small">
                    {e.kind === 'pipeline' && e.stage
                      ? t(`stage_${e.stage}` as DictKey)
                      : t(`estatus_${e.status}` as DictKey)}
                    {e.deadline ? ` · ${t('status_deadline')}: ${e.deadline}` : ''}
                  </span>
                  {/*
                    Progress is drawn ONLY for pipeline work. Bookkeeping and payroll are
                    ongoing — there is no finish line, and a bar creeping toward one would
                    promise a completion that is never coming.
                  */}
                  {e.kind === 'pipeline' && e.stage ? (
                    <span className="progress" style={{ display: 'block', marginTop: 6 }}>
                      <span style={{ display: 'block', width: `${stagePercent(e.stage)}%` }} />
                    </span>
                  ) : null}
                </span>
                {e.extension_filed ? <span className="badge warn">{t('status_extended')}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/*
        SCHEDULING (#35), and the reason it shows real bookings rather than only a link:
        Brian's policy is that every channel a client can claim they used must be one the
        system tracks. The Cal.com webhook now stores each booking, so this section can
        show the client the meeting they made — and if it is not here, we genuinely do not
        have it, which is a truthful thing for the client to be able to see.
      */}
      {bookingUrl || bookings.length > 0 ? (
        <section className="card">
          <h2>{t('sched_title')}</h2>
          {bookings.length > 0 ? (
            <ul className="list">
              {bookings.map((b) => (
                <li key={b.id}>
                  <span className="grow">
                    <strong>{b.title ?? b.event_slug}</strong>
                    <br />
                    <span className="muted small">
                      {b.starts_at ? new Date(b.starts_at).toLocaleString(lang === 'es' ? 'es-US' : 'en-US') : t('sched_time_tbd')}
                      {b.location ? ` · ${b.location}` : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">{t('sched_none')}</p>
          )}
          {bookingUrl ? (
            <a className="btn accent block" href={bookingUrl} target="_blank" rel="noreferrer">
              {t('sched_book')}
            </a>
          ) : null}
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
          {/*
            #45 — the questionnaire needs a PERSISTENT home, not just a checklist step
            that disappears once it is ticked. Before this there was no nav entry and no
            link anywhere, so a client who mistyped their revenue or forgot a state had to
            contact us: the exact "reached out about something the portal should handle"
            failure #35 exists to remove.

            It sits in Quick actions rather than the checklist because that is where
            things you can do ANY time live — the checklist is for the run-once journey.
          */}
          {questionnaireApplies ? (
            <p>
              <Link className="btn ghost block" href="/questionnaire">
                {onboarding?.step_questionnaire_at ? t('action_review_answers') : t('action_answer_questions')}
              </Link>
            </p>
          ) : null}
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
