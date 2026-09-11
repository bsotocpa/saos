'use client';

/*
 * THE ONE MODAL SHELL (2026-09-10, Brian's ruling after the phone walk).
 *
 * Three places drew their own: the ask dialog (4b8707e), the task form, and the quote-sent
 * confirmation on the pipeline page — that last one with its backdrop written inline, which is
 * how a modal ends up on screen with no backdrop at all and the page reading through it.
 *
 * Everything a modal has to get right lives here and nowhere else:
 *
 *   an opaque surface      so the page underneath is not legible through the panel
 *   a backdrop             covering the whole viewport, dimming and catching stray taps
 *   a scroll lock          so the page behind does not move under a thumb that missed
 *   escape and click-out   one way in, two ways out
 *   inert background       nothing behind the backdrop can be tabbed to or clicked
 *
 * The scroll lock restores the exact previous overflow rather than clearing it, because two
 * modals can overlap (a confirmation raised from inside a form) and the inner one closing must
 * not unlock the page the outer one is still covering. A depth counter on the body handles it.
 */

import { useEffect, useRef, type ReactNode } from 'react';

let lockDepth = 0;

function lockScroll(): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const body = document.body;
  if (lockDepth === 0) {
    body.dataset['prevOverflow'] = body.style.overflow;
    body.style.overflow = 'hidden';
  }
  lockDepth += 1;
  return () => {
    lockDepth = Math.max(0, lockDepth - 1);
    if (lockDepth === 0) {
      body.style.overflow = body.dataset['prevOverflow'] ?? '';
      delete body.dataset['prevOverflow'];
    }
  };
}

export interface ModalShellProps {
  /** Accessible name. Rendered as the heading unless `heading` is given. */
  title: string;
  children: ReactNode;
  /** Called for escape, a click on the backdrop, and any explicit close control. */
  onClose: () => void;
  /** Extra class on the panel, e.g. 'ask-modal'. */
  panelClass?: string;
  /** Extra class on the backdrop, e.g. 'ask-overlay'. */
  backdropClass?: string;
  /** Escape and backdrop clicks are ignored when false. Default true. */
  dismissable?: boolean;
  /** Replaces the default <h2>{title}</h2> when the header needs more than a title. */
  heading?: ReactNode;
  /** Footer row, usually the buttons. */
  footer?: ReactNode;
  id?: string;
}

export function ModalShell(props: ModalShellProps): React.JSX.Element {
  const { onClose, dismissable = true } = props;
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = `${props.id ?? 'modal'}-title`;

  useEffect(() => lockScroll(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissable) { e.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose, dismissable]);

  // Focus moves into the panel, so the first Tab does not land behind the backdrop.
  useEffect(() => {
    const first = panelRef.current?.querySelector<HTMLElement>(
      'textarea, input, select, button, [href], [tabindex]:not([tabindex="-1"])'
    );
    first?.focus();
  }, []);

  return (
    <div
      className={`overlay${props.backdropClass ? ` ${props.backdropClass}` : ''}`}
      role="presentation"
      onMouseDown={(e) => { if (dismissable && e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        className={`modal${props.panelClass ? ` ${props.panelClass}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {props.heading ?? <h2 id={titleId}>{props.title}</h2>}
        {props.heading ? <span id={titleId} hidden>{props.title}</span> : null}
        {props.children}
        {props.footer ? <footer>{props.footer}</footer> : null}
      </div>
    </div>
  );
}
