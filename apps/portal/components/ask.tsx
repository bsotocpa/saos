'use client';

/*
 * THE ONE IN-APP MODAL for the portal (item 12, 2026-09-09, Brian's ruling): zero native
 * dialogs. Safari's "Suppress dialogs" makes window.confirm return false silently, and a client
 * action that asked first would die without a word. Labels are EN/ES; the caller passes the
 * language it already holds.
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
}

export interface AskResult {
  choice: string;
  reason: string;
}

type AskFn = (opts: AskOptions) => Promise<AskResult | null>;
const AskContext = createContext<AskFn | null>(null);

const WORDS: Record<AskLang, { confirm: string; cancel: string; required: string; optional: string }> = {
  en: { confirm: 'Confirm', cancel: 'Cancel', required: '(required)', optional: '(optional)' },
  es: { confirm: 'Confirmar', cancel: 'Cancelar', required: '(obligatorio)', optional: '(opcional)' },
};

interface Pending { opts: AskOptions; resolve: (r: AskResult | null) => void }

export function AskProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState('');
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);

  const ask = useCallback<AskFn>((opts) => new Promise<AskResult | null>((resolve) => {
    setReason('');
    setPending({ opts, resolve });
  }), []);

  const finish = useCallback((r: AskResult | null) => {
    setPending((p) => { p?.resolve(r); return null; });
  }, []);

  useEffect(() => {
    if (!pending) return;
    if (pending.opts.reason) reasonRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, finish]);

  const words = WORDS[pending?.opts.lang ?? 'en'];
  const choices: AskChoice[] = pending?.opts.choices ?? [{ key: 'confirm', label: words.confirm, tone: 'primary' }];
  const needsReason = Boolean(pending?.opts.reason?.required) && reason.trim().length === 0;

  return (
    <AskContext.Provider value={ask}>
      {children}
      {pending ? (
        <div className="ask-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) finish(null); }}>
          <div className="ask-modal" role="dialog" aria-modal="true" aria-labelledby="ask-title">
            <h2 id="ask-title">{pending.opts.title}</h2>
            {pending.opts.body ? <div className="ask-body">{pending.opts.body}</div> : null}
            {pending.opts.reason ? (
              <label className="ask-reason">
                {pending.opts.reason.label} <span className="muted small">{pending.opts.reason.required ? words.required : words.optional}</span>
                <textarea ref={reasonRef} rows={3} value={reason} placeholder={pending.opts.reason.placeholder ?? ''} onChange={(e) => setReason(e.target.value)} />
              </label>
            ) : null}
            <footer className="ask-actions">
              <button type="button" className="btn ghost" onClick={() => finish(null)}>{pending.opts.cancelLabel ?? words.cancel}</button>
              {choices.map((c) => (
                <button key={c.key} type="button" className={c.tone === 'danger' ? 'btn danger' : c.tone === 'ghost' ? 'btn ghost' : 'btn accent'} disabled={needsReason} onClick={() => finish({ choice: c.key, reason: reason.trim() })}>
                  {c.label}
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
