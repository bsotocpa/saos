'use client';

// Step 4 of the canonical client journey: the service-onboarding questionnaire
// (Brian's #30/#31 ruling, 2026-08-15).
//
// The API for this has existed since M14 — assembleModules picks the A–I modules a
// client's engagements and industry fire, and processServiceOnboarding evaluates the
// flags. Nothing ever rendered it, so the modules were assembled for nobody. This is
// that renderer, and it is deliberately the same shape as the intake renderer:
//
//  1. THE QUESTIONS ARE DATA. Modules, questions, options and both languages come from
//     the assembled definition, so Brian changes wording or adds a module in Admin
//     without a deploy. This file knows about QUESTION TYPES, not questions.
//
//  2. ONE MODULE PER SCREEN. Nine modules and up to 49 questions on one page is
//     unusable on a phone, and the modules are already meaningful groupings — "Tech
//     stack", "Payroll" — so they make honest screens.
//
//  3. PROGRESS SAVES AS YOU GO, AND COMES BACK. Each screen PATCHes; the draft is
//     server-side, keyed to the portal session. Learned the hard way on the intake,
//     where autosave wrote for months with nothing able to read it back.
//
//  4. NOTHING IS REQUIRED. These questions scope the work — they are not a gate on
//     being served. A client who does not know their monthly transaction volume should
//     be able to move on and tell us later, so the questionnaire never blocks itself.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError, isAuthed } from '../../lib/api';
import { useSession } from '../../lib/session';

type QType = 'select' | 'multiselect' | 'text' | 'yesno' | 'number';

interface Option { value: string; labelEn: string; labelEs: string }
/*
 * `showWhen` (#37) — a question that only appears once its parent calls for it.
 *
 * It speaks the modules' own vocabulary (`question`, not `field`) because that is what
 * the flag rules already use: `{ question: 'C4', numberGte: 3 }`. Two dialects for the
 * same idea inside one file would be the kind of thing that reads fine and gets one of
 * them wrong later.
 */
interface ShowWhen { question: string; equals?: unknown; includesAny?: string[] }
interface Question {
  id: string; labelEn: string; labelEs: string; type: QType;
  options?: Option[]; showWhen?: ShowWhen;
}

/**
 * Whether a conditional question should be on screen right now.
 *
 * A question with no condition always shows. `includesAny` is the multiselect case —
 * "did they pick Other among whatever else they picked".
 */
function visible(q: Question, answers: Answers): boolean {
  const c = q.showWhen;
  if (!c) return true;
  const v = answers[c.question];
  if (c.includesAny) return Array.isArray(v) && c.includesAny.some((x) => (v as string[]).includes(x));
  if (c.equals !== undefined) return v === c.equals;
  return true;
}
interface Module { key: string; nameEn: string; nameEs: string; questions: Question[] }

type Answers = Record<string, unknown>;

/*
 * WHAT WE ALREADY HOLD (#27). Prefilled and correctable, and only ever behind a portal
 * session — Brian's ruling is that the unauthenticated pre-engagement form prefills
 * nothing, ever, because a public form is resumable by whoever holds its link.
 *
 * Email is shown but NOT editable: it is the login identity, and the profile endpoint has
 * never accepted a change to it. Someone who needs it changed should reach a person.
 */
interface Held {
  first_name: string; last_name: string; email: string | null;
  phone: string | null; secondary_phone: string | null;
  preferred_contact_method: string | null; language: string;
  address_line1: string | null; address_line2: string | null;
  city: string | null; state: string | null; zip: string | null;
}

const DETAIL_FIELDS = [
  ['firstName', 'first_name', 'quest_first_name'],
  ['lastName', 'last_name', 'quest_last_name'],
  ['phone', 'phone', 'quest_phone'],
  ['addressLine1', 'address_line1', 'quest_address'],
  ['city', 'city', 'quest_city'],
  ['state', 'state', 'quest_state'],
  ['zip', 'zip', 'quest_zip'],
] as const;

export default function QuestionnairePage() {
  const { t, lang } = useSession();

  const [modules, setModules] = useState<Module[]>([]);
  const [answers, setAnswers] = useState<Answers>({});
  const [screenIndex, setScreenIndex] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | 'none' | 'done' | 'error'>('loading');
  const [resumed, setResumed] = useState(false);
  const [held, setHeld] = useState<Held | null>(null);
  const [details, setDetails] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const label = (q: Question) => (lang === 'es' ? q.labelEs : q.labelEn) || q.id;
  const optLabel = (o: Option) => (lang === 'es' ? o.labelEs : o.labelEn) || o.value;
  const moduleName = (m: Module) => (lang === 'es' ? m.nameEs : m.nameEn);

  const router = useRouter();

  useEffect(() => {
    // Same gate every other portal page uses. Without it an expired session renders
    // the questionnaire shell and then fails against a 401, which reads as breakage
    // rather than as "sign in again".
    if (!isAuthed()) {
      router.replace('/login');
      return;
    }
    void (async () => {
      try {
        const r = await api<{
          modules: Module[];
          contact: Held | null;
          answers: Answers;
          screenReached: number;
          submittedAt: string | null;
        }>('/portal/service-onboarding');

        // Already answered, or nothing to answer — either way there is no form here.
        // Both are ordinary states, not errors: a tax-only client with no industry
        // module fires nothing, and telling them something went wrong would be a lie.
        if (r.submittedAt) { setState('done'); return; }

        setHeld(r.contact);
        setModules(r.modules);
        setAnswers(r.answers ?? {});
        const resumeAt = Math.min(r.screenReached ?? 0, r.modules.length);
        setScreenIndex(resumeAt);
        if (resumeAt > 0 || Object.keys(r.answers ?? {}).length > 0) setResumed(true);
        setState('ready');
      } catch {
        // 'error', NOT 'ready'. Falling through to the form with no modules loaded
        // renders module[0] of an empty list and crashes the page — a failed fetch
        // must show a message, not a white screen.
        setError(t('error_generic'));
        setState('error');
      }
    })();
    // Loading the questionnaire is a one-time act per page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  /*
   * Screen 0 is ALWAYS the client's own details (#27) — that is what let the separate
   * "Confirm your information" checklist step go, and it is why a client whose services
   * fire no modules still has a questionnaire worth opening.
   */
  const onDetails = screenIndex === 0;
  const current = onDetails ? undefined : modules[screenIndex - 1];
  const total = modules.length + 1;
  const last = screenIndex === total - 1;

  const set = (key: string, value: unknown) => setAnswers((a) => ({ ...a, [key]: value }));

  const save = useCallback(
    async (screenReached: number) => {
      await api('/portal/service-onboarding', {
        method: 'PATCH',
        body: { answers, screenReached },
      });
    },
    [answers]
  );

  const next = async () => {
    setBusy(true);
    setError('');
    try {
      if (onDetails) await saveDetails();
      await save(screenIndex + 1);
      setScreenIndex((i) => i + 1);
      setResumed(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error_generic'));
    } finally {
      setBusy(false);
    }
  };

  /** Only what they actually changed — an unchanged field is not an edit. */
  const saveDetails = async () => {
    const body: Record<string, string> = {};
    for (const [apiKey, heldKey] of DETAIL_FIELDS.map(([a, h]) => [a, h] as const)) {
      const typed = details[apiKey];
      if (typed !== undefined && typed !== (held?.[heldKey] ?? '')) body[apiKey] = typed;
    }
    const lang = details.language;
    if (lang !== undefined && lang !== held?.language) body.language = lang;
    const pref = details.preferredContactMethod;
    if (pref !== undefined && pref !== (held?.preferred_contact_method ?? '')) body.preferredContactMethod = pref;
    if (Object.keys(body).length === 0) return;
    await api('/portal/me', { method: 'PATCH', body });
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      if (onDetails) await saveDetails();
      await api('/portal/service-onboarding/submit', { method: 'POST', body: { answers } });
      setState('done');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error_generic'));
    } finally {
      setBusy(false);
    }
  };

  const progress = useMemo(
    () => (total > 0 ? ((screenIndex + 1) / total) * 100 : 0),
    [screenIndex, total]
  );

  if (state === 'loading') return <p className="muted">{t('loading')}</p>;

  if (state === 'error') {
    return (
      <section className="card">
        <div className="alert error">{error}</div>
        <Link className="btn ghost" href="/">{t('back_home')}</Link>
      </section>
    );
  }

  if (state === 'done') {
    return (
      <section className="card">
        <h1>{t('quest_done_title')}</h1>
        <p>{t('quest_done_body')}</p>
        <Link className="btn accent" href="/">{t('back_home')}</Link>
      </section>
    );
  }

  // Belt and braces: screenIndex is clamped on load, but a module list that changed
  // underneath a long-open tab must not render module[undefined]. Screen 0 has no
  // module by design, so it is exempt.
  if (!onDetails && !current) return <p className="muted">{t('loading')}</p>;

  return (
    <>
      <h1>{t('quest_title')}</h1>
      <p className="muted small">
        {onDetails ? t('quest_details_title') : moduleName(current!)} · {screenIndex + 1} / {total}
      </p>
      <div className="progress" aria-hidden="true">
        <div style={{ width: `${progress}%` }} />
      </div>

      {resumed ? <div className="alert">{t('quest_resumed')}</div> : null}
      {error ? <div className="alert error">{error}</div> : null}

      <section className="card">
        {onDetails ? (
          <>
            <p className="muted small">{t('quest_details_intro')}</p>
            {DETAIL_FIELDS.map(([apiKey, heldKey, labelKey]) => (
              <label className="field" key={apiKey}>
                {t(labelKey)}
                <input
                  value={details[apiKey] ?? (held?.[heldKey] ?? '')}
                  onChange={(e) => setDetails((v) => ({ ...v, [apiKey]: e.target.value }))}
                />
              </label>
            ))}
            <label className="field">
              {t('quest_language')}
              <select
                value={details.language ?? held?.language ?? 'en'}
                onChange={(e) => setDetails((v) => ({ ...v, language: e.target.value }))}
              >
                <option value="en">English</option>
                <option value="es">Español</option>
              </select>
            </label>
            <label className="field">
              {t('quest_preferred')}
              <select
                value={details.preferredContactMethod ?? held?.preferred_contact_method ?? ''}
                onChange={(e) => setDetails((v) => ({ ...v, preferredContactMethod: e.target.value }))}
              >
                <option value="">{t('intake_choose')}</option>
                <option value="text">{t('quest_pref_text')}</option>
                <option value="email">{t('quest_pref_email')}</option>
                <option value="phone">{t('quest_pref_phone')}</option>
                <option value="portal">{t('quest_pref_portal')}</option>
              </select>
            </label>
            {/* Shown, never editable: it is the login identity, and changing it is a
                conversation with a person rather than a field on a form. */}
            <p className="muted small">
              {t('quest_email_fixed')} {held?.email ?? ''}
            </p>
          </>
        ) : null}
        {(current?.questions ?? []).filter((q) => visible(q, answers)).map((q) => {
          const v = answers[q.id];
          return (
            <div key={q.id} style={{ marginBottom: 14 }}>
              <label className="field">
                {label(q)}
                {q.type === 'text' ? (
                  <input
                    type="text"
                    value={typeof v === 'string' ? v : ''}
                    onChange={(e) => set(q.id, e.target.value)}
                  />
                ) : null}
                {q.type === 'number' ? (
                  <input
                    type="number"
                    inputMode="numeric"
                    value={typeof v === 'string' || typeof v === 'number' ? String(v) : ''}
                    onChange={(e) => set(q.id, e.target.value)}
                  />
                ) : null}
                {q.type === 'select' ? (
                  <select value={typeof v === 'string' ? v : ''} onChange={(e) => set(q.id, e.target.value)}>
                    <option value="">{t('intake_choose')}</option>
                    {(q.options ?? []).map((o) => (
                      <option key={o.value} value={o.value}>{optLabel(o)}</option>
                    ))}
                  </select>
                ) : null}
                {q.type === 'yesno' ? (
                  <select
                    value={v === true ? 'yes' : v === false ? 'no' : ''}
                    onChange={(e) => set(q.id, e.target.value === '' ? undefined : e.target.value === 'yes')}
                  >
                    <option value="">{t('intake_choose')}</option>
                    <option value="yes">{t('intake_yes')}</option>
                    <option value="no">{t('intake_no')}</option>
                  </select>
                ) : null}
              </label>

              {q.type === 'multiselect' ? (
                <div className="chipbar" style={{ marginTop: 4 }}>
                  {(q.options ?? []).map((o) => {
                    const picked = Array.isArray(v) && (v as string[]).includes(o.value);
                    return (
                      <button
                        key={o.value}
                        type="button"
                        className={`chip ${picked ? 'active' : ''}`}
                        onClick={() => {
                          const cur = Array.isArray(v) ? (v as string[]) : [];
                          set(q.id, picked ? cur.filter((x) => x !== o.value) : [...cur, o.value]);
                        }}
                      >
                        {optLabel(o)}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}

        <div className="quote-actions">
          {screenIndex > 0 ? (
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setScreenIndex((i) => i - 1)}>
              {t('intake_back')}
            </button>
          ) : null}
          <button
            type="button"
            className="btn accent"
            disabled={busy}
            onClick={() => void (last ? submit() : next())}
          >
            {last ? t('intake_submit') : t('intake_next')}
          </button>
        </div>
        <p className="muted small">{t('quest_saved_note')}</p>
      </section>
    </>
  );
}
