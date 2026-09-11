'use client';

/*
 * THE ONE IN-APP MODAL (item 12, 2026-09-09, Brian's ruling): zero native dialogs in Ops.
 *
 * Safari offers "Suppress dialogs" after a page shows a few; from then on every
 * window.prompt/confirm returns null/false instantly and silently — and every money action
 * that asked first (void, withdraw, hold, transfer/refund) dies without a word. So nothing in
 * Ops asks the browser. It asks this: a modal with a title, a body, an optional reason field
 * (required or not), and the action buttons — resolved as a promise so a handler reads
 *
 *   const a = await ask({ title, reason: { label, required: true }, choices: [...] });
 *   if (!a) return;            // cancelled
 *   a.choice, a.reason         // what the person decided, and why
 *
 * One component, one provider at the root, one guard (check:no-native-dialogs) that fails the
 * build on any new window.prompt / confirm / alert.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ModalShell } from './modal-shell';

export interface AskChoice {
  key: string;
  label: string;
  tone?: 'primary' | 'danger' | 'ghost';
}

export interface AskOptions {
  title: string;
  body?: ReactNode;
  /** When present the modal shows a reason field; `required` blocks the primary choices until it is filled. */
  reason?: { label: string; required: boolean; placeholder?: string; initial?: string };
  /** Action buttons besides Cancel. Default: one "Confirm". */
  choices?: AskChoice[];
  cancelLabel?: string;
}

export interface AskResult {
  choice: string;
  reason: string;
}

type AskFn = (opts: AskOptions) => Promise<AskResult | null>;

const AskContext = createContext<AskFn | null>(null);

interface Pending {
  opts: AskOptions;
  resolve: (r: AskResult | null) => void;
}

export function AskProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState('');
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);

  const ask = useCallback<AskFn>((opts) => {
    return new Promise<AskResult | null>((resolve) => {
      setReason(opts.reason?.initial ?? '');
      setPending({ opts, resolve });
    });
  }, []);

  const finish = useCallback((r: AskResult | null) => {
    setPending((p) => {
      p?.resolve(r);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!pending) return;
    if (pending.opts.reason) reasonRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, finish]);

  const choices = useMemo<AskChoice[]>(
    () => pending?.opts.choices ?? [{ key: 'confirm', label: 'Confirm', tone: 'primary' }],
    [pending]
  );
  const needsReason = Boolean(pending?.opts.reason?.required) && reason.trim().length === 0;

  return (
    <AskContext.Provider value={ask}>
      {children}
      {pending ? (
        <ModalShell
          id="ask"
          title={pending.opts.title}
          panelClass="ask-modal"
          backdropClass="ask-overlay"
          onClose={() => finish(null)}
          footer={
            <>
              <button type="button" className="btn ghost" onClick={() => finish(null)}>
                {pending.opts.cancelLabel ?? 'Cancel'}
              </button>
              {choices.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className={c.tone === 'danger' ? 'btn danger' : c.tone === 'ghost' ? 'btn ghost' : 'btn accent'}
                  disabled={needsReason}
                  onClick={() => finish({ choice: c.key, reason: reason.trim() })}
                >
                  {c.label}
                </button>
              ))}
            </>
          }
        >
          {pending.opts.body ? <div className="ask-body">{pending.opts.body}</div> : null}
          {pending.opts.reason ? (
            <label className="ask-reason">
              {pending.opts.reason.label}
              {pending.opts.reason.required ? <span className="muted small"> (required)</span> : <span className="muted small"> (optional)</span>}
              <textarea
                ref={reasonRef}
                rows={3}
                value={reason}
                placeholder={pending.opts.reason.placeholder ?? ''}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          ) : null}
        </ModalShell>
      ) : null}
    </AskContext.Provider>
  );
}

/** The modal, as a function a handler awaits. Throws outside the provider — that is a wiring bug, not a runtime state. */
export function useAsk(): AskFn {
  const ask = useContext(AskContext);
  if (!ask) throw new Error('useAsk() needs <AskProvider> above it (apps/internal/app/layout.tsx).');
  return ask;
}
