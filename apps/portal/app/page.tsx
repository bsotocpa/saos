'use client';

// Dashboard (MP Soto Portal): 4-step first-login checklist (collapses when
// done), plain-English engagement status, outstanding doc requests, unsigned
// documents, open invoices with Pay Now, quick actions.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, formatMoney, isAuthed } from '../lib/api';
import { useSession } from '../lib/session';
import type { DictKey } from '../lib/i18n';

interface Onboarding {
  variant: string;
  step_confirm_info_at: string | null;
  step_sign_docs_at: string | null;
  step_upload_prior_return_at: string | null;
  step_book_consult_at: string | null;
  completed_at: string | null;
}
interface Engagement { id: string; tax_year: number; return_type: string; stage: string; extension_filed: boolean; deadline: string | null }
interface DocRequest { id: string; title_en: string; title_es: string | null; items: Array<{ id: string; status: string }> }
interface Envelope { id: string; type: string; status: string }
interface Invoice { id: string; invoice_number: string; status: string; total_cents: number }

const STEPS = [
  { key: 'step_confirm_info_at', label: 'checklist_step1', href: '/profile', step: 'confirm_info' },
  { key: 'step_sign_docs_at', label: 'checklist_step2', href: '/sign', step: 'sign_docs' },
  { key: 'step_upload_prior_return_at', label: 'checklist_step3', href: '/documents', step: 'upload_prior_return' },
  { key: 'step_book_consult_at', label: 'checklist_step4', href: '/estimate', step: 'book_consult' },
] as const;

export default function Dashboard() {
  const { t, me, ready, lang } = useSession();
  const router = useRouter();
  const [onboarding, setOnboarding] = useState<Onboarding | null>(null);
  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [requests, setRequests] = useState<DocRequest[]>([]);
  const [envelopes, setEnvelopes] = useState<Envelope[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);

  useEffect(() => {
    if (!isAuthed()) {
      router.replace('/login');
      return;
    }
    void Promise.all([
      api<{ onboarding: Onboarding | null }>('/portal/onboarding').then((r) => setOnboarding(r.onboarding)),
      api<{ engagements: Engagement[] }>('/portal/engagements').then((r) => setEngagements(r.engagements)),
      api<{ requests: DocRequest[] }>('/portal/document-requests').then((r) => setRequests(r.requests)),
      api<{ envelopes: Envelope[] }>('/portal/signature-envelopes').then((r) =>
        setEnvelopes(r.envelopes.filter((e) => e.status !== 'completed'))
      ),
      api<{ invoices: Invoice[] }>('/portal/invoices').then((r) =>
        setInvoices(r.invoices.filter((i) => i.status === 'sent' || i.status === 'overdue'))
      ),
    ]);
  }, [router]);

  const markStep = async (step: string) => {
    await api(`/portal/onboarding/steps/${step}/complete`, { method: 'POST' });
    const r = await api<{ onboarding: Onboarding | null }>('/portal/onboarding');
    setOnboarding(r.onboarding);
  };

  if (!ready) return <p>{t('loading')}</p>;

  const showChecklist = onboarding && !onboarding.completed_at;
  const doneCount = onboarding
    ? STEPS.filter((s) => onboarding[s.key as keyof Onboarding]).length
    : 0;
  const nothingWaiting = requests.length === 0 && envelopes.length === 0 && invoices.length === 0;

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
            <div style={{ width: `${(doneCount / 4) * 100}%` }} />
          </div>
          {STEPS.map((s, i) => {
            const done = Boolean(onboarding?.[s.key as keyof Onboarding]);
            return (
              <div className="checklist-step" key={s.step}>
                <span className={`step-dot ${done ? 'done' : ''}`}>{done ? '✓' : i + 1}</span>
                <span className="grow">{t(s.label)}</span>
                {done ? (
                  <span className="badge ok">{t('checklist_done')}</span>
                ) : (
                  <>
                    <Link className="btn ghost" href={s.href}>
                      {t('checklist_go')}
                    </Link>
                    <button className="btn ghost" type="button" onClick={() => void markStep(s.step)}>
                      {t('checklist_mark_done')}
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </section>
      ) : null}

      {engagements.length > 0 ? (
        <section className="card">
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
        </section>
      </div>
    </>
  );
}
