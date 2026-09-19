'use client';

/*
 * THE ONE IN-APP MODAL for the portal (item 12, 2026-09-09, Brian's ruling): zero native
 * dialogs. Safari's "Suppress dialogs" makes window.confirm return false silently, and a client
 * action that asked first would die without a word. Labels are EN/ES; the caller passes the
 * language it already holds.
 *
 * THE ERROR STAYS WITH THE FIELD (Brian, 2026-09-19, defect 2): with `run`, the modal does the
 * work; a refusal renders verbatim under the field, the text stays, the modal stays open.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export type AskLang = 'en' | 'es';

export interface AskChoice {
  key: string;
  label: string;
  tone?: 'primary' | 'danger' | 'ghost';
}

export interface AskOptions {
  lang: AskLang;
  title: string;
  body?: ReactNode;
  reason?: { label: string; required: boolean; placeholder?: string };
  choices?: AskChoice[];
  cancelLabel?: string;
  /** The work the choice does; a throw renders under the field and the modal stays open. */
  run?: (r: AskResult) => Promise<void>;
}

export interface AskResult {
  choice: string;
  reason: string;
}

type AskFn = (opts: AskOptions) => Promise<AskResult | null>;
const AskContext = createContext<AskFn | null>(null);

const WORDS: Record<AskLang, { confirm: string; cancel: string; required: string; optional: string; working: string; refused: string }> = {
  en: { confirm: 'Confirm', cancel: 'Cancel', required: '(required)', optional: '(optional)', working: 'Working…', refused: 'The request was refused.' },
  es: { confirm: 'Confirmar', cancel: 'Cancelar', required: '(obligatorio)', optional: '(opcional)', working: 'Procesando…', refused: 'La solicitud fue rechazada.' },
};

interface Pending { opts: AskOptions; resolve: (r: AskResult | null) => void }

export function AskProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);

  const ask = useCallback<AskFn>((opts) => new Promise<AskResult | null>((resolve) => {
    setReason('');
    setError('');
    setWorking(false);
    setPending({ opts, resolve });
  }), []);

  const finish = useCallback((r: AskResult | null) => {
    setPending((p) => { p?.resolve(r); return null; });
  }, []);

  const words = WORDS[pending?.opts.lang ?? 'en'];

  const choose = useCallback(async (key: string) => {
    if (!pending) return;
    const r: AskResult = { choice: key, reason: reason.trim() };
    if (!pending.opts.run) { finish(r); return; }
    setWorking(true);
    setError('');
    try {
      await pending.opts.run(r);
      finish(r);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : words.refused);
      reasonRef.current?.focus();
    } finally {
      setWorking(false);
    }
  }, [pending, reason, finish, words.refused]);

  useEffect(() => {
    if (!pending) return;
    if (pending.opts.reason) reasonRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !working) finish(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, finish, working]);

  const choices: AskChoice[] = pending?.opts.choices ?? [{ key: 'confirm', label: words.confirm, tone: 'primary' }];
  const needsReason = Boolean(pending?.opts.reason?.required) && reason.trim().length === 0;

  return (
    <AskContext.Provider value={ask}>
      {children}
      {pending ? (
        <div className="ask-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !working) finish(null); }}>
          <div className="ask-modal" role="dialog" aria-modal="true" aria-labelledby="ask-title">
            <h2 id="ask-title">{pending.opts.title}</h2>
            {pending.opts.body ? <div className="ask-body">{pending.opts.body}</div> : null}
            {pending.opts.reason ? (
              <label className="ask-reason">
                {pending.opts.reason.label} <span className="muted small">{pending.opts.reason.required ? words.required : words.optional}</span>
                <textarea ref={reasonRef} rows={3} value={reason} placeholder={pending.opts.reason.placeholder ?? ''} aria-invalid={error ? true : undefined} aria-describedby={error ? 'ask-error' : undefined} onChange={(e) => setReason(e.target.value)} />
              </label>
            ) : null}
            {error ? <p id="ask-error" className="field-error" role="alert">{error}</p> : null}
            <footer className="ask-actions">
              <button type="button" className="btn ghost" disabled={working} onClick={() => finish(null)}>{pending.opts.cancelLabel ?? words.cancel}</button>
              {choices.map((c) => (
                <button key={c.key} type="button" className={c.tone === 'danger' ? 'btn danger' : c.tone === 'ghost' ? 'btn ghost' : 'btn accent'} disabled={needsReason || working} onClick={() => void choose(c.key)}>
                  {working ? words.working : c.label}
                </button>
              ))}
            </footer>
          </div>
        </div>
      ) : null}
    </AskContext.Provider>
  );
}

export function useAsk(): AskFn {
  const ask = useContext(AskContext);
  if (!ask) throw new Error('useAsk() needs <AskProvider> above it (apps/portal/app/layout.tsx).');
  return ask;
}
