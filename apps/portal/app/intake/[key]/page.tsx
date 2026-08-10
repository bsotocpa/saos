'use client';

// Public intake + questionnaire renderer (M28 — wireframe customer steps 2 and 4).
//
// PUBLIC by necessity: this is how a stranger becomes a client, so it must work
// with no account. The API was complete and tested for months with nothing that
// rendered it; this is that renderer.
//
// Four things it is deliberate about:
//
//  1. THE FORM IS DATA. Screens, fields, options and now the bilingual question
//     text all come from the definition, so Brian changes wording or adds an
//     industry without a deploy. This file knows about FIELD TYPES, not questions.
//
//  2. PROGRESS IS SAVED AS YOU GO. Each screen PATCHes its answers with the resume
//     token, so a client who loses signal on a phone mid-intake does not start over.
//
//  3. THE TCPA DISCLOSURE RENDERS WITH THE CONSENT QUESTION. The seed comment is
//     explicit that the A2P campaign registration references that exact language at
//     the point of consent, so `helpEn/helpEs` is shown, not tucked away.
//
//  4. CONDITIONAL FIELDS AND CONDITIONAL REQUIREMENTS ARE HONOURED CLIENT-SIDE so
//     the form does not ask about a business to someone who said they have none —
//     but the server validates independently, and its issues are shown per field.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, ApiError } from '../../../lib/api';
import { useSession } from '../../../lib/session';

type FieldType =
  | 'text' | 'email' | 'phone' | 'zip' | 'select' | 'multiselect'
  | 'yesno' | 'checkbox' | 'longtext' | 'repeat' | 'number';

interface Option { value: string; labelEn: string; labelEs: string }
interface Field {
  key: string;
  type: FieldType;
  labelEn?: string;
  labelEs?: string;
  helpEn?: string;
  helpEs?: string;
  required?: boolean | { field: string; equals?: unknown; includesAny?: string[] };
  showWhen?: { field: string; equals?: unknown; in?: unknown[]; includesAny?: string[] };
  options?: Option[];
  itemFields?: Field[];
}
interface Screen { id: number; titleEn: string; titleEs: string; fields: Field[] }
interface Definition { slug: string; screens: Screen[] }

type Answers = Record<string, unknown>;

/** showWhen / conditional-required share one evaluator so they cannot disagree. */
function conditionMet(
  cond: { field: string; equals?: unknown; in?: unknown[]; includesAny?: string[] } | undefined,
  answers: Answers
): boolean {
  if (!cond) return true;
  const v = answers[cond.field];
  if (cond.equals !== undefined) return v === cond.equals;
  if (cond.in !== undefined) return cond.in.includes(v);
  if (cond.includesAny !== undefined) {
    return Array.isArray(v) && cond.includesAny.some((x) => (v as string[]).includes(x));
  }
  return true;
}

function isRequired(f: Field, answers: Answers): boolean {
  if (typeof f.required === 'boolean') return f.required;
  if (!f.required) return false;
  // Conditionally required, e.g. business_name is required only when they said
  // they own a business.
  return conditionMet(f.required, answers);
}

export default function IntakePage() {
  const { t, lang, setLang } = useSession();
  const params = useParams<{ key: string }>();
  const formKey = params.key;

  const [definition, setDefinition] = useState<Definition | null>(null);
  const [submissionId, setSubmissionId] = useState('');
  const [resumeToken, setResumeToken] = useState('');
  const [answers, setAnswers] = useState<Answers>({});
  const [screenIndex, setScreenIndex] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | 'invalid' | 'done'>('loading');
  const [rehearsalBanner, setRehearsalBanner] = useState<{ en: string | null; es: string | null }>({ en: null, es: null });
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const label = (f: Field) => (lang === 'es' ? f.labelEs : f.labelEn) ?? f.key;
  const help = (f: Field) => (lang === 'es' ? f.helpEs : f.helpEn);
  const optLabel = (o: Option) => (lang === 'es' ? o.labelEs : o.labelEn);

  useEffect(() => {
    void (async () => {
      try {
        const d = await api<{ definition: Definition; rehearsalBannerEn: string | null; rehearsalBannerEs: string | null }>(`/public/forms/${formKey}`);
        const started = await api<{ submissionId: string; resumeToken: string }>(
          `/public/forms/${formKey}/start`,
          { method: 'POST', body: { language: lang, source: 'portal' } }
        );
        setDefinition(d.definition);
        setRehearsalBanner({ en: d.rehearsalBannerEn, es: d.rehearsalBannerEs });
        setSubmissionId(started.submissionId);
        setResumeToken(started.resumeToken);
        setState('ready');
      } catch {
        setState('invalid');
      }
    })();
    // Starting a submission is a one-time act per page load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formKey]);

  const screen = definition?.screens[screenIndex];
  const visibleFields = useMemo(
    () => (screen ? screen.fields.filter((f) => conditionMet(f.showWhen, answers)) : []),
    [screen, answers]
  );

  const set = (key: string, value: unknown) => {
    setAnswers((a) => ({ ...a, [key]: value }));
    setIssues((i) => {
      if (!(key in i)) return i;
      const next = { ...i };
      delete next[key];
      return next;
    });
  };

  /** Client-side check of THIS screen only — the server re-validates everything. */
  const screenIssues = useCallback((): Record<string, string> => {
    const found: Record<string, string> = {};
    for (const f of visibleFields) {
      if (!isRequired(f, answers)) continue;
      const v = answers[f.key];
      const empty =
        v === undefined || v === null || v === '' ||
        (Array.isArray(v) && v.length === 0) ||
        (f.type === 'checkbox' && v !== true);
      if (empty) found[f.key] = t('intake_required');
    }
    return found;
  }, [visibleFields, answers, t]);

  const saveScreen = async () => {
    await api(`/public/forms/submissions/${submissionId}`, {
      method: 'PATCH',
      body: { resumeToken, answers, screenReached: screenIndex + 1 },
    });
  };

  const next = async () => {
    const found = screenIssues();
    if (Object.keys(found).length > 0) {
      setIssues(found);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await saveScreen();
      // The language question, when answered, drives the rest of the form.
      if (answers.language === 'es' && lang !== 'es') setLang('es');
      if (answers.language === 'en' && lang !== 'en') setLang('en');
      setScreenIndex((i) => i + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('error_generic'));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const found = screenIssues();
    if (Object.keys(found).length > 0) {
      setIssues(found);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api(`/public/forms/submissions/${submissionId}/submit`, {
        method: 'POST',
        body: { resumeToken, answers },
      });
      setState('done');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'form_validation_failed') {
        // Server-side issues are per-field, so they land next to the question.
        const raw = (err as ApiError & { issues?: Array<{ field?: string; message?: string }> }).issues;
        const mapped: Record<string, string> = {};
        for (const i of raw ?? []) if (i.field) mapped[i.field] = i.message ?? t('intake_required');
        setIssues(mapped);
        setError(t('intake_fix_below'));
      } else {
        setError(err instanceof ApiError ? err.message : t('error_generic'));
      }
    } finally {
      setBusy(false);
    }
  };

  if (state === 'loading') return <p className="muted">{t('loading')}</p>;
  if (state === 'invalid') {
    return (
      <section className="card">
        <h1>{t('intake_unavailable_title')}</h1>
        <p>{t('intake_unavailable_body')}</p>
      </section>
    );
  }
  if (state === 'done') {
    return (
      <section className="card">
        <h1>{t('intake_done_title')}</h1>
        <p>{t('intake_done_body')}</p>
        <p className="muted small">{t('intake_done_next')}</p>
      </section>
    );
  }

  const total = definition!.screens.length;
  const last = screenIndex === total - 1;

  return (
    <>
      <h1>{lang === 'es' ? screen!.titleEs : screen!.titleEn}</h1>
      <p className="muted small">
        {t('intake_progress')} {screenIndex + 1} / {total}
      </p>
      <div className="progress" aria-hidden="true">
        <div style={{ width: `${((screenIndex + 1) / total) * 100}%` }} />
      </div>

      {/* Self-removing: keyed off the §7216 templates still being placeholders, so
          it disappears the moment Brian clears those flags. */}
      {(lang === 'es' ? rehearsalBanner.es : rehearsalBanner.en) ? (
        <div className="alert error">
          <strong>{lang === 'es' ? rehearsalBanner.es : rehearsalBanner.en}</strong>
        </div>
      ) : null}

      {error ? <div className="alert error">{error}</div> : null}

      <section className="card">
        {visibleFields.map((f) => {
          const v = answers[f.key];
          const req = isRequired(f, answers);
          const issue = issues[f.key];
          return (
            <div key={f.key} style={{ marginBottom: 14 }}>
              {f.type === 'checkbox' ? (
                <label className="field" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontWeight: 400 }}>
                  <input
                    type="checkbox"
                    className="tickbox"
                    checked={v === true}
                    onChange={(e) => set(f.key, e.target.checked)}
                  />
                  <span>
                    {label(f)}
                    {req ? ' *' : ''}
                  </span>
                </label>
              ) : (
                <label className="field">
                  {label(f)}
                  {req ? ' *' : ''}
                  {f.type === 'text' || f.type === 'email' || f.type === 'phone' || f.type === 'zip' || f.type === 'number' ? (
                    <input
                      type={f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : f.type === 'number' ? 'number' : 'text'}
                      inputMode={f.type === 'phone' ? 'tel' : f.type === 'email' ? 'email' : f.type === 'zip' || f.type === 'number' ? 'numeric' : 'text'}
                      value={typeof v === 'string' || typeof v === 'number' ? String(v) : ''}
                      onChange={(e) => set(f.key, e.target.value)}
                    />
                  ) : null}
                  {f.type === 'longtext' ? (
                    <textarea
                      rows={4}
                      value={typeof v === 'string' ? v : ''}
                      onChange={(e) => set(f.key, e.target.value)}
                    />
                  ) : null}
                  {f.type === 'select' ? (
                    <select value={typeof v === 'string' ? v : ''} onChange={(e) => set(f.key, e.target.value)}>
                      <option value="">{t('intake_choose')}</option>
                      {(f.options ?? []).map((o) => (
                        <option key={o.value} value={o.value}>{optLabel(o)}</option>
                      ))}
                    </select>
                  ) : null}
                  {f.type === 'yesno' ? (
                    <select
                      value={v === true ? 'yes' : v === false ? 'no' : ''}
                      onChange={(e) => set(f.key, e.target.value === '' ? undefined : e.target.value === 'yes')}
                    >
                      <option value="">{t('intake_choose')}</option>
                      <option value="yes">{t('intake_yes')}</option>
                      <option value="no">{t('intake_no')}</option>
                    </select>
                  ) : null}
                </label>
              )}

              {f.type === 'multiselect' ? (
                <div className="chipbar" style={{ marginTop: 4 }}>
                  {(f.options ?? []).map((o) => {
                    const picked = Array.isArray(v) && (v as string[]).includes(o.value);
                    return (
                      <button
                        key={o.value}
                        type="button"
                        className={`chip ${picked ? 'active' : ''}`}
                        onClick={() => {
                          const cur = Array.isArray(v) ? (v as string[]) : [];
                          set(f.key, picked ? cur.filter((x) => x !== o.value) : [...cur, o.value]);
                        }}
                      >
                        {optLabel(o)}
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {/* A repeat field collects a list of short entries. Kept simple on
                  purpose: one line per item, add and remove. */}
              {f.type === 'repeat' ? (
                <RepeatField
                  value={Array.isArray(v) ? (v as Array<Record<string, string>>) : []}
                  itemFields={f.itemFields ?? []}
                  lang={lang}
                  addLabel={t('intake_add_another')}
                  removeLabel={t('intake_remove')}
                  onChange={(rows) => set(f.key, rows)}
                />
              ) : null}

              {/* TCPA: the disclosure must render AT the point of consent. */}
              {help(f) ? (
                <p className="muted small" style={{ marginTop: 2 }}>{help(f)}</p>
              ) : null}
              {issue ? <p className="small" style={{ color: 'var(--danger)' }}>{issue}</p> : null}
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
        <p className="muted small">{t('intake_saved_note')}</p>
      </section>
    </>
  );
}

function RepeatField({
  value, itemFields, lang, addLabel, removeLabel, onChange,
}: {
  value: Array<Record<string, string>>;
  itemFields: Field[];
  lang: 'en' | 'es';
  addLabel: string;
  removeLabel: string;
  onChange: (rows: Array<Record<string, string>>) => void;
}) {
  return (
    <div style={{ marginTop: 4 }}>
      {value.map((row, idx) => (
        <div className="card" key={idx} style={{ marginBottom: 8, padding: 10 }}>
          {itemFields.map((sub) => (
            <label className="field" key={sub.key}>
              {(lang === 'es' ? sub.labelEs : sub.labelEn) ?? sub.key}
              <input
                value={row[sub.key] ?? ''}
                onChange={(e) => {
                  const rows = value.slice();
                  rows[idx] = { ...row, [sub.key]: e.target.value };
                  onChange(rows);
                }}
              />
            </label>
          ))}
          <button
            type="button"
            className="chip"
            onClick={() => onChange(value.filter((_, i) => i !== idx))}
          >
            {removeLabel}
          </button>
        </div>
      ))}
      <button type="button" className="chip" onClick={() => onChange([...value, {}])}>
        {addLabel}
      </button>
    </div>
  );
}
