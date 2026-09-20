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
 * THE ERROR STAYS WITH THE FIELD (Brian, 2026-09-19, defect 2). A refusal used to reach the
 * page top as "request failed" after the modal had closed, with the reason the person typed
 * gone. With `run`, the modal does the work itself: the server's refusal renders verbatim under
 * the field that caused it, the text stays, the person edits and tries again. The promise
 * resolves only when the work succeeded (or the person cancelled).
 *
 *   const a = await ask({ ..., run: async (r) => { await api('/x', { body: { reason: r.reason } }); } });
 *   if (!a) return;            // cancelled; a refusal never gets here
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
  /**
   * AN AMOUNT, IN DOLLARS (R29, 2026-09-20). The refund door needs a number as well as a reason,
   * and a number typed into a native prompt is the dialog Ops does not use. `initial` is what the
   * field opens with — for a refund, the refundable balance, so the common case is one tap. The
   * bounds are the SERVER's: this field never decides what is allowed, it only carries what was
   * typed, and a refusal lands under it in the server's words like any other.
   */
  amount?: { label: string; initial: string; hint?: ReactNode; testId?: string };
  /** When present the modal shows a reason field; `required` blocks the primary choices until it is filled. */
  reason?: { label: string; required: boolean; placeholder?: string; initial?: string };
  /** Action buttons besides Cancel. Default: one "Confirm". */
  choices?: AskChoice[];
  cancelLabel?: string;
  /**
   * The work the choice does. A throw renders its message verbatim under the field, keeps the
   * text, and leaves the modal open; the promise resolves only after this returns.
   */
  run?: (r: AskResult) => Promise<void>;
}

export interface AskResult {
  choice: string;
  reason: string;
  /** What was typed in the amount field, as typed (dollars). Empty when the modal had no amount. */
  amount: string;
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
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);
  const amountRef = useRef<HTMLInputElement | null>(null);

  const ask = useCallback<AskFn>((opts) => {
    return new Promise<AskResult | null>((resolve) => {
      setReason(opts.reason?.initial ?? '');
      setAmount(opts.amount?.initial ?? '');
      setError('');
      setWorking(false);
      setPending({ opts, resolve });
    });
  }, []);

  const finish = useCallback((r: AskResult | null) => {
    setPending((p) => {
      p?.resolve(r);
      return null;
    });
  }, []);

  const choose = useCallback(
    async (key: string) => {
      if (!pending) return;
      const r: AskResult = { choice: key, reason: reason.trim(), amount: amount.trim() };
      if (!pending.opts.run) { finish(r); return; }
      setWorking(true);
      setError('');
      try {
        await pending.opts.run(r);
        finish(r);
      } catch (err) {
        // The server's words, beside the field, with the text kept. Nothing reaches the page top.
        setError(err instanceof Error && err.message ? err.message : 'The request was refused.');
        (pending.opts.amount ? amountRef.current : reasonRef.current)?.focus();
      } finally {
        setWorking(false);
      }
    },
    [pending, reason, amount, finish]
  );

  useEffect(() => {
    if (!pending) return;
    if (pending.opts.amount) amountRef.current?.select();
    else if (pending.opts.reason) reasonRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !working) finish(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, finish, working]);

  const choices = useMemo<AskChoice[]>(
    () => pending?.opts.choices ?? [{ key: 'confirm', label: 'Confirm', tone: 'primary' }],
    [pending]
  );
  const needsReason = Boolean(pending?.opts.reason?.required) && reason.trim().length === 0;
  // An amount field is always required: a modal that asks for one has nothing to do without it.
  const needsAmount = Boolean(pending?.opts.amount) && amount.trim().length === 0;

  return (
    <AskContext.Provider value={ask}>
      {children}
      {pending ? (
        <ModalShell
          id="ask"
          title={pending.opts.title}
          panelClass="ask-modal"
          backdropClass="ask-overlay"
          dismissable={!working}
          onClose={() => finish(null)}
          footer={
            <>
              <button type="button" className="btn ghost" disabled={working} onClick={() => finish(null)}>
                {pending.opts.cancelLabel ?? 'Cancel'}
              </button>
              {choices.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className={c.tone === 'danger' ? 'btn danger' : c.tone === 'ghost' ? 'btn ghost' : 'btn accent'}
                  disabled={needsReason || needsAmount || working}
                  onClick={() => void choose(c.key)}
                >
                  {working ? 'Working…' : c.label}
                </button>
              ))}
            </>
          }
        >
          {pending.opts.body ? <div className="ask-body">{pending.opts.body}</div> : null}
          {pending.opts.amount ? (
            <label className="ask-reason">
              {pending.opts.amount.label}
              <input
                ref={amountRef}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                {...(pending.opts.amount.testId ? { 'data-testid': pending.opts.amount.testId } : {})}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'ask-error' : undefined}
                onChange={(e) => setAmount(e.target.value)}
              />
              {pending.opts.amount.hint ? <span className="muted small">{pending.opts.amount.hint}</span> : null}
            </label>
          ) : null}
          {pending.opts.reason ? (
            <label className="ask-reason">
              {pending.opts.reason.label}
              {pending.opts.reason.required ? <span className="muted small"> (required)</span> : <span className="muted small"> (optional)</span>}
              <textarea
                ref={reasonRef}
                rows={3}
                value={reason}
                placeholder={pending.opts.reason.placeholder ?? ''}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'ask-error' : undefined}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          ) : null}
          {error ? <p id="ask-error" className="field-error" role="alert">{error}</p> : null}
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
